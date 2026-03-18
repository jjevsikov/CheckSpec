/**
 * checkspec init
 *
 * Scaffolds a starter .checkspec.json collection from a live MCP server —
 * no API key, no AI, no cost. Connects to the server, discovers its
 * tools/resources/prompts, and writes one test per capability.
 *
 * This is the "npm init" of CheckSpec: instant, mechanical, free.
 * For AI-authored semantically rich tests, use `checkspec generate`.
 *
 * ## Example usage
 *
 *   checkspec init "node dist/index.js"
 *   checkspec init "node dist/server.js" --out my-tests.checkspec.json
 *   checkspec init "uv run server.py" --cwd ./my-project --name "My Server"
 */

import { Command } from "commander";
import { writeFileSync, existsSync } from "fs";
import { basename, extname } from "path";
import chalk from "chalk";
import { MCPRecordingClient, SchemaInputGenerator } from "@checkspec/core";
import type { CheckSpecCollection, TestCase, ResourceTemplate } from "@checkspec/core";
import {
  buildTransport,
  buildTransportFromConfig,
  parseServerCommand,
  parseEnvPairs,
  isConnectionError,
  dieWithConnectionError,
} from "../transport.js";
import { probePromptArgs } from "../promptArgs.js";

/** $schema URL pointing to the published JSON Schema for editor autocomplete. */
const SCHEMA_URL =
  "https://raw.githubusercontent.com/jjevsikov/CheckSpec/main/packages/core/checkspec.schema.json";

