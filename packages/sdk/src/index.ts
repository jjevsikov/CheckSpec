/**
 * @checkspec/sdk
 *
 * Programmatic API for embedding CheckSpec in your own tools, test frameworks,
 * and CI scripts — without the CLI ceremony.
 *
 * ## Why this package exists
 *
 * @checkspec/core is the full internal library. It's powerful but exposes many
 * implementation details. The SDK provides a clean, stable, high-level API
 * surface designed for external consumers:
 *
 *   import { scan, test, generate } from "@checkspec/sdk";
 *
 * Compare to using the core directly:
 *   import { MCPRecordingClient, TestRunner, SchemaInputGenerator, SecurityScanner, … }
 *   // … lots of setup …
 *
 * The SDK handles the setup and exposes simple async functions.
 * It will maintain backwards-compatibility across minor versions.
 *
 * ## Usage examples
 *
 * ### Run a collection from a file
 * ```typescript
 * import { test } from "@checkspec/sdk";
 *
 * const summary = await test("node dist/server.js", "./my-server.checkspec.json");
 * console.log(`${summary.passed}/${summary.total} passed`);
 * process.exit(summary.failed > 0 ? 1 : 0);
 * ```
 *
 * ### Auto-scan a server
 * ```typescript
 * import { scan } from "@checkspec/sdk";
 *
 * const { summary, findings } = await scan("node dist/server.js");
 * if (findings.some(f => f.severity === "critical")) {
 *   throw new Error("Critical security issue found!");
 * }
 * ```
 *
 * ### Generate an AI test collection (requires ANTHROPIC_API_KEY)
 * ```typescript
 * import { generate } from "@checkspec/sdk";
 * import { writeFileSync } from "fs";
 *
 * const collection = await generate("node dist/server.js");
 * writeFileSync("generated.checkspec.json", JSON.stringify(collection, null, 2));
 * ```
 *
 * ### Vitest / Jest integration
 * ```typescript
 * import { scan } from "@checkspec/sdk";
 * import { describe, it, expect } from "vitest";
 *
 * describe("My MCP server", () => {
 *   it("passes all auto-generated tests", async () => {
 *     const { summary } = await scan("node dist/server.js");
 *     expect(summary.failed).toBe(0);
 *   });
 *
 *   it("has no security findings", async () => {
 *     const { findings } = await scan("node dist/server.js");
 *     const critical = findings.filter(f => f.severity === "critical" || f.severity === "high");
 *     expect(critical).toHaveLength(0);
 *   });
 * });
 * ```
 */

import { readFileSync } from "fs";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  MCPRecordingClient,
  TestRunner,
  SchemaInputGenerator,
  SecurityScanner,
  AITestGenerator,
  HTMLReporter,
} from "@checkspec/core";
import type {
  CheckSpecCollection,
  TestCase,
  RunSummary,
  SecurityFinding,
  AIGenerateOptions,
} from "@checkspec/core";

// ── Public types ──────────────────────────────────────────────────────────────

export type { CheckSpecCollection, TestCase, RunSummary, SecurityFinding };

export interface ScanOptions {
  /** Per-test timeout in milliseconds. Default: 10_000 */
  timeout?: number;
  /** Working directory for the server process (required for Python uv projects). */
  cwd?: string;
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
  /** Run the full fuzz suite (all edge cases + invalid + random inputs). Default: false */
  fuzz?: boolean;
  /** Suppress server stderr. Default: true */
  quiet?: boolean;
}

export interface ScanResult {
  summary: RunSummary;
  findings: SecurityFinding[];
  /** Generated HTML report string. Save with writeFileSync("report.html", html) */
  html: string;
}

export interface TestOptions {
  /** Per-test timeout in milliseconds. Default: 10_000 */
  timeout?: number;
  /** Working directory for the server process. */
  cwd?: string;
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
  /** Suppress server stderr. Default: true */
  quiet?: boolean;
  /** Stop on first failure. Default: false */
  bail?: boolean;
  /** Only run tests with this tag. */
  tag?: string;
}

export interface TestResult {
  summary: RunSummary;
  /** Generated HTML report string. */
  html: string;
}

export interface GenerateOptions extends AIGenerateOptions {
  /** Working directory for the server process. */
  cwd?: string;
  /** Human-readable server name for the collection header. */
  name?: string;
}

// ── scan() ────────────────────────────────────────────────────────────────────

/**
 * Connect to an MCP server, auto-generate tests from its schema, run them,
 * and scan for security issues.
 *
 * The server process is started and stopped automatically.
 *
 * @param serverCommand  Shell command to start the server, e.g. `"node dist/index.js"`
 * @param options        Scan options (timeout, cwd, fuzz depth, …)
 * @returns              Test summary, security findings, and an HTML report string
 */
