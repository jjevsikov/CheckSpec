import { Command } from "commander";
import { writeFileSync } from "fs";
import chalk from "chalk";
import {
  MCPRecordingClient,
  TestRunner,
  SchemaInputGenerator,
  SecurityScanner,
  ConsoleReporter,
  JUnitReporter,
  JSONReporter,
  HTMLReporter,
} from "@checkspec/core";
import type {
  CheckSpecCollection,
  TestCase,
  Reporter,
  SecurityFinding,
  TestResult,
  ResourceTemplate,
} from "@checkspec/core";
import {
  buildTransport,
  buildTransportFromConfig,
  parseServerCommand,
  parseEnvPairs,
  isConnectionError,
  dieWithConnectionError,
} from "../transport.js";
import { probePromptArgs } from "../promptArgs.js";

// ── Section label helpers ────────────────────────────────────────────────────
function printSection(label: string) {
  console.log(
    "\n" + chalk.bold(label) + " " + chalk.gray("─".repeat(Math.max(0, 44 - label.length)))
  );
}

function printHeader(serverCommand: string, connectMs: number) {
  console.log("\n" + chalk.bold("CheckSpec") + "  " + chalk.gray(serverCommand));
  console.log(chalk.gray("═".repeat(50)));
  console.log(chalk.gray(`Connected in ${connectMs}ms`));
}

function printCapabilities(
  tools: { name: string }[],
  resources: { name: string }[],
  resourceTemplates: { name: string }[],
  prompts: { name: string }[]
) {
  printSection("Capabilities");
  console.log(
    `  Tools:     ${chalk.cyan(String(tools.length))}` +
      (tools.length
        ? chalk.gray("  (" + tools.map((t) => t.name).join(", ") + ")")
        : "")
  );
  const resourceLabel =
    resources.length > 0 && resourceTemplates.length > 0
      ? `${resources.length} (+ ${resourceTemplates.length} template${resourceTemplates.length === 1 ? "" : "s"})`
      : resources.length > 0
      ? String(resources.length)
      : resourceTemplates.length > 0
      ? `0 (+ ${resourceTemplates.length} template${resourceTemplates.length === 1 ? "" : "s"})`
      : "0";
  const resourceNames = [
    ...resources.map((r) => r.name),
    ...resourceTemplates.map((t) => `${t.name} (template)`),
  ];
  console.log(
    `  Resources: ${chalk.cyan(resourceLabel)}` +
      (resourceNames.length
        ? chalk.gray("  (" + resourceNames.join(", ") + ")")
        : "")
  );
  console.log(
    `  Prompts:   ${chalk.cyan(String(prompts.length))}` +
      (prompts.length
        ? chalk.gray("  (" + prompts.map((p) => p.name).join(", ") + ")")
        : "")
  );
}

function printSecurityFindings(findings: SecurityFinding[]) {
  printSection("Security Scan");
  if (findings.length === 0) {
    console.log(chalk.green("  ✓ No security issues detected"));
    return;
  }
  for (const f of findings) {
    const color =
      f.severity === "critical" || f.severity === "high"
        ? chalk.red
        : f.severity === "medium"
        ? chalk.yellow
        : chalk.gray;
    console.log(
      color(
        `  [${f.severity.toUpperCase()}] ${f.type}` + (f.tool ? ` on "${f.tool}"` : "")
      ) +
        " — " +
        f.description
    );
    if (f.evidence) {
      console.log(chalk.gray(`    Evidence:    ${f.evidence}`));
    }
    console.log(chalk.cyan(`    Remediation: ${f.remediation}`));
  }
}

function printFuzzSummary(toolName: string, fuzzResults: TestResult[]) {
  const passed = fuzzResults.filter((r) => r.passed).length;
  const failed = fuzzResults.filter((r) => !r.passed).length;
  const total = fuzzResults.length;
  const line =
    chalk.bold(`  Fuzz "${toolName}" (${total} inputs):`) +
    "  " +
    chalk.green(`${passed} ok`) +
    (failed ? "  " + chalk.red(`${failed} failed`) : "");
  console.log(line);
}

