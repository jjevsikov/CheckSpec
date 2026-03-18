#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import { createScanCommand } from "./commands/scan.js";
import { createTestCommand } from "./commands/test.js";
import { createInspectCommand } from "./commands/inspect.js";
import { createReportCommand } from "./commands/report.js";
import { createGenerateCommand } from "./commands/generate.js";
import { createDiffCommand } from "./commands/diff.js";
import { createInitCommand } from "./commands/init.js";

const require = createRequire(import.meta.url);
// Load the CLI package's own package.json for version info
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("checkspec")
  .description("CheckSpec — pytest for MCP servers. Test and QA your MCP server.")
  .version(pkg.version ?? "0.1.0");

program.addCommand(createScanCommand());
program.addCommand(createTestCommand());
program.addCommand(createInitCommand());
program.addCommand(createGenerateCommand());
program.addCommand(createDiffCommand());
program.addCommand(createInspectCommand());
program.addCommand(createReportCommand());

// Global safety net: catch unexpected errors and suppress the raw stack trace.
try {
  await program.parseAsync(process.argv);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nError: ${message}`);
  console.error(`Run with --verbose for more detail.`);
  process.exit(1);
}