export async function scan(
  serverCommand: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const client = buildClient(serverCommand, options);

  await client.connect();
  try {
    const tools     = await client.listTools();
    const resources = await safeList(() => client.listResources());
    const prompts   = await safeList(() => client.listPrompts());

    const generator = new SchemaInputGenerator();
    const tests: TestCase[] = [
      { id: "protocol-init", name: "Initialization handshake", type: "protocol", tags: ["protocol"] },
    ];

    for (const tool of tools) {
      const inputs = generator.generate(tool.inputSchema, { mode: "valid", count: 1 });
      tests.push({
        id: `tool-${tool.name}-valid`,
        name: `${tool.name} › valid input`,
        type: "tool-call",
        tool: tool.name,
        input: inputs[0] ?? {},
        expect: { success: true },
        tags: ["tool", tool.name],
      });

      const edgeInputs = options.fuzz
        ? generator.generateEdgeCases(tool.inputSchema)
        : generator.generateEdgeCases(tool.inputSchema).slice(0, 3);

      edgeInputs.forEach((input, i) => {
        tests.push({
          id: `tool-${tool.name}-edge-${i}`,
          name: `${tool.name} › edge case ${i + 1}`,
          type: "fuzz",
          tool: tool.name,
          input,
          tags: ["fuzz", tool.name],
        });
      });
    }

    for (const resource of resources) {
      tests.push({
        id: `resource-${resource.name}`,
        name: `${resource.name} › read`,
        type: "resource-read",
        uri: resource.uri,
        tags: ["resource"],
      });
    }

    for (const prompt of prompts) {
      tests.push({
        id: `prompt-${prompt.name}`,
        name: `${prompt.name} › get`,
        type: "prompt-get",
        promptName: prompt.name,
        tags: ["prompt"],
      });
    }

    const [command, ...args] = serverCommand.split(" ");
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: `Auto-scan: ${serverCommand}`,
      server: { command, args, cwd: options.cwd },
      tests,
    };

    const runner = new TestRunner(client, { timeout: options.timeout ?? 10_000 });
    const results = [];
    for (const test of tests) {
      results.push(await runner.runTest(test));
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const totalMs = results.reduce((a, r) => a + r.durationMs, 0);
    const summary: RunSummary = {
      total: tests.length, passed, failed, skipped: 0, durationMs: totalMs, results, hookResults: [], parametrizedSourceCount: 0,
    };

    const scanner = new SecurityScanner();
    const findings = await scanner.scan(client);

    const htmlReporter = new HTMLReporter();
    htmlReporter.setServerName(serverCommand);
    htmlReporter.setSecurityFindings(findings);
    results.forEach((r) => htmlReporter.onTestEnd(r));
    htmlReporter.onRunEnd(summary);
    const html = htmlReporter.flush();

    void collection; // suppress unused warning — callers can reconstruct from summary
    return { summary, findings, html };
  } finally {
    await client.disconnect();
  }
}

// ── test() ────────────────────────────────────────────────────────────────────

/**
 * Load a `.checkspec.json` collection file and run it against its configured server.
 *
 * @param serverCommand   Shell command to start the server (overrides collection server config)
 * @param collectionPath  Path to the `.checkspec.json` file
 * @param options         Test options (timeout, bail, tag filter, …)
 */
export async function test(
  serverCommand: string,
  collectionPath: string,
  options: TestOptions = {}
): Promise<TestResult> {
  const collection = JSON.parse(
    readFileSync(collectionPath, "utf-8")
  ) as CheckSpecCollection;

  const client = buildClient(serverCommand, options);
  await client.connect();

  try {
    const runner = new TestRunner(client, {
      timeout: options.timeout ?? 10_000,
      bail: options.bail,
      tags: options.tag ? [options.tag] : undefined,
    });

    const summary = await runner.runCollection(collection);

    const htmlReporter = new HTMLReporter();
    htmlReporter.setServerName(collection.name ?? serverCommand);
    summary.results.forEach((r) => htmlReporter.onTestEnd(r));
    htmlReporter.onRunEnd(summary);

    return { summary, html: htmlReporter.flush() };
  } finally {
    await client.disconnect();
  }
}

// ── generate() ───────────────────────────────────────────────────────────────

/**
 * Use Claude AI to generate a `.checkspec.json` collection for an MCP server.
 * Requires ANTHROPIC_API_KEY to be set (or passed via options.apiKey).
 *
 * @param serverCommand  Shell command to start the server
 * @param options        Generation options (model, maxTestsPerTool, apiKey, …)
 * @returns              A complete CheckSpecCollection ready to save or run
 */
export async function generate(
  serverCommand: string,
  options: GenerateOptions = {}
): Promise<CheckSpecCollection> {
  const client = buildClient(serverCommand, options);
  await client.connect();

  try {
    const tools     = await client.listTools();
    const resources = await safeList(() => client.listResources());
    const prompts   = await safeList(() => client.listPrompts());

    const generator = new AITestGenerator({
      apiKey: options.apiKey,
      model: options.model,
      maxTestsPerTool: options.maxTestsPerTool,
      includeSecurity: options.includeSecurity,
    });

    return await generator.generate(tools, resources, prompts, {
      serverCommand,
      serverName: options.name,
      cwd: options.cwd,
    });
  } finally {
    await client.disconnect();
  }
}

// ── Re-export core types for convenience ─────────────────────────────────────

export { MCPRecordingClient, TestRunner, SecurityScanner, AITestGenerator } from "@checkspec/core";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildClient(
  serverCommand: string,
  options: { cwd?: string; env?: Record<string, string>; quiet?: boolean }
): MCPRecordingClient {
  const [command, ...args] = serverCommand.split(" ");
  const env = options.env
    ? { ...process.env, ...options.env } as Record<string, string>
    : undefined;

  const transport = new StdioClientTransport({
    command,
    args,
    cwd: options.cwd,
    env,
    stderr: options.quiet === false ? "inherit" : "ignore",
  });

  return new MCPRecordingClient(transport);
}

async function safeList<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try { return await fn(); } catch { return []; }
}