export function createScanCommand(): Command {
  return new Command("scan")
    .description("Connect to an MCP server, auto-generate tests, and run them")
    .argument(
      "[server-command]",
      "Command to start the MCP server (e.g. 'node dist/index.js'). Omit when using --url."
    )
    .option("-o, --output <format>", "Output format: console, json, junit, html", "console")
    .option("-t, --timeout <ms>", "Per-test timeout in milliseconds", "5000")
    .option("--save <file>", "Save generated collection to a .checkspec.json file")
    .option("--report-html <file>", "Save an HTML report to this file (always generated alongside other output)")
    .option(
      "--save-recording [file]",
      "Save the full message recording to a JSON file (default: checkspec-recording.json)"
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
      "--fuzz",
      "Run full fuzz suite (all edge cases + invalid + random fuzz inputs per tool)"
    )
    .option(
      "--no-fuzz",
      "Skip all fuzz/edge-case tests — only the single valid-input test per tool runs (fastest scan)"
    )
    .option(
      "--verbose",
      "Show server stderr output (useful for debugging; hides Python log noise by default)",
      false
    )
    .action(
      async (
        serverCommandArg: string | undefined,
        options: {
          output: string;
          timeout: string;
          save?: string;
          saveRecording?: string | boolean;
          reportHtml?: string;
          url?: string;
          transport?: string;
          header: string[];
          cwd?: string;
          env: string[];
          // Commander's --fuzz/--no-fuzz pair: true=full, false=none, undefined=default(5 edge)
          fuzz?: boolean;
          verbose: boolean;
        }
      ) => {
        // Require either a server command or a URL
        if (!serverCommandArg && !options.url) {
          console.error("Error: provide either a server command or --url <url>");
          process.exit(1);
        }

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

        // serverCommand is the display label (for headers and collection save)
        const serverCommand = options.url ?? serverCommandArg!;

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
        const connectStart = Date.now();

        try {
          try {
            await client.connect();
          } catch (err) {
            if (isConnectionError(err))
              dieWithConnectionError(serverCommand, options.verbose);
            throw err;
          }
          const connectMs = Date.now() - connectStart;

          // ── 1. Discover capabilities ─────────────────────────────────
          const tools = await client.listTools();
          let resources: Awaited<ReturnType<typeof client.listResources>> = [];
          let resourceTemplates: ResourceTemplate[] = [];
          let prompts: Awaited<ReturnType<typeof client.listPrompts>> = [];
          try { resources = await client.listResources(); } catch { /* unsupported */ }
          try { resourceTemplates = await client.listResourceTemplates(); } catch { /* unsupported */ }
          try { prompts = await client.listPrompts(); } catch { /* unsupported */ }

          // ── 2. Generate tests ────────────────────────────────────────
          const generator = new SchemaInputGenerator();
          const tests: TestCase[] = [];

          // Protocol
          tests.push({
            id: "protocol-init",
            name: "Initialization handshake",
            type: "protocol",
            tags: ["protocol"],
          });

          // Tools
          for (const tool of tools) {
            const validInputs = generator.generate(tool.inputSchema, { mode: "valid", count: 1 });
            // No success assertion: auto-generated inputs are schema-valid but may be
            // semantically invalid (e.g. a random string for an `sql` field will fail SQL
            // parsing). The scan verifies the server responds without crashing; use a
            // hand-tuned collection (checkspec test) to assert on actual business logic.
            tests.push({
              id: `tool-${tool.name}-valid`,
              name: `${tool.name} › valid input`,
              type: "tool-call",
              tool: tool.name,
              input: validInputs[0] ?? {},
              tags: ["tool", tool.name],
            });

            // --no-fuzz: skip all edge/fuzz tests for the fastest possible scan
            if (options.fuzz === false) continue;

            const allEdge = generator.generateEdgeCases(tool.inputSchema);
            const edgeInputs = options.fuzz === true ? allEdge : allEdge.slice(0, 5);
            edgeInputs.forEach((input, i) => {
              tests.push({
                id: `tool-${tool.name}-edge-${i}`,
                name: `${tool.name} › edge: ${describeEdge(input)}`,
                type: "fuzz",
                tool: tool.name,
                input,
                tags: ["fuzz", "edge", tool.name],
              });
            });

            if (options.fuzz === true) {
              generator.generate(tool.inputSchema, { mode: "invalid", count: 3 })
                .forEach((input, i) => {
                  tests.push({
                    id: `tool-${tool.name}-invalid-${i}`,
                    name: `${tool.name} › invalid input ${i + 1}`,
                    type: "fuzz",
                    tool: tool.name,
                    input,
                    tags: ["fuzz", "invalid", tool.name],
                  });
                });

              generator.generate(tool.inputSchema, { mode: "fuzz", count: 10 })
                .forEach((input, i) => {
                  tests.push({
                    id: `tool-${tool.name}-fuzz-${i}`,
                    name: `${tool.name} › fuzz ${i + 1}`,
                    type: "fuzz",
                    tool: tool.name,
                    input,
                    tags: ["fuzz", tool.name],
                  });
                });

              generator.generateLlmStyle(tool.inputSchema)
                .forEach((input, i) => {
                  tests.push({
                    id: `tool-${tool.name}-llm-${i}`,
                    name: `${tool.name} › llm-style ${i + 1}: ${describeLlmStyle(input)}`,
                    type: "fuzz",
                    tool: tool.name,
                    input,
                    tags: ["fuzz", "llm-style", tool.name],
                  });
                });
            }
          }

          // Resources
          for (const resource of resources) {
            tests.push({
              id: `resource-${resource.name}`,
              name: `${resource.name} › read`,
              type: "resource-read",
              uri: resource.uri,
              tags: ["resource", resource.name],
            });
          }

          // Resource templates — generate a test with a placeholder URI
          for (const tmpl of resourceTemplates) {
            // Replace all {param} placeholders in the URI template with "example-<param>"
            const exampleUri = tmpl.uriTemplate.replace(
              /\{([^}]+)\}/g,
              (_: string, param: string) => `example-${param}`
            );
            tests.push({
              id: `resource-template-${tmpl.name}`,
              name: `${tmpl.name} › read (template)`,
              type: "resource-read",
              uri: exampleUri,
              tags: ["resource", "template", tmpl.name],
            });
          }

          // Prompts — probe the server to discover valid arg values (including
          // enum constraints that aren't exposed in MCP prompt metadata).
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

          // ── 3. Optionally save collection ────────────────────────────
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
                  cwd: options.cwd,
                };
              })();

          const collection: CheckSpecCollection = {
            version: "1.0",
            name: `Auto-scan: ${serverCommand}`,
            description: `Auto-generated by checkspec scan. Tools: ${tools.length}, Resources: ${resources.length + resourceTemplates.length}, Prompts: ${prompts.length}`,
            server: serverBlock,
            tests,
          };

          if (options.save) {
            writeFileSync(options.save, JSON.stringify(collection, null, 2));
            console.log(chalk.gray(`Collection saved to ${options.save}`));
          }

          // ── 4. Run tests with structured console output ───────────────
          const isConsole = options.output === "console";
          const reporter = createReporter(options.output);
          const timeout = parseInt(options.timeout, 10);
          const runner = new TestRunner(client, { timeout });
          const allResults: TestResult[] = [];

          if (isConsole) {
            printHeader(serverCommand, connectMs);
            printCapabilities(tools, resources, resourceTemplates, prompts);
          }

          type Group = { label: string; types: Array<TestCase["type"]> };
          const sectionGroups: Group[] = [
            { label: "Protocol Tests", types: ["protocol"] },
            { label: "Tool Tests",     types: ["tool-call"] },
            { label: "Fuzz Tests",     types: ["fuzz"] },
            { label: "Resource Tests", types: ["resource-read"] },
            { label: "Prompt Tests",   types: ["prompt-get"] },
          ];

          for (const group of sectionGroups) {
            const groupTests = tests.filter((t) => (group.types as string[]).includes(t.type));
            if (groupTests.length === 0) continue;

            if (isConsole) printSection(group.label);

            const groupResults: TestResult[] = [];
            for (const test of groupTests) {
              if (isConsole) reporter.onTestStart(test);
              const result = await runner.runTest(test);
              reporter.onTestEnd(result);
              allResults.push(result);
              groupResults.push(result);
            }

            // Per-tool fuzz summaries when --fuzz is active
            if (options.fuzz === true && group.types.includes("fuzz") && isConsole) {
              for (const tool of tools) {
                const toolFuzz = groupResults.filter((r) =>
                  r.testName.startsWith(tool.name + " ›")
                );
                if (toolFuzz.length > 0) printFuzzSummary(tool.name, toolFuzz);
              }
            }

            // Slow-tool warnings after Tool Tests section
            if (group.types.includes("tool-call") && isConsole) {
              for (const r of groupResults) {
                if (r.durationMs > 500) {
                  console.log(
                    chalk.gray(`  ℹ ${r.testName} took ${r.durationMs}ms — network tool?`)
                  );
                }
              }
            }
          }

          // ── 5. Security scan ─────────────────────────────────────────
          const scanner = new SecurityScanner();
          const findings = await scanner.scan(client);
          if (isConsole) printSecurityFindings(findings);

          // ── 6. Summary ───────────────────────────────────────────────
          const passed = allResults.filter((r) => r.passed).length;
          const failed = allResults.filter((r) => !r.passed).length;
          const totalMs = allResults.reduce((a, r) => a + r.durationMs, 0);

          reporter.onRunEnd({
            total: allResults.length,
            passed,
            failed,
            skipped: 0,
            durationMs: totalMs,
            results: allResults,
            hookResults: [],
            parametrizedSourceCount: 0,
          });

          if (isConsole) {
            console.log("\n" + chalk.gray("═".repeat(50)));
            const statusColor = failed === 0 ? chalk.green : chalk.red;
            console.log(
              statusColor(
                `Results: ${passed} passed, ${failed} failed (of ${allResults.length})`
              ) + chalk.gray(` | Total: ${totalMs}ms`)
            );
            if (findings.length > 0) {
              console.log(
                chalk.yellow(
                  `Security: ${findings.length} finding(s) — see Security Scan section above`
                )
              );
            }
          } else {
            console.log(reporter.flush());
          }

          // ── 7. HTML report ───────────────────────────────────────────
          const htmlFile = options.reportHtml ?? (options.output === "html" ? "report.html" : undefined);
          if (htmlFile) {
            const htmlReporter = new HTMLReporter();
            htmlReporter.setServerName(serverCommand);
            htmlReporter.setSecurityFindings(findings);
            allResults.forEach((r) => htmlReporter.onTestEnd(r));
            htmlReporter.onRunEnd({
              total: allResults.length,
              passed,
              failed,
              skipped: 0,
              durationMs: totalMs,
              results: allResults,
              hookResults: [],
              parametrizedSourceCount: 0,
            });
            writeFileSync(htmlFile, htmlReporter.flush());
            if (isConsole) {
              console.log(chalk.gray(`\nHTML report saved to ${htmlFile}`));
            }
          }

          // ── 8. Persist recording ─────────────────────────────────────
          const shouldSaveRecording =
            options.saveRecording !== undefined || options.output === "json";

          if (shouldSaveRecording) {
            const recordingFile =
              typeof options.saveRecording === "string"
                ? options.saveRecording
                : "checkspec-recording.json";
            const recordingData = {
              version: "1.0",
              serverCommand,
              capturedAt: new Date().toISOString(),
              durationMs: totalMs,
              messages: client.getRecording(),
            };
            writeFileSync(recordingFile, JSON.stringify(recordingData, null, 2));
            if (isConsole) {
              console.log(
                chalk.gray(
                  `\nRecording saved to ${recordingFile} (${recordingData.messages.length} messages)`
                )
              );
            }
          }

          process.exitCode =
            failed > 0 || findings.some((f) => f.severity === "critical" || f.severity === "high") ? 1 : 0;
        } finally {
          await client.disconnect();
        }
      }
    );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createReporter(format: string): Reporter {
  switch (format) {
    case "json":  return new JSONReporter();
    case "junit": return new JUnitReporter();
    case "html":  return new HTMLReporter();
    default:      return new ConsoleReporter();
  }
}

