/**
 * Shared helpers for CLI integration tests.
 *
 * These tests spawn the compiled `packages/cli/dist/index.js` as a child
 * process and assert on stdout, stderr, and exit code — treating the CLI as a
 * black box, exactly as a user would.
 */
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the repository root. */
export const ROOT = resolve(__dirname, "../..");

/** Compiled CLI entry point. */
export const CLI = resolve(ROOT, "packages/cli/dist/index.js");

/** Compiled echo-server fixture. */
export const ECHO_SERVER = resolve(ROOT, "fixtures/echo-server/dist/index.js");

// ── CLI runner ────────────────────────────────────────────────────────────────

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn `node <CLI> ...args` and capture stdout / stderr / exit code.
 *
 * - `NO_COLOR=1` disables chalk so assertions work on plain text.
 * - Default timeout: 20 s (generous for slow CI machines).
 * - `cwd` defaults to `ROOT` (repo root). Pass `cwd: tmpDir` explicitly to
 *   prevent auto-saved files (recordings, HTML reports) from polluting the repo.
 */
export function runCli(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, ...args], {
      cwd: opts?.cwd ?? ROOT,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${opts?.timeoutMs ?? 20_000}ms`));
    }, opts?.timeoutMs ?? 20_000);

    child.on("close", (code: number | null) => {
      if (settled) return;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Temp-directory management ─────────────────────────────────────────────────

export interface TempDir {
  dir: string;
  cleanup: () => void;
}

/** Create a temporary directory. Call `cleanup()` in `afterAll`. */
export function makeTempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "checkspec-cli-test-"));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Write an object as JSON to `<dir>/<filename>` and return the full path. */
export function writeCollection(dir: string, filename: string, data: unknown): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// ── Collection factory ────────────────────────────────────────────────────────

export interface EchoCollectionOptions {
  /** Override the test ID (default: "echo-test"). */
  testId?: string;
  /** Override the test name (default: "echo › hello"). */
  testName?: string;
  /** Message sent to the echo tool (default: "hello"). */
  message?: string;
  /**
   * Expected substring in the response (default: same as `message`).
   * Pass something that will never appear to produce a failing test.
   */
  expectContains?: string;
  /** Tags array on the test case (default: none). */
  tags?: string[];
}

/**
 * Return a minimal collection object that runs the echo-server fixture.
 * The echo tool simply returns the message it was given, so the default
 * `expectContains` ("hello") will always pass.
 */
export function echoCollection(opts?: EchoCollectionOptions): object {
  const message = opts?.message ?? "hello";
  const expectContains = opts?.expectContains ?? message;

  return {
    version: "1.0",
    name: "CLI Integration Test",
    server: {
      command: "node",
      args: [ECHO_SERVER],
    },
    tests: [
      {
        id: opts?.testId ?? "echo-test",
        name: opts?.testName ?? "echo › hello",
        type: "tool-call",
        tool: "echo",
        input: { message },
        expect: {
          success: true,
          contains: expectContains,
        },
        ...(opts?.tags ? { tags: opts.tags } : {}),
      },
    ],
  };
}
