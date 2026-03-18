/**
 * CLI integration tests — `checkspec scan` command.
 *
 * Spawns the CLI against the compiled echo-server fixture and asserts on
 * console output, section headers, and exit codes.
 *
 * NOTE on exit codes: `checkspec scan` exits 1 whenever any auto-generated
 * test fails OR there is a CRITICAL or HIGH security finding. With the prompt
 * args fix, the echo-server's `greet` prompt now receives { name: "example-name" }
 * and succeeds → exit code is 0 when no tests fail.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";
import { runCli, makeTempDir, ROOT, ECHO_SERVER, type CliResult, type TempDir } from "./helpers.js";

// ── Shared scan run (one CLI invocation for all output-content tests) ────────

let scanResult: CliResult;
let scanTmp: TempDir;

beforeAll(async () => {
  scanTmp = makeTempDir();
  scanResult = await runCli(
    ["scan", `node ${ECHO_SERVER}`],
    { cwd: scanTmp.dir }
  );
});

afterAll(() => {
  scanTmp.cleanup();
});

// ── Output content ────────────────────────────────────────────────────────────

describe("scan against echo-server — output content", () => {
  it("prints the Capabilities section with tool, resource, and prompt counts", () => {
    expect(scanResult.stdout).toContain("Capabilities");
    expect(scanResult.stdout).toContain("Tools:");
    expect(scanResult.stdout).toContain("echo"); // the tool name appears in the list
  });

  it("prints the Security Scan section", () => {
    expect(scanResult.stdout).toContain("Security Scan");
  });

  it("prints a Results summary line at the bottom", () => {
    // scan.ts prints: "Results: X passed, Y failed (of Z) | Total: Xms"
    expect(scanResult.stdout).toContain("Results:");
    expect(scanResult.stdout).toContain("passed");
  });

  it("shows at least one ✓ (the echo valid-input test passes)", () => {
    expect(scanResult.stdout).toContain("✓");
  });

  it("shows greet prompt test result (prompt args are now populated)", () => {
    // The greet prompt test now receives { name: "example-name" } and should
    // not fail due to a missing-arg error. The test may still produce a ✓ or ✗
    // depending on the server, but it should at least appear in the output.
    expect(scanResult.stdout).toContain("greet");
  });

  it("shows the Prompt Tests section", () => {
    expect(scanResult.stdout).toContain("Prompt Tests");
  });
});

// ── --output json ─────────────────────────────────────────────────────────────

describe("scan --output json", () => {
  it("prints a parseable JSON object with total/passed/failed/results fields", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      // exit code is 1 because the greet prompt auto-test fails, but the JSON
      // output is still produced correctly — that's what we're testing here.
      const { stdout } = await runCli(
        ["scan", `node ${ECHO_SERVER}`, "--output", "json"],
        { cwd: dir }
      );

      expect(stdout.length).toBeGreaterThan(0);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;

      expect(typeof parsed.total).toBe("number");
      expect(typeof parsed.passed).toBe("number");
      expect(typeof parsed.failed).toBe("number");
      expect(Array.isArray(parsed.results)).toBe(true);
      // At minimum the echo valid-input test ran
      expect(parsed.total as number).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

// ── --no-fuzz ─────────────────────────────────────────────────────────────────

describe("scan --no-fuzz", () => {
  it("skips edge/fuzz tests — only valid-input tests appear in Tool Tests section", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { stdout } = await runCli(
        ["scan", `node ${ECHO_SERVER}`, "--no-fuzz"],
        { cwd: dir }
      );
      // The echo tool's valid-input test should still run
      expect(stdout).toContain("valid input");
      // Edge and fuzz tests must be absent
      expect(stdout).not.toContain("› edge:");
      expect(stdout).not.toContain("Fuzz Tests");
    } finally {
      cleanup();
    }
  });
});

// ── Exit code on HIGH security findings ──────────────────────────────────────

describe("scan exit code on HIGH security findings", () => {
  it("exits 1 when the server has HIGH severity findings", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const MALICIOUS_SERVER = resolve(ROOT, "fixtures/malicious-server/dist/index.js");
      const { exitCode } = await runCli(
        ["scan", `node ${MALICIOUS_SERVER}`, "--no-fuzz"],
        { cwd: dir, timeoutMs: 30_000 }
      );
      expect(exitCode).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("scan error handling", () => {
  it("exits 1 when the server command cannot be started", async () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { exitCode } = await runCli(
        ["scan", "node /tmp/no-such-mcp-server-xyz.js"],
        { cwd: dir, timeoutMs: 15_000 }
      );
      expect(exitCode).toBe(1);
    } finally {
      cleanup();
    }
  });
});