/** Short label for an LLM-style fuzz input based on its characteristic. */
function describeLlmStyle(input: Record<string, unknown>): string {
  if (Object.keys(input).length === 0) return "empty (forgot all fields)";
  const values = Object.values(input);
  const first = values[0];
  if (values.every((v) => v === "null")) return '"null" as string (coerced null)';
  if (values.every((v) => v === "yes")) return '"yes" for boolean fields';
  if (values.every((v) => v === "true")) return '"true" as string for boolean';
  if (values.every((v) => v === "N/A")) return '"N/A" (uncertain fill-in)';
  if (values.every((v) => v === "unknown")) return '"unknown" (uncertain fill-in)';
  if (values.every((v) => v === "none")) return '"none" (uncertain fill-in)';
  if (Array.isArray(first)) return "array where single value expected";
  if (typeof first === "string" && first.startsWith("{")) return "JSON-stringified object";
  if (typeof first === "string" && first.trim() === "") return "whitespace-only string";
  if (typeof first === "string" && first.includes("Tuesday")) return "natural language date";
  if (typeof first === "string" && first.includes("not sure")) return "natural language uncertainty";
  if ("_llm_note" in input) return "hallucinated extra fields";
  if (typeof first === "string") return `"${first}" (string coercion)`;
  return JSON.stringify(input).slice(0, 50);
}

/** Short label describing the first value in an edge-case input object. */
function describeEdge(input: Record<string, unknown>): string {
  for (const v of Object.values(input)) {
    if (typeof v === "string") {
      if (v === "")                  return "empty string";
      if (v === " ")                 return "whitespace";
      if (/^[\n\r\t]+$/.test(v))    return "control chars";
      if (v.startsWith("Ignore all")) return "prompt injection";
      if (v.startsWith("'"))         return "SQL injection";
      if (v.startsWith("<script"))   return "XSS";
      if (v.startsWith("../"))       return "path traversal";
      if (v.length > 100)            return `long string (${v.length} chars)`;
      return JSON.stringify(v);
    }
  }
  return JSON.stringify(input);
}
