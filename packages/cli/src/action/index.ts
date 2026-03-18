/**
 * GitHub Actions entrypoint for CheckSpec.
 *
 * Reads action inputs, runs either `scan` (server-command) or `test` (collection),
 * sets action outputs, and calls core.setFailed() if tests fail or security issues
 * are found above the threshold.
 *
 * Built to: dist/action/index.js
 * Referenced by: action.yml → runs.main
 *
 * NOTE: For production use as a GitHub Action, dist/action/index.js must be
 * committed to the repository (or bundled with @vercel/ncc) because GitHub
 * Actions cannot install npm dependencies at runtime.
 */

import * as core from "@actions/core";
import { readFileSync } from "fs";
import path from "path";
import {
  MCPRecordingClient,
  TestRunner,
  SchemaInputGenerator,
  SecurityScanner,
  JSONReporter,
} from "@checkspec/core";
import type { TestCase, CheckSpecCollection, SecurityFinding } from "@checkspec/core";
import { buildTransport, parseServerCommand } from "../transport.js";

async function run(): Promise<void> {
  const serverCommand = core.getInput("server-command");
  const collectionPath = core.getInput("collection");
  const workingDirectory = core.getInput("working-directory") || undefined;
  const fuzz = core.getInput("fuzz") === "true";
  const failOnSecurity = core.getInput("fail-on-security") !== "false";

  if (!serverCommand && !collectionPath) {
    core.setFailed("Either 'server-command' or 'collection' input is required.");
    return;
  }

  let collection: CheckSpecCollection;

  if (collectionPath) {
    // ── Run a saved collection ─────────────────────────────────────────────
    core.info(`Loading collection: ${collectionPath}`);
    try {
      const raw = readFileSync(path.resolve(collectionPath), "utf-8");
      collection = JSON.parse(raw) as CheckSpecCollection;
    } catch (err) {
      core.setFailed(`Failed to read collection file: ${err instanceof Error ? err.message : err}`);
      return;
    }
  } else {
    // ── Auto-generate from server-command ──────────────────────────────────
    core.info(`Connecting to: ${serverCommand}`);
    const transport = buildTransport(serverCommand, {
      cwd: workingDirectory,
      verbose: false,
    });
    const client = new MCPRecordingClient(transport);

    try {
      await client.connect();
    } catch (err) {
      core.setFailed(`Could not connect to server: ${err instanceof Error ? err.message : err}`);
      return;
    }

    const generator = new SchemaInputGenerator();
    const tests: TestCase[] = [];

    // Protocol
    tests.push({ id: "protocol-init", name: "Initialization handshake", type: "protocol", tags: ["protocol"] });

    // Discover and generate tool tests
    const tools = await client.listTools();
    for (const tool of tools) {
      const validInputs = generator.generate(tool.inputSchema, { mode: "valid", count: 1 });
      tests.push({
        id: `tool-${tool.name}-valid`,
        name: `${tool.name} › valid input`,
        type: "tool-call",
        tool: tool.name,
        input: validInputs[0] ?? {},
        expect: { success: true },
        tags: ["tool", tool.name],
      });

      const edgeCases = generator.generateEdgeCases(tool.inputSchema);
      const edgeInputs = fuzz ? edgeCases : edgeCases.slice(0, 5);
      edgeInputs.forEach((input, i) => {
        tests.push({
          id: `fuzz-${tool.name}-edge-${i}`,
          name: `${tool.name} › edge case ${i + 1}`,
          type: "fuzz",
          tool: tool.name,
          input,
          tags: ["fuzz", tool.name],
        });
      });

      if (fuzz) {
        generator.generate(tool.inputSchema, { mode: "invalid", count: 3 }).forEach((input, i) => {
          tests.push({
            id: `fuzz-${tool.name}-invalid-${i}`,
            name: `${tool.name} › invalid input ${i + 1}`,
            type: "fuzz",
            tool: tool.name,
            input,
            tags: ["fuzz", tool.name],
          });
        });
      }

      // Security test per tool
      tests.push({
        id: `security-${tool.name}`,
        name: `${tool.name} › security scan`,
        type: "security",
        tool: tool.name,
        securityThreshold: "high",
        tags: ["security"],
      });
    }

    await client.disconnect();

    collection = {
      version: "1.0",
      name: `Auto-scan: ${serverCommand}`,
      server: {
        command: parseServerCommand(serverCommand)[0],
        args: parseServerCommand(serverCommand)[1],
        cwd: workingDirectory,
      },
      tests,
    };
  }

  // ── Execute the collection ───────────────────────────────────────────────
  const transport = buildTransport(
    collection.server.command + (collection.server.args?.length ? " " + collection.server.args.join(" ") : ""),
    {
      cwd: workingDirectory ?? collection.server.cwd,
      env: collection.server.env,
      verbose: false,
    }
  );
  const client = new MCPRecordingClient(transport);

  try {
    await client.connect();
  } catch (err) {
    core.setFailed(`Could not connect to server: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const reporter = new JSONReporter();
  const runner = new TestRunner(client);
  const summary = await runner.runCollection(collection);

  reporter.onRunEnd(summary);

  // ── Security findings from security-type tests ───────────────────────────
  const securityFails = summary.results.filter(
    (r) => !r.passed && collection.tests.find((t) => t.id === r.testId)?.type === "security"
  );
  const securityFindingCount = securityFails.length;

  await client.disconnect();

  // ── Set outputs ──────────────────────────────────────────────────────────
  core.setOutput("result", summary.failed === 0 ? "passed" : "failed");
  core.setOutput("total-tests", String(summary.total));
  core.setOutput("failed-tests", String(summary.failed));
  core.setOutput("security-findings", String(securityFindingCount));

  // ── Logging ──────────────────────────────────────────────────────────────
  core.info(`Results: ${summary.passed} passed, ${summary.failed} failed (of ${summary.total})`);
  if (securityFindingCount > 0) {
    core.warning(`Security: ${securityFindingCount} finding(s) detected`);
  }

  for (const result of summary.results) {
    if (!result.passed) {
      core.error(`FAILED: ${result.testName} — ${result.error ?? "no error message"}`);
    }
  }

  // ── Exit conditions ──────────────────────────────────────────────────────
  if (summary.failed > 0) {
    core.setFailed(`${summary.failed} test(s) failed`);
    return;
  }

  if (failOnSecurity && securityFindingCount > 0) {
    core.setFailed(`${securityFindingCount} security finding(s) detected`);
    return;
  }

  core.info("All tests passed ✓");
}

run().catch((err: unknown) => {
  core.setFailed(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
