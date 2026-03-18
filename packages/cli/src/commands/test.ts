import { Command } from "commander";
import { readFileSync, writeFileSync } from "fs";
import chalk from "chalk";
import { watch } from "chokidar";
import {
  MCPRecordingClient,
  TestRunner,
  ConsoleReporter,
  JUnitReporter,
  JSONReporter,
  HTMLReporter,
} from "@checkspec/core";
import type { CheckSpecCollection, Reporter } from "@checkspec/core";
import { validateCollection } from "@checkspec/core/schema";
import { buildTransportFromConfig, parseEnvPairs, isConnectionError, dieWithConnectionError } from "../transport.js";

export function createTestCommand(): Command {
  return new Command("test")
    .description("Run a .checkspec.json collection against its configured server")
    .argument("<collection-file>", "Path to the .checkspec.json collection file")
    .option(
      "-o, --output <format>",
      "Output format: console, json, junit, html",
      "console"
    )
    .option("--report-html <file>", "Save an HTML report to this file")
    .option(
      "-f, --filter <tag>",
      "Only run tests with this tag"
    )
    .option("--bail", "Stop on first failure", false)
    .option(
      "--save-recording [file]",
      "Save the full message recording to a JSON file (default: checkspec-recording.json)"
    )
    .option(
      "--cwd <dir>",
      "Override working directory for the server process (overrides collection file setting)"
    )
    .option(
      "--env <KEY=VALUE>",
      "Set an environment variable for the server process (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      "--verbose",
      "Show server stderr output (useful for debugging; hides Python log noise by default)",
      false
    )
    .option(
      "-w, --watch",
      "Re-run tests automatically when the collection file changes",
      false
    )
    .action(async (collectionFile: string, options: {
      output: string;
      reportHtml?: string;
      filter?: string;
      bail: boolean;
      saveRecording?: string | boolean;
      cwd?: string;
      env: string[];
      verbose: boolean;
      watch: boolean;
    }) => {
      let envVars: Record<string, string> | undefined;
      try {
        envVars = options.env.length > 0 ? parseEnvPairs(options.env) : undefined;
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      const runOnce = async (): Promise<boolean> => {
        // ── Load and validate the collection file ──────────────────────────
        // Validation runs BEFORE any transport is created or child process is
        // spawned. A typo like `"sucess": true` in an expect block exits here
        // with a clear message rather than silently always passing.
        let raw: string;
        try {
          raw = readFileSync(collectionFile, "utf-8");
        } catch (err) {
          console.error(
            chalk.red(`✗ Cannot read collection file "${collectionFile}": `) +
            (err instanceof Error ? err.message : String(err))
          );
          return false;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          console.error(
            chalk.red(`✗ Invalid JSON in "${collectionFile}": `) +
            (err instanceof Error ? err.message : String(err))
          );
          return false;
        }

        const validation = validateCollection(parsed);
        if (!validation.success) {
          console.error(chalk.red("✗ Invalid collection file:"));
          console.error(chalk.red(validation.message));
          return false;
        }

        // Cast is safe: resolveIds() inside TestRunner fills in any missing `id` fields.
        const collection = validation.data as unknown as CheckSpecCollection;

        // Build a display label for error messages and recording metadata
        const serverCommand = collection.server.url
          ? collection.server.url
          : [collection.server.command, ...(collection.server.args ?? [])].join(" ");

        // CLI --cwd overrides the collection file's cwd (stdio only)
        const effectiveCwd = options.cwd ?? collection.server.cwd;

        // Apply CLI overrides to the server config before building the transport.
        // For URL-based configs, --cwd and --env are ignored (not applicable).
        const serverConfig = {
          ...collection.server,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          ...(envVars ? { env: { ...collection.server.env, ...envVars } } : {}),
        };

        const transport = buildTransportFromConfig(serverConfig, {
          verbose: options.verbose,
        });
        const client = new MCPRecordingClient(transport);

        try {
          try {
            await client.connect();
          } catch (err) {
            if (isConnectionError(err)) {
              if (options.watch) {
                // In watch mode, print the error but don't exit — the user
                // may fix the server and trigger a re-run via file change.
                console.error(chalk.red(`\n✗ Could not connect to MCP server: ${serverCommand}`));
                console.error(chalk.red("  Fix the server and save the collection file to retry.\n"));
                return false;
              }
              dieWithConnectionError(serverCommand, options.verbose);
            }
            throw err;
          }

          const reporter = createReporter(options.output);
          const runner = new TestRunner(client, {
            bail: options.bail,
            tags: options.filter ? [options.filter] : undefined,
            onTestStart:     (t) => reporter.onTestStart(t),
            onTestEnd:       (r) => reporter.onTestEnd(r),
            onHookEnd:       (r) => reporter.onHookEnd?.(r),
            onDescribeStart: (n) => reporter.onDescribeStart?.(n),
            onDescribeEnd:   (n) => reporter.onDescribeEnd?.(n),
          });

          const summary = await runner.runCollection(collection);
          reporter.onRunEnd(summary);

          const output = reporter.flush();
          if (options.output !== "console") {
            console.log(output);
          }

          // Persist recording if requested or when output is JSON
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
              durationMs: summary.durationMs,
              messages: client.getRecording(),
            };
            writeFileSync(recordingFile, JSON.stringify(recordingData, null, 2));
            if (options.output === "console") {
              console.log(
                chalk.gray(
                  `\nRecording saved to ${recordingFile} (${recordingData.messages.length} messages)`
                )
              );
            }
          }

          // Generate HTML report if requested
          const htmlFile = options.reportHtml ?? (options.output === "html" ? "report.html" : undefined);
          if (htmlFile) {
            const htmlReporter = new HTMLReporter();
            htmlReporter.setServerName(collection.name ?? serverCommand);
            summary.results.forEach((r) => htmlReporter.onTestEnd(r));
            htmlReporter.onRunEnd(summary);
            writeFileSync(htmlFile, htmlReporter.flush());
            if (options.output === "console") {
              console.log(chalk.gray(`\nHTML report saved to ${htmlFile}`));
            }
          }

          return summary.failed === 0;
        } finally {
          await client.disconnect();
        }
      };

      if (!options.watch) {
        // Normal single-run mode
        const passed = await runOnce();
        process.exitCode = passed ? 0 : 1;
        return;
      }

      // ── Watch mode ────────────────────────────────────────────────────────
      console.log(chalk.cyan(`\nWatching ${collectionFile} for changes. Press Ctrl+C to stop.\n`));

      // Initial run
      await runOnce();

      let running = false;
      const watcher = watch(collectionFile, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });

      watcher.on("change", async () => {
        // Debounce: skip if a run is already in progress
        if (running) return;
        running = true;
        console.log(chalk.cyan(`\n[watch] ${collectionFile} changed — re-running...\n`));
        try {
          await runOnce();
        } catch (err) {
          console.error(chalk.red(`[watch] Run failed: ${err instanceof Error ? err.message : String(err)}`));
        } finally {
          running = false;
        }
      });

      watcher.on("error", (err) => {
        console.error(chalk.red(`[watch] Watcher error: ${err instanceof Error ? err.message : String(err)}`));
      });

      // Keep the process alive until the user presses Ctrl+C
      const shutdown = async () => {
        console.log(chalk.gray("\n[watch] Stopping."));
        await watcher.close();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Block indefinitely — chokidar's persistent mode keeps the event loop alive,
      // but we also await this promise so Commander doesn't exit before Ctrl+C.
      await new Promise<void>(() => {});
    });
}

function createReporter(format: string): Reporter {
  switch (format) {
    case "json":
      return new JSONReporter();
    case "junit":
      return new JUnitReporter();
    case "html":
      return new HTMLReporter();
    default:
      return new ConsoleReporter();
  }
}
