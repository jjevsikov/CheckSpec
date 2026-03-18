/**
 * checkspec generate
 *
 * Uses Claude AI to generate a semantically meaningful .checkspec.json collection
 * from a live MCP server's tool/resource/prompt definitions.
 *
 * Unlike `checkspec scan` (schema-driven fuzzing), `generate` produces test cases
 * that reflect real usage patterns — realistic inputs, meaningful assertions,
 * and domain-appropriate edge cases — by leveraging Claude's understanding of
 * the tool's purpose from its description and schema.
 *
 * ## Example usage
 *
 *   checkspec generate "node dist/index.js" --out notes.checkspec.json
 *   checkspec generate "uv run server.py" --cwd ./my-project --out tests.checkspec.json
 *   checkspec generate "node dist/index.js" --model claude-sonnet-4-6 --max-tests 8
 */

import { Command } from "commander";
import { writeFileSync } from "fs";
import chalk from "chalk";
import { MCPRecordingClient, AITestGenerator } from "@checkspec/core";
import type { AIGenerateOptions } from "@checkspec/core";
import {
  buildTransport,
  parseEnvPairs,
  isConnectionError,
  dieWithConnectionError,
} from "../transport.js";

/** $schema URL pointing to the published JSON Schema for editor autocomplete. */
const SCHEMA_URL =
  "https://raw.githubusercontent.com/jjevsikov/CheckSpec/main/packages/core/checkspec.schema.json";

export function createGenerateCommand(): Command {
  return new Command("generate")
    .description(
      "Use Claude AI to generate a .checkspec.json collection from a live MCP server"
    )
    .argument(
      "<server-command>",
      "Command to start the MCP server (e.g. 'node dist/index.js')"
    )
    .option(
      "-o, --out <file>",
      "Output path for the generated .checkspec.json collection",
      "generated.checkspec.json"
    )
    .option(
      "-k, --api-key <key>",
      "Anthropic API key (defaults to ANTHROPIC_API_KEY env var)"
    )
    .option(
      "-m, --model <model>",
      "Claude model ID to use for generation",
      "claude-haiku-4-5-20251001"
    )
    .option(
      "--max-tests <n>",
      "Maximum test cases to generate per tool",
      "5"
    )
    .option(
      "--no-security",
      "Skip generating security-scan test cases"
    )
    .option(
      "--name <name>",
      "Human-readable name for the server (used in the collection header)"
    )
    .option(
      "--cwd <dir>",
      "Working directory for the server process (required for Python uv/venv projects)"
    )
    .option(
      "--env <KEY=VALUE>",
      "Set an environment variable for the server process (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      "--verbose",
      "Show server stderr output",
      false
    )
    .action(async (serverCommand: string, options: {
      out: string;
      apiKey?: string;
      model: string;
      maxTests: string;
      security: boolean;
      name?: string;
      cwd?: string;
      env: string[];
      verbose: boolean;
    }) => {
      // ── Validate API key early ─────────────────────────────────────────────
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error(chalk.red("\nError: Anthropic API key required."));
        console.error(
          "Set the ANTHROPIC_API_KEY environment variable or pass --api-key <key>."
        );
        process.exit(1);
      }

      let envVars: Record<string, string> | undefined;
      try {
        envVars = options.env.length > 0 ? parseEnvPairs(options.env) : undefined;
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      // ── 1. Connect to server ───────────────────────────────────────────────
      console.log("\n" + chalk.bold("CheckSpec generate") + "  " + chalk.gray(serverCommand));
      console.log(chalk.gray("═".repeat(50)));

      const transport = buildTransport(serverCommand, {
        cwd: options.cwd,
        env: envVars,
        verbose: options.verbose,
      });
      const client = new MCPRecordingClient(transport);

      try {
        try {
          await client.connect();
        } catch (err) {
          if (isConnectionError(err)) dieWithConnectionError(serverCommand, options.verbose);
          throw err;
        }

        console.log(chalk.gray("Connected. Discovering capabilities…"));

        // ── 2. Discover capabilities ───────────────────────────────────────────
        const tools = await client.listTools();
        let resources: Awaited<ReturnType<typeof client.listResources>> = [];
        let prompts: Awaited<ReturnType<typeof client.listPrompts>> = [];
        try { resources = await client.listResources(); } catch { /* unsupported */ }
        try { prompts = await client.listPrompts(); } catch { /* unsupported */ }

        console.log(
          `  Tools: ${chalk.cyan(String(tools.length))}` +
          (tools.length ? chalk.gray("  (" + tools.map((t) => t.name).join(", ") + ")") : "")
        );
        console.log(
          `  Resources: ${chalk.cyan(String(resources.length))}` +
          (resources.length ? chalk.gray("  (" + resources.map((r) => r.name).join(", ") + ")") : "")
        );
        console.log(
          `  Prompts: ${chalk.cyan(String(prompts.length))}` +
          (prompts.length ? chalk.gray("  (" + prompts.map((p) => p.name).join(", ") + ")") : "")
        );

        if (tools.length === 0 && resources.length === 0 && prompts.length === 0) {
          console.error(chalk.yellow("\nNo capabilities found. Nothing to generate."));
          process.exit(0);
        }

        // ── 3. Call Claude ─────────────────────────────────────────────────────
        const maxTests = parseInt(options.maxTests, 10);
        const genOptions: AIGenerateOptions = {
          apiKey,
          model: options.model,
          maxTestsPerTool: Number.isFinite(maxTests) && maxTests > 0 ? maxTests : 5,
          includeSecurity: options.security,
        };

        console.log(
          `\n${chalk.bold("Generating tests")} with ${chalk.cyan(options.model)}…`
        );
        const spinner = startSpinner();

        const generator = new AITestGenerator(genOptions);
        let collection;
        try {
          collection = await generator.generate(tools, resources, prompts, {
            serverCommand,
            serverName: options.name,
            cwd: options.cwd,
          });
        } catch (err) {
          clearInterval(spinner);
          process.stdout.write("\r");
          throw err;
        }

        clearInterval(spinner);
        process.stdout.write("\r" + " ".repeat(50) + "\r");

        // ── 4. Write output ────────────────────────────────────────────────────
        const outPath = options.out;
        // Prepend $schema so editors can auto-complete and validate inline.
        const output = { $schema: SCHEMA_URL, ...collection };
        writeFileSync(outPath, JSON.stringify(output, null, 2));

        const testCount = collection.tests.length;
        const toolTests = collection.tests.filter((t) => t.type === "tool-call").length;
        const secTests = collection.tests.filter((t) => t.type === "security").length;
        const resourceTests = collection.tests.filter((t) => t.type === "resource-read").length;
        const promptTests = collection.tests.filter((t) => t.type === "prompt-get").length;

        console.log(chalk.green(`\n✓ Generated ${testCount} test cases`));
        console.log(
          chalk.gray(
            `  ${toolTests} tool · ${resourceTests} resource · ${promptTests} prompt · ${secTests} security`
          )
        );
        console.log(chalk.gray(`\nCollection saved to ${chalk.white(outPath)}`));
        console.log(
          chalk.gray(`\nRun it with:  `) +
          chalk.white(`checkspec test ${outPath}`)
        );
      } finally {
        await client.disconnect();
      }
    });
}

/** Simple terminal spinner (overwrites current line). Returns the interval ID. */
function startSpinner(): ReturnType<typeof setInterval> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  return setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(frames[i++ % frames.length])} Calling Claude API…`);
  }, 100);
}
