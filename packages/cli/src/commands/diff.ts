import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "fs";
import chalk from "chalk";
import {
  MCPRecordingClient,
  captureSnapshot,
  diffSnapshots,
} from "@checkspec/core";
import type { DriftFinding, DriftSeverity, ServerSnapshot } from "@checkspec/core";
import {
  buildTransport,
  buildTransportFromConfig,
  parseEnvPairs,
  isConnectionError,
  dieWithConnectionError,
} from "../transport.js";

const DEFAULT_SNAPSHOT_FILE = "checkspec-snapshot.json";

const SEVERITY_COLOR: Record<DriftSeverity, (s: string) => string> = {
  critical: chalk.red,
  high:     chalk.red,
  medium:   chalk.yellow,
  info:     chalk.gray,
};

// ── Section helpers ───────────────────────────────────────────────────────────

function printHeader(serverCommand: string, connectMs: number) {
  console.log("\n" + chalk.bold("CheckSpec diff") + "  " + chalk.gray(serverCommand));
  console.log(chalk.gray("═".repeat(50)));
  console.log(chalk.gray(`Connected in ${connectMs}ms`));
}

function printSection(label: string) {
  console.log(
    "\n" + chalk.bold(label) + " " + chalk.gray("─".repeat(Math.max(0, 44 - label.length)))
  );
}

function printFinding(f: DriftFinding) {
  const color = SEVERITY_COLOR[f.severity];
  const icon = f.type === "removed" ? "✖" : f.type === "added" ? "+" : "~";
  console.log(
    color(`  [${f.severity.toUpperCase()}] ${icon} ${f.category}:"${f.name}" › ${f.type}`)
  );
  console.log(`         ${f.description}`);
  if (f.before !== undefined) {
    console.log(chalk.gray(`    Before: ${f.before}`));
  }
  if (f.after !== undefined) {
    console.log(chalk.gray(`    After:  ${f.after}`));
  }
  console.log(chalk.cyan(`    Fix:    ${f.remediation}`));
}

function printSummary(findings: DriftFinding[], baselinePath: string, baselineDate: string) {
  const counts: Record<DriftSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    info: 0,
  };
  for (const f of findings) counts[f.severity]++;

  console.log("\n" + chalk.gray("═".repeat(50)));
  console.log(chalk.gray(`Baseline: ${baselinePath}  (captured ${baselineDate})`));

  if (findings.length === 0) {
    console.log(chalk.green("No schema drift detected — server matches baseline exactly."));
    return;
  }

  const parts: string[] = [];
  if (counts.critical > 0) parts.push(chalk.red(`${counts.critical} critical`));
  if (counts.high > 0) parts.push(chalk.red(`${counts.high} high`));
  if (counts.medium > 0) parts.push(chalk.yellow(`${counts.medium} medium`));
  if (counts.info > 0) parts.push(chalk.gray(`${counts.info} info`));

  console.log(`Drift detected: ${findings.length} finding(s) — ${parts.join(", ")}`);
}

// ── Command ───────────────────────────────────────────────────────────────────