export function createInitCommand(): Command {
  return new Command("init")
    .description(
      "Scaffold a starter .checkspec.json from a live MCP server (no API key needed)"
    )
    .argument(
      "[server-command]",
      "Command to start the MCP server (e.g. 'node dist/index.js'). Omit when using --url."
    )
    .option(
      "-o, --out <file>",
      "Output path for the generated collection (default: derived from server command or URL)"
    )
    .option(
      "-n, --name <name>",
      "Collection name (default: derived from server command or URL)"
    )
    .option(
      "--url <url>",
      "URL of a running HTTP-based MCP server (alternative to a server command)"
    )
    .option(
      "--transport <type>",
      "Transport protocol: streamable-http (default) or sse",
      "streamable-http"
    )
    .option(
      "--header <KEY=VALUE>",
      "Add an HTTP header to every request, e.g. 'Authorization=Bearer tok' (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      "--cwd <dir>",
      "Working directory for the server process (useful for Python uv projects)"
    )
    .option(
      "--env <KEY=VALUE>",
      "Set an environment variable for the server process (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      "--force",
      "Overwrite the output file if it already exists",
      false
    )
    .option(
      "--verbose",
      "Show server stderr output (useful for debugging)",
      false
    )
    .action(
      async (
        serverCommandArg: string | undefined,
        options: {
          out?: string;
          name?: string;
          url?: string;
          transport?: string;
          header: string[];
          cwd?: string;
          env: string[];
          force: boolean;
          verbose: boolean;
        }
      ) => {
        // Require either a server command or a URL
        if (!serverCommandArg && !options.url) {
          console.error("Error: provide either a server command or --url <url>");
          process.exit(1);
        }

        // The display label used for collection name derivation and output path
        const serverCommand = options.url ?? serverCommandArg!;

        let envVars: Record<string, string> | undefined;
        try {
          envVars = options.env.length > 0 ? parseEnvPairs(options.env) : undefined;
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        }

        let headers: Record<string, string> | undefined;
        try {
          headers = options.header.length > 0 ? parseEnvPairs(options.header) : undefined;
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        }

        // ── Derive output path ────────────────────────────────────────────
        const outFile = options.out ?? deriveOutputPath(serverCommand);

        if (!options.force && existsSync(outFile)) {
          console.error(
            chalk.red(`\nError: ${outFile} already exists.`) +
            `\nRun with ${chalk.bold("--force")} to overwrite it, or use ${chalk.bold("--out <file>")} to choose a different path.`
          );
          process.exit(1);
        }

        // ── Connect ───────────────────────────────────────────────────────
        let transport;
        if (options.url) {
          transport = buildTransportFromConfig({
            url: options.url,
            transport: options.transport as "streamable-http" | "sse" | undefined,
            headers,
          });
        } else {
          transport = buildTransport(serverCommandArg!, {
            cwd: options.cwd,
            env: envVars,
            verbose: options.verbose,
          });
        }
        const client = new MCPRecordingClient(transport);

        try {
          try {
            await client.connect();
          } catch (err) {
            if (isConnectionError(err))
              dieWithConnectionError(serverCommand, options.verbose);
            throw err;
          }

          // ── Discover capabilities ─────────────────────────────────────
          const tools = await client.listTools();
          let resources: Awaited<ReturnType<typeof client.listResources>> = [];
          let resourceTemplates: ResourceTemplate[] = [];
          let prompts: Awaited<ReturnType<typeof client.listPrompts>> = [];
          try { resources = await client.listResources(); } catch { /* unsupported */ }
          try { resourceTemplates = await client.listResourceTemplates(); } catch { /* unsupported */ }
          try { prompts = await client.listPrompts(); } catch { /* unsupported */ }

          // ── Build tests ───────────────────────────────────────────────
          const generator = new SchemaInputGenerator();
          const tests: TestCase[] = [];

          // Always include a protocol conformance check
          tests.push({
            id: "protocol",
            name: "Protocol: basic capability check",
            type: "protocol",
            tags: ["protocol"],
          });

          // One tool-call test per tool with a schema-valid input.
          // Skip `expect: { success: true }` for tools whose input has a field
          // that looks like a foreign-key ID (e.g. userId, task_id). Those
          // tools require an entity that doesn't exist yet, so the generated
          // input will always fail — adding a success assertion just produces
          // a broken test the user must delete immediately.
          for (const tool of tools) {
            const validInputs = generator.generate(tool.inputSchema, { mode: "valid", count: 1 });
            const hasIdRef = hasIdReferenceField(
              tool.inputSchema as { properties?: Record<string, unknown> }
            );
            tests.push({
              id: `tool-${tool.name}`,
              name: `${tool.name} › runs without error`,
              type: "tool-call",
              tool: tool.name,
              input: validInputs[0] ?? {},
              ...(hasIdRef ? {} : { expect: { success: true } }),
              tags: ["tool", tool.name],
            });
          }

          // One resource-read test per resource
          for (const resource of resources) {
            tests.push({
              id: `resource-${resource.name}`,
              name: `${resource.name} › readable`,
              type: "resource-read",
              uri: resource.uri,
              tags: ["resource", resource.name],
            });
          }

          // One resource-read test per resource template (placeholder URI)
          for (const tmpl of resourceTemplates) {
            const exampleUri = tmpl.uriTemplate.replace(
              /\{([^}]+)\}/g,
              (_: string, param: string) => `example-${param}`
            );
            tests.push({
              id: `resource-template-${tmpl.name}`,
              name: `${tmpl.name} › readable (template — edit URI)`,
              type: "resource-read",
              uri: exampleUri,
              tags: ["resource", "template", tmpl.name],
            });
          }

          // One prompt-get test per prompt — probe to discover valid arg values
          // (including enum constraints not exposed in MCP prompt metadata).
          for (const prompt of prompts) {
            const promptArgs = await probePromptArgs(
              client,
              prompt.name,
              prompt.arguments ?? []
            );
            tests.push({
              id: `prompt-${prompt.name}`,
              name: `${prompt.name} › get`,
              type: "prompt-get",
              promptName: prompt.name,
              ...(Object.keys(promptArgs).length > 0 ? { promptArgs } : {}),
              tags: ["prompt", prompt.name],
            });
          }

          // ── Build collection ──────────────────────────────────────────
          const collectionName =
            options.name ?? deriveCollectionName(serverCommand);

          const totalCapabilities =
            tools.length + resources.length + resourceTemplates.length + prompts.length;

          const serverBlock: CheckSpecCollection["server"] = options.url
            ? {
                url: options.url,
                ...(options.transport && options.transport !== "streamable-http"
                  ? { transport: options.transport as "sse" }
                  : {}),
                ...(headers ? { headers } : {}),
              }
            : (() => {
                const [parsedCommand, parsedArgs] = parseServerCommand(serverCommandArg!);
                return {
                  command: parsedCommand,
                  args: parsedArgs,
                  ...(options.cwd ? { cwd: options.cwd } : {}),
                };
              })();

          const collection: CheckSpecCollection = {
            version: "1.0",
            name: collectionName,
            description:
              `Scaffolded by checkspec init. ` +
              `${tools.length} tool(s), ${resources.length + resourceTemplates.length} resource(s), ${prompts.length} prompt(s). ` +
              `Customize the assertions to match your server's expected behaviour.`,
            server: serverBlock,
            tests,
          };

          // ── Write file ────────────────────────────────────────────────
          // Prepend $schema so editors (VS Code, JetBrains) can auto-complete
          // and validate the file inline without any configuration.
          const output = { $schema: SCHEMA_URL, ...collection };
          writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n");

          // ── Summary ───────────────────────────────────────────────────
          console.log(
            "\n" + chalk.green("✓") + " " +
            chalk.bold(`Created ${outFile}`) +
            chalk.gray(` with ${tests.length} test${tests.length === 1 ? "" : "s"}`)
          );

          if (totalCapabilities > 0) {
            const parts: string[] = [];
            if (tools.length) parts.push(`${tools.length} tool${tools.length === 1 ? "" : "s"}`);
            if (resources.length) parts.push(`${resources.length} resource${resources.length === 1 ? "" : "s"}`);
            if (resourceTemplates.length) parts.push(`${resourceTemplates.length} resource template${resourceTemplates.length === 1 ? "" : "s"}`);
            if (prompts.length) parts.push(`${prompts.length} prompt${prompts.length === 1 ? "" : "s"}`);
            console.log(chalk.gray(`  Discovered: ${parts.join(", ")}`));
          }

          console.log(
            `\n  ${chalk.bold("Next step:")} ` +
            chalk.cyan(`checkspec test ${outFile}`)
          );
          console.log(
            chalk.gray(
              `  Edit the file to add meaningful assertions (e.g. "contains", "schema").\n` +
              `  For AI-generated assertions, run: checkspec generate "${serverCommand}"\n`
            )
          );

          process.exitCode = 0;
        } finally {
          await client.disconnect();
        }
      }
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive an output filename from the server command.
 *
 * Strategy: take the last whitespace-separated token (the script path),
 * strip the directory and extension, and append `.checkspec.json`.
 *
 * Examples:
 *   "node dist/index.js"            → "index.checkspec.json"
 *   "uv run server.py"              → "server.checkspec.json"
 *   "python -m mypackage.server"    → "mypackage.server.checkspec.json"
 */
export function deriveOutputPath(serverCommand: string): string {
  const tokens = serverCommand.trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  const base = basename(last, extname(last));
  return `${base}.checkspec.json`;
}

/**
 * Derive a human-readable collection name from the server command.
 *
 * Examples:
 *   "node dist/index.js"  → "index"
 *   "uv run server.py"    → "server"
 */
export function deriveCollectionName(serverCommand: string): string {
  const tokens = serverCommand.trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  return basename(last, extname(last));
}

/**
 * Returns true when the tool's inputSchema contains a property whose name
 * suggests it is a foreign-key reference (e.g. `userId`, `task_id`, `id`).
 *
 * Tools with ID-reference fields typically require an entity that was
 * created by a prior call, so auto-generated inputs will always produce
 * "not found" errors — adding `expect: { success: true }` just creates a
 * broken test the user must delete immediately.
 *
 * Heuristic:
 *   - Exact match: `id`
 *   - camelCase suffix: ends with `Id`  (e.g. `userId`, `taskId`)
 *   - snake_case suffix: ends with `_id` (e.g. `user_id`, `task_id`)
 */
export function hasIdReferenceField(inputSchema: {
  properties?: Record<string, unknown>;
}): boolean {
  if (!inputSchema.properties) return false;
  return Object.keys(inputSchema.properties).some(
    (key) => key === "id" || key.endsWith("Id") || key.endsWith("_id")
  );
}
