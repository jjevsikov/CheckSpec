/**
 * Integration tests for `checkspec init`.
 *
 * Each test spawns the compiled CLI as a child process and asserts on the
 * generated .checkspec.json file, stdout, and exit code.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { runCli, makeTempDir, ECHO_SERVER } from "./helpers.js";
import type { TempDir } from "./helpers.js";

/** Server command string that points to the built echo fixture. */
const ECHO_CMD = `node ${ECHO_SERVER}`;

describe("checkspec init", () => {
  let tmp: TempDir;

  beforeAll(() => {
    tmp = makeTempDir();
  });

  afterAll(() => {
    tmp.cleanup();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("exits 0 and creates the output file", async () => {
    const outFile = join(tmp.dir, "echo.checkspec.json");
    const result = await runCli(
      ["init", ECHO_CMD, "--out", outFile],
      { cwd: tmp.dir }
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
  });

  it("generates valid JSON in the output file", async () => {
    const outFile = join(tmp.dir, "echo2.checkspec.json");
    await runCli(["init", ECHO_CMD, "--out", outFile], { cwd: tmp.dir });

    const raw = readFileSync(outFile, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("output file has correct collection shape", async () => {
    const outFile = join(tmp.dir, "echo3.checkspec.json");
    await runCli(["init", ECHO_CMD, "--out", outFile], { cwd: tmp.dir });

    const collection = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(collection).toMatchObject({
      version: "1.0",
      name: expect.any(String),
      server: expect.objectContaining({ command: "node" }),
      tests: expect.any(Array),
    });
  });

  it("generates at least one test per tool/resource/prompt plus protocol", async () => {
    // echo-server has: 1 tool (echo), 1 resource (version://info), 1 prompt (greet)
    // + 1 protocol test = 4 total
    const outFile = join(tmp.dir, "echo4.checkspec.json");
    await runCli(["init", ECHO_CMD, "--out", outFile], { cwd: tmp.dir });

    const collection = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(collection.tests.length).toBeGreaterThanOrEqual(4);

    const types = collection.tests.map((t: { type: string }) => t.type);
    expect(types).toContain("protocol");
    expect(types).toContain("tool-call");
    expect(types).toContain("resource-read");
    expect(types).toContain("prompt-get");
  });

  it("prints a success message with the output file name", async () => {
    const outFile = join(tmp.dir, "echo5.checkspec.json");
    const result = await runCli(
      ["init", ECHO_CMD, "--out", outFile],
      { cwd: tmp.dir }
    );
    expect(result.stdout).toMatch(/Created.*\.checkspec\.json/);
    expect(result.stdout).toMatch(/checkspec test/);
  });

  it("--name sets the collection name", async () => {
    const outFile = join(tmp.dir, "named.checkspec.json");
    await runCli(
      ["init", ECHO_CMD, "--out", outFile, "--name", "My Echo Server"],
      { cwd: tmp.dir }
    );

    const collection = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(collection.name).toBe("My Echo Server");
  });

  it("default output path is derived from server command", async () => {
    // "node .../index.js" → "index.checkspec.json" in the cwd
    const result = await runCli(
      ["init", ECHO_CMD],
      { cwd: tmp.dir }
    );
    expect(result.exitCode).toBe(0);
    // The derived filename "index.checkspec.json" must exist in the cwd
    expect(existsSync(join(tmp.dir, "index.checkspec.json"))).toBe(true);
  });

  // ── Error cases ───────────────────────────────────────────────────────────

  it("exits 1 if output file already exists (without --force)", async () => {
    const outFile = join(tmp.dir, "duplicate.checkspec.json");
    // First call creates it
    await runCli(["init", ECHO_CMD, "--out", outFile], { cwd: tmp.dir });
    // Second call should fail
    const result = await runCli(
      ["init", ECHO_CMD, "--out", outFile],
      { cwd: tmp.dir }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/already exists/);
  });

  it("--force overwrites an existing file", async () => {
    const outFile = join(tmp.dir, "force.checkspec.json");
    // Create first
    await runCli(["init", ECHO_CMD, "--out", outFile], { cwd: tmp.dir });
    // Overwrite with --force
    const result = await runCli(
      ["init", ECHO_CMD, "--out", outFile, "--force"],
      { cwd: tmp.dir }
    );
    expect(result.exitCode).toBe(0);
  });

  it("echo tool test has expect: { success: true } (no ID-reference fields)", async () => {
    // echo(message: string) — no ID fields → should have success assertion
    const outFile = join(tmp.dir, "echo-success.checkspec.json");
    await runCli(["init", ECHO_CMD, "--out", outFile], { cwd: tmp.dir });

    const collection = JSON.parse(readFileSync(outFile, "utf-8"));
    const echoTest = collection.tests.find(
      (t: { tool?: string }) => t.tool === "echo"
    );
    expect(echoTest).toBeDefined();
    expect(echoTest.expect).toMatchObject({ success: true });
  });

  it("greet prompt test has promptArgs filled in", async () => {
    // greet prompt has required arg 'name' — should be populated
    const outFile = join(tmp.dir, "echo-prompt-args.checkspec.json");
    await runCli(["init", ECHO_CMD, "--out", outFile], { cwd: tmp.dir });

    const collection = JSON.parse(readFileSync(outFile, "utf-8"));
    const promptTest = collection.tests.find(
      (t: { type: string; promptName?: string }) =>
        t.type === "prompt-get" && t.promptName === "greet"
    );
    expect(promptTest).toBeDefined();
    expect(promptTest.promptArgs).toBeDefined();
    expect(typeof promptTest.promptArgs.name).toBe("string");
    expect(promptTest.promptArgs.name.length).toBeGreaterThan(0);
  });

  it("exits 1 with error message for unreachable server", async () => {
    const outFile = join(tmp.dir, "unreachable.checkspec.json");
    const result = await runCli(
      ["init", "node /nonexistent/server.js", "--out", outFile],
      { cwd: tmp.dir, timeoutMs: 10_000 }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/Error|error|could not connect/i);
  });
});