export function createDiffCommand(): Command {
  return new Command("diff")
    .description(
      "Detect schema drift by comparing the live server against a saved baseline snapshot.\n" +
      "On first run, saves a baseline. On subsequent runs, compares and reports changes."
    )
    .argument(
      "[server-command]",
      "Command to start the MCP server (e.g. 'node dist/index.js'). Omit when using --url."
    )
    .option(
      "--baseline <file>",
      `Path to the baseline snapshot file (default: ${DEFAULT_SNAPSHOT_FILE})`
    )
    .option(
      "--update",
      "After comparing, update the baseline with the current server state",
      false
    )
    .option(
      "--save [path]",
      "Save a new baseline without comparing (optional path overrides --baseline)"
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
      "Working directory for the server process (required for Python uv projects)"
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
    .action(async (
      serverCommandArg: string | undefined,
      options: {
        baseline?: string;
        update: boolean;
        save?: string | boolean;
        url?: string;
        transport?: string;
        header: string[];
        cwd?: string;
        env: string[];
        verbose: boolean;
      }
    ) => {
      if (!serverCommandArg && !options.url) {
        console.error("Error: provide either a server command or --url <url>");
        process.exit(1);
      }

      const serverCommand = options.url ?? serverCommandArg!;

      // --save [path] wins over --baseline for the output path; reading still uses --baseline.
      const savePath =
        typeof options.save === "string" ? options.save : undefined;
      const baselinePath = savePath ?? options.baseline ?? DEFAULT_SNAPSHOT_FILE;

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
          if (isConnectionError(err)) dieWithConnectionError(serverCommand, options.verbose);
          throw err;
        }
        const connectMs = Date.now() - connectStart;
        printHeader(serverCommand, connectMs);

        // ── Capture current snapshot ──────────────────────────────────────────
        const current = await captureSnapshot(client, serverCommand);

        // ── Save-only mode ────────────────────────────────────────────────────
        if (options.save) {
          writeFileSync(baselinePath, JSON.stringify(current, null, 2));
          console.log(chalk.green(`\nBaseline saved to ${chalk.bold(baselinePath)}`));
          const resTmplCount = current.resourceTemplates?.length ?? 0;
          const resLabel = resTmplCount > 0
            ? `${current.resources.length} resources (+ ${resTmplCount} template${resTmplCount === 1 ? "" : "s"})`
            : `${current.resources.length} resources`;
          console.log(chalk.gray(
            `  Captured: ${current.tools.length} tools, ` +
            `${resLabel}, ` +
            `${current.prompts.length} prompts`
          ));
          return;
        }

        // ── First-run: no baseline yet ────────────────────────────────────────
        if (!existsSync(baselinePath)) {
          writeFileSync(baselinePath, JSON.stringify(current, null, 2));
          printSection("Schema Drift");
          console.log(chalk.green(`  Baseline saved to ${chalk.bold(baselinePath)}`));
          const resTmplCount2 = current.resourceTemplates?.length ?? 0;
          const resLabel2 = resTmplCount2 > 0
            ? `${current.resources.length} resources (+ ${resTmplCount2} template${resTmplCount2 === 1 ? "" : "s"})`
            : `${current.resources.length} resources`;
          console.log(chalk.gray(
            `  Captured: ${current.tools.length} tools, ` +
            `${resLabel2}, ` +
            `${current.prompts.length} prompts`
          ));
          console.log(chalk.gray("\n  Run again to detect drift against this baseline."));
          return;
        }

        // ── Load and compare against baseline ─────────────────────────────────
        let baseline: ServerSnapshot;
        try {
          baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as ServerSnapshot;
        } catch {
          console.error(`Error: Could not read baseline file "${baselinePath}". Run with --save to create a new baseline.`);
          process.exit(1);
        }

        const findings = diffSnapshots(baseline, current);
        const baselineDate = new Date(baseline.capturedAt).toLocaleString();

        printSection("Schema Drift");
        if (findings.length === 0) {
          console.log(chalk.green("  ✓ No drift — server matches baseline exactly"));
        } else {
          for (const f of findings) {
            printFinding(f);
          }
        }

        printSummary(findings, baselinePath, baselineDate);

        // ── Optionally update baseline ─────────────────────────────────────────
        if (options.update) {
          writeFileSync(baselinePath, JSON.stringify(current, null, 2));
          console.log(chalk.gray(`\nBaseline updated: ${baselinePath}`));
        } else if (findings.length > 0) {
          console.log(chalk.gray(`\nRun with --update to accept these changes as the new baseline.`));
        }

        // Exit non-zero if any high/critical drift
        const hasSerious = findings.some(
          (f) => f.severity === "critical" || f.severity === "high"
        );
        process.exitCode = hasSerious ? 1 : 0;
      } finally {
        await client.disconnect();
      }
    });
}
