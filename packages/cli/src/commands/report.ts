import { Command } from "commander";
import { readFileSync } from "fs";
import { JUnitReporter, JSONReporter } from "@checkspec/core";
import type { RunSummary } from "@checkspec/core";

export function createReportCommand(): Command {
  return new Command("report")
    .description("Convert a saved JSON results file to another format")
    .argument("<results-json>", "Path to the JSON results file from a previous run")
    .option(
      "-f, --format <format>",
      "Output format: junit, json",
      "junit"
    )
    .option("-o, --out <file>", "Write output to a file instead of stdout")
    .action(async (resultsFile: string, options: {
      format: string;
      out?: string;
    }) => {
      let summary: RunSummary;

      try {
        const raw = readFileSync(resultsFile, "utf-8");
        summary = JSON.parse(raw) as RunSummary;
      } catch (err) {
        console.error(
          `Error reading results file "${resultsFile}":`,
          err instanceof Error ? err.message : err
        );
        process.exit(1);
      }

      let output: string;

      switch (options.format) {
        case "junit": {
          const reporter = new JUnitReporter();
          reporter.onRunEnd(summary);
          output = reporter.flush();
          break;
        }
        case "json": {
          const reporter = new JSONReporter();
          reporter.onRunEnd(summary);
          output = reporter.flush();
          break;
        }
        default:
          console.error(`Unknown format: ${options.format}. Use 'junit' or 'json'.`);
          process.exit(1);
      }

      if (options.out) {
        const { writeFileSync } = await import("fs");
        writeFileSync(options.out, output);
        console.log(`Report written to ${options.out}`);
      } else {
        console.log(output);
      }
    });
}
