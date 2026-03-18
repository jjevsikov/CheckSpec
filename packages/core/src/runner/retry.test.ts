/**
 * Unit tests for the retry logic in TestRunner.executeWithRetry.
 *
 * Strategy: spy on the public `runTest` method so we can control pass/fail
 * per attempt without spinning up a real MCP server.
 * Run: npx vitest run packages/core/src/runner/retry.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TestRunner } from "./TestRunner.js";
import type { TestResult } from "./TestRunner.js";
import type { TestCase, CheckSpecCollection } from "./TestCollection.js";
import { validateCollection } from "../schema/collectionSchema.js";
import type { MCPRecordingClient } from "../client/MCPRecordingClient.js";

// ── Minimal mock client (not used directly — runTest is spied on) ──────────

function makeMockClient(): MCPRecordingClient {
  return {
    callTool: vi.fn(),
    listTools: vi.fn(async () => []),
    listResources: vi.fn(async () => []),
    readResource: vi.fn(),
    listPrompts: vi.fn(async () => []),
    getPrompt: vi.fn(),
    getRecording: vi.fn(() => []),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as MCPRecordingClient;
}

// ── TestResult factories ───────────────────────────────────────────────────

function makePassResult(testId = "t1", testName = "test"): TestResult {
  return { testId, testName, passed: true, durationMs: 5 };
}

function makeFailResult(testId = "t1", testName = "test"): TestResult {
  return { testId, testName, passed: false, durationMs: 5, error: "assertion failed" };
}

// ── Collection helpers ─────────────────────────────────────────────────────

function makeCollection(overrides: Partial<TestCase> = {}): CheckSpecCollection {
  return {
    version: "1.0",
    name: "Retry unit test",
    server: { command: "node", args: ["dist/index.js"] },
    tests: [
      {
        id: "t1",
        name: "test",
        type: "tool-call",
        tool: "add",
        input: {},
        ...overrides,
      } as TestCase,
    ],
  } as CheckSpecCollection;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("retry: 0 (default — no retry)", () => {
  it("calls runTest exactly once and returns result as-is (no retry fields)", async () => {
    const runner = new TestRunner(makeMockClient());
    const spy = vi.spyOn(runner, "runTest").mockResolvedValue(makePassResult());

    const summary = await runner.runCollection(makeCollection());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(summary.results[0].passed).toBe(true);
    expect(summary.results[0].retryCount).toBeUndefined();
    expect(summary.results[0].retryExhausted).toBeUndefined();
  });

  it("returns the failure result as-is (no retry fields) on failure with retry: 0", async () => {
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockResolvedValue(makeFailResult());

    const summary = await runner.runCollection(makeCollection());

    expect(summary.results[0].passed).toBe(false);
    expect(summary.results[0].retryCount).toBeUndefined();
    expect(summary.results[0].retryExhausted).toBeUndefined();
  });
});

describe("retry: 2 — passes on first attempt", () => {
  it("calls runTest once; result has no retry annotation", async () => {
    const runner = new TestRunner(makeMockClient());
    const spy = vi.spyOn(runner, "runTest").mockResolvedValue(makePassResult());

    const summary = await runner.runCollection(makeCollection({ retry: 2 }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(summary.results[0].passed).toBe(true);
    // First-attempt pass: retryCount not set (no retries consumed)
    expect(summary.results[0].retryCount).toBeUndefined();
    expect(summary.results[0].retryExhausted).toBeUndefined();
  });
});

describe("retry: 2 — passes on attempt 2", () => {
  it("calls runTest twice; result has retryCount:1, retryExhausted:false", async () => {
    const runner = new TestRunner(makeMockClient());
    const spy = vi.spyOn(runner, "runTest")
      .mockResolvedValueOnce(makeFailResult())  // attempt 1 fails
      .mockResolvedValueOnce(makePassResult()); // attempt 2 passes

    const summary = await runner.runCollection(
      makeCollection({ retry: 2, retryDelayMs: 0 })
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(summary.results[0].passed).toBe(true);
    expect(summary.results[0].retryCount).toBe(1);
    expect(summary.results[0].retryExhausted).toBe(false);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
  });
});

describe("retry: 2 — fails all 3 attempts", () => {
  it("calls runTest 3 times; result has retryCount:2, retryExhausted:true", async () => {
    const runner = new TestRunner(makeMockClient());
    const spy = vi.spyOn(runner, "runTest")
      .mockResolvedValueOnce(makeFailResult())
      .mockResolvedValueOnce(makeFailResult())
      .mockResolvedValueOnce(makeFailResult());

    const summary = await runner.runCollection(
      makeCollection({ retry: 2, retryDelayMs: 0 })
    );

    expect(spy).toHaveBeenCalledTimes(3);
    expect(summary.results[0].passed).toBe(false);
    expect(summary.results[0].retryCount).toBe(2);
    expect(summary.results[0].retryExhausted).toBe(true);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(1);
  });
});

describe("retry: 1 — delay between attempts", () => {
  it("waits at least retryDelayMs=100ms between the two attempts", async () => {
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest")
      .mockResolvedValueOnce(makeFailResult()) // attempt 1 fails → triggers delay
      .mockResolvedValueOnce(makePassResult()); // attempt 2 passes

    const start = Date.now();
    await runner.runCollection(makeCollection({ retry: 1, retryDelayMs: 100 }));
    const elapsed = Date.now() - start;

    // Must have waited at least 100ms for the inter-attempt sleep
    expect(elapsed).toBeGreaterThanOrEqual(90); // allow minor clock skew
  });
});

describe("retry: 1 — no delay on final failure", () => {
  it("does NOT sleep after the last failed attempt", async () => {
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest")
      .mockResolvedValueOnce(makeFailResult())
      .mockResolvedValueOnce(makeFailResult());

    const start = Date.now();
    await runner.runCollection(makeCollection({ retry: 1, retryDelayMs: 200 }));
    const elapsed = Date.now() - start;

    // Only 1 delay between attempt 1 and 2; no delay after final failure
    // So elapsed should be ~200ms, NOT ~400ms
    expect(elapsed).toBeLessThan(380);
  });
});

// ── Zod schema validation for retry fields ────────────────────────────────

describe("Zod schema: retry field validation", () => {
  const minimalCollection = (retryValue: unknown) => ({
    version: "1.0",
    name: "Test",
    server: { command: "node", args: ["dist/index.js"] },
    tests: [
      { id: "t1", name: "t", type: "tool-call", tool: "add", input: {}, retry: retryValue },
    ],
  });

  it("rejects retry: 6 with 'less than or equal to 5' in the error", () => {
    const result = validateCollection(minimalCollection(6));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.message).toContain("less than or equal to 5");
  });

  it("rejects retry: 10 with 'less than or equal to 5' in the error", () => {
    const result = validateCollection(minimalCollection(10));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.message).toContain("less than or equal to 5");
  });

  it("rejects retry: -1 (below minimum)", () => {
    const result = validateCollection(minimalCollection(-1));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    // Zod min(0) message: "Number must be greater than or equal to 0"
    expect(result.message.toLowerCase()).toMatch(/greater than or equal|retry/);
  });

  it("accepts retry: 0 (minimum boundary)", () => {
    const result = validateCollection(minimalCollection(0));
    expect(result.success).toBe(true);
  });

  it("accepts retry: 5 (maximum boundary)", () => {
    const result = validateCollection(minimalCollection(5));
    expect(result.success).toBe(true);
  });

  it("accepts retry: 3 and retryDelayMs: 250", () => {
    const result = validateCollection({
      version: "1.0",
      name: "Test",
      server: { command: "node" },
      tests: [
        {
          id: "t1",
          name: "t",
          type: "tool-call",
          tool: "add",
          input: {},
          retry: 3,
          retryDelayMs: 250,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects retryDelayMs: -100 (below minimum 0)", () => {
    const result = validateCollection({
      version: "1.0",
      name: "Test",
      server: { command: "node" },
      tests: [
        { id: "t1", name: "t", type: "tool-call", tool: "add", input: {}, retryDelayMs: -100 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ── Bail interaction ───────────────────────────────────────────────────────

describe("retry interacts correctly with bail option", () => {
  it("respects bail after all retry attempts fail", async () => {
    const runner = new TestRunner(makeMockClient(), { bail: true });
    const spy = vi.spyOn(runner, "runTest")
      .mockResolvedValue(makeFailResult());

    // Collection has 2 tests; first exhausts retries, bail should stop second
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Bail test",
      server: { command: "node" },
      tests: [
        { id: "t1", name: "first",  type: "tool-call", tool: "x", input: {}, retry: 1, retryDelayMs: 0 } as TestCase,
        { id: "t2", name: "second", type: "tool-call", tool: "x", input: {} } as TestCase,
      ],
    } as CheckSpecCollection;

    const summary = await runner.runCollection(collection);

    // First test: 2 attempts (retry: 1); second test: never runs (bail)
    expect(spy).toHaveBeenCalledTimes(2);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].retryExhausted).toBe(true);
  });
});

// ── Transport error propagation ─────────────────────────────────────────

describe("retry does NOT catch thrown errors (transport/crash)", () => {
  it("re-throws immediately when runTest throws an Error instead of returning { passed: false }", async () => {
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockRejectedValue(new Error("EPIPE: broken pipe"));

    const collection = makeCollection({ retry: 2, retryDelayMs: 0 });

    // The error should propagate — executeWithRetry doesn't catch thrown errors,
    // only assertion failures (result.passed === false). This means transport
    // crashes are never silently retried.
    await expect(runner.runCollection(collection)).rejects.toThrow("EPIPE");

    // Only called once — the transport error is not retried
    expect(runner.runTest).toHaveBeenCalledTimes(1);
  });
});

// ── Transport error classification ───────────────────────────────────────
// runTest catches ALL errors and returns { passed: false, error: msg }.
// executeWithRetry must detect transport-error patterns and NOT retry them.

function makeTransportResult(error: string): TestResult {
  return { testId: "t1", testName: "test", passed: false, durationMs: 5, error };
}

describe("transport error classification: no retry on transport failures", () => {
  const transportErrors = [
    "Connection closed",
    "connection closed unexpectedly",
    "EPIPE: broken pipe, write",
    "write EPIPE",
    "read ECONNRESET",
    "connection reset by peer",
    "socket hang up",
    "EOF",
    "unexpected EOF",
    "spawn enoent /usr/local/bin/my-server",
  ];

  for (const errorMsg of transportErrors) {
    it(`bails after 1 attempt for error: "${errorMsg}"`, async () => {
      const runner = new TestRunner(makeMockClient());
      const spy = vi.spyOn(runner, "runTest")
        .mockResolvedValue(makeTransportResult(errorMsg));

      const summary = await runner.runCollection(
        makeCollection({ retry: 2, retryDelayMs: 0 })
      );

      // Must NOT retry — only 1 call regardless of retry: 2
      expect(spy).toHaveBeenCalledTimes(1);
      expect(summary.results[0].passed).toBe(false);
    });
  }

  it("does NOT treat 'eof' substring in non-transport errors as transport failure", async () => {
    // "Geoffrey" contains "eof" — must NOT be classified as a transport error
    const runner = new TestRunner(makeMockClient());
    const spy = vi.spyOn(runner, "runTest")
      .mockResolvedValueOnce(makeTransportResult("Expected 'Geoffrey' but got 'Bob'"))
      .mockResolvedValueOnce(makePassResult());

    const summary = await runner.runCollection(
      makeCollection({ retry: 1, retryDelayMs: 0 })
    );

    // Should retry because this is NOT a transport error
    expect(spy).toHaveBeenCalledTimes(2);
    expect(summary.results[0].passed).toBe(true);
  });

  it("reports accurate retryCount when bailing on transport error (attempt 1)", async () => {
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest")
      .mockResolvedValue(makeTransportResult("Connection closed"));

    const summary = await runner.runCollection(
      makeCollection({ retry: 2, retryDelayMs: 0 })
    );

    // Bailed on first attempt — retryCount should be 0 (no retries consumed)
    expect(summary.results[0].retryCount).toBe(0);
    expect(summary.results[0].retryExhausted).toBe(true);
  });

  it("still retries a normal assertion failure", async () => {
    const runner = new TestRunner(makeMockClient());
    const spy = vi.spyOn(runner, "runTest")
      .mockResolvedValueOnce(makeFailResult())
      .mockResolvedValueOnce(makePassResult());

    const summary = await runner.runCollection(
      makeCollection({ retry: 1, retryDelayMs: 0 })
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(summary.results[0].passed).toBe(true);
  });
});

// ── Hook isolation with retries ─────────────────────────────────────────

describe("hooks run once per test, not once per retry attempt", () => {
  it("beforeEach runs exactly once even when a test retries 2 times", async () => {
    const mockClient = makeMockClient();
    const runner = new TestRunner(mockClient);

    // First attempt fails, second passes
    vi.spyOn(runner, "runTest")
      .mockResolvedValueOnce(makeFailResult())
      .mockResolvedValueOnce(makePassResult());

    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Hook isolation test",
      server: { command: "node" },
      hooks: {
        beforeEach: [{
          name: "count me",
          run: { type: "tool-call", tool: "ping", input: {} },
        }],
        afterEach: [{
          name: "count me too",
          run: { type: "tool-call", tool: "cleanup", input: {} },
        }],
      },
      tests: [
        { id: "t1", name: "retrying test", type: "tool-call", tool: "x", input: {}, retry: 2, retryDelayMs: 0 } as TestCase,
      ],
    } as CheckSpecCollection;

    const summary = await runner.runCollection(collection);

    // callTool is used by hooks (beforeEach calls "ping", afterEach calls "cleanup")
    // With retry:2, test runs twice. But hooks should run only once each.
    const hookCalls = (mockClient.callTool as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    const beforeEachCalls = hookCalls.filter((args) => args[0] === "ping");
    const afterEachCalls = hookCalls.filter((args) => args[0] === "cleanup");

    expect(beforeEachCalls).toHaveLength(1);
    expect(afterEachCalls).toHaveLength(1);
    expect(summary.results[0].passed).toBe(true);
    expect(summary.results[0].retryCount).toBe(1);
  });
});
