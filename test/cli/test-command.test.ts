/**
 * CLI integration tests — `checkspec test` command.
 *
 * Each test spawns the compiled CLI as a child process and asserts on
 * stdout, stderr, and exit code. No TypeScript imports from @checkspec/core
 * are used here — the CLI is treated as a black box.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "fs";
import { join as pathJoin } from "path";
import {
  runCli,
  makeTempDir,
  writeCollection,
  echoCollection,
  ECHO_SERVER,
  type TempDir,
} from "./helpers.js";

// ── Test fixture setup ────────────────────────────────────────────────────────

let tmp: TempDir;

beforeAll(() => {
  tmp = makeTempDir();
});

afterAll(() => {
  tmp.cleanup();
});

// ── Passing collection ────────────────────────────────────────────────────────

describe("passing collection", () => {
  it("exits 0 when all tests pass", async () => {
    const file = writeCollection(tmp.dir, "pass.json", echoCollection());
    const { exitCode } = await runCli(["test", file], { cwd: tmp.dir });
    expect(exitCode).toBe(0);
  });

  it("prints ✓ and the test name for a passing test", async () => {
    const file = writeCollection(tmp.dir, "pass-name.json", echoCollection());
    const { stdout } = await runCli(["test", file], { cwd: tmp.dir });
    expect(stdout).toContain("✓");
    expect(stdout).toContain("echo › hello");
  });

  it("prints a summary line showing Tests: 1 passed, 0 failed", async () => {
    const file = writeCollection(tmp.dir, "pass-summary.json", echoCollection());
    const { stdout } = await runCli(["test", file], { cwd: tmp.dir });
    expect(stdout).toContain("Tests: 1 passed, 0 failed");
  });
});

// ── Optional IDs (auto-generate) ─────────────────────────────────────────────

describe("optional test IDs", () => {
  it("runs a collection where tests have no id field", async () => {
    const collection = {
      version: "1.0",
      name: "No IDs",
      server: { command: "node", args: [ECHO_SERVER] },
      tests: [
        {
          // deliberately omit `id`
          name: "echo › hello",
          type: "tool-call",
          tool: "echo",
          input: { message: "hello" },
          expect: { success: true, contains: "hello" },
        },
      ],
    };
    const file = writeCollection(tmp.dir, "no-ids.json", collection);
    const { exitCode, stdout } = await runCli(["test", file], { cwd: tmp.dir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓");
    expect(stdout).toContain("1 passed");
  });
});

// ── Failing collection ────────────────────────────────────────────────────────

describe("failing collection", () => {
  it("exits 1 when a test fails", async () => {
    const file = writeCollection(
      tmp.dir,
      "fail.json",
      echoCollection({ expectContains: "NEVER_IN_RESPONSE_XYZ" })
    );
    const { exitCode } = await runCli(["test", file], { cwd: tmp.dir });
    expect(exitCode).toBe(1);
  });

  it("prints ✗ and the test name for a failing test", async () => {
    const file = writeCollection(
      tmp.dir,
      "fail-name.json",
      echoCollection({ expectContains: "NEVER_IN_RESPONSE_XYZ" })
    );
    const { stdout } = await runCli(["test", file], { cwd: tmp.dir });
    expect(stdout).toContain("✗");
    expect(stdout).toContain("echo › hello");
  });
});

// ── File / JSON error handling ────────────────────────────────────────────────

describe("error handling — before server starts", () => {
  it("exits 1 and reports an error when the collection file does not exist", async () => {
    const { exitCode, stderr } = await runCli(
      ["test", "/tmp/no-such-checkspec-file-abc123.json"],
      { cwd: tmp.dir }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Cannot read collection file|ENOENT/i);
  });

  it("exits 1 and reports an error when the collection file contains invalid JSON", async () => {
    const badJson = pathJoin(tmp.dir, "bad.json");
    writeFileSync(badJson, "{ this is not valid json !!!");

    const { exitCode, stderr } = await runCli(["test", badJson], { cwd: tmp.dir });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Invalid JSON/i);
  });

  it("exits 1 and shows Zod error for an unknown key in expect block — before server spawns", async () => {
    // "sucess" is a common typo; z.strictObject() on expect blocks catches it.
    const collection = {
      version: "1.0",
      name: "Schema error test",
      server: { command: "node", args: ["nonexistent-server.js"] },
      tests: [
        {
          id: "t1",
          name: "bad expect key",
          type: "tool-call",
          tool: "echo",
          input: { message: "hi" },
          expect: { sucess: true },   // ← intentional typo
        },
      ],
    };
    const file = writeCollection(tmp.dir, "schema-error.json", collection);

    const { exitCode, stderr } = await runCli(["test", file], { cwd: tmp.dir });
    expect(exitCode).toBe(1);
    // The Zod validation message contains the unrecognized key name
    expect(stderr).toMatch(/Invalid collection file|Unrecognized key|sucess/i);
  });
});

// ── --output json ─────────────────────────────────────────────────────────────

describe("--output json", () => {
  it("prints valid JSON to stdout", async () => {
    const file = writeCollection(tmp.dir, "json-out.json", echoCollection());
    const { exitCode, stdout } = await runCli(["test", file, "--output", "json"], {
      cwd: tmp.dir,
    });
    expect(exitCode).toBe(0);

    expect(stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    // RunSummary shape
    expect(parsed.total).toBe(1);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(Array.isArray(parsed.results)).toBe(true);
  });
});

// ── --filter ──────────────────────────────────────────────────────────────────

describe("--filter tag", () => {
  it("runs only tests whose tags include the filter value", async () => {
    const file = writeCollection(
      tmp.dir,
      "filter-match.json",
      echoCollection({ tags: ["smoke"] })
    );
    const { exitCode, stdout } = await runCli(["test", file, "--filter", "smoke"], {
      cwd: tmp.dir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓");
  });

  it("exits 0 with zero tests run when no tests match the filter tag", async () => {
    const file = writeCollection(
      tmp.dir,
      "filter-miss.json",
      echoCollection({ tags: ["smoke"] })
    );
    const { exitCode, stdout } = await runCli(
      ["test", file, "--filter", "nonexistent-tag-xyz"],
      { cwd: tmp.dir }
    );
    // No failures → exit 0
    expect(exitCode).toBe(0);
    // Summary shows 0 passed (the tagged test was skipped)
    expect(stdout).toMatch(/Tests: 0 passed/);
  });
});
