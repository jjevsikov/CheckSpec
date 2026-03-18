/**
 * Unit tests for concurrency in TestRunner.runCollection.
 *
 * Strategy: spy on `runTest` with a controlled delay, then verify execution
 * order via a shared log array.  With concurrency > 1 tests in the same
 * chunk start before any of them finishes; with concurrency = 1 they run
 * strictly serially.
 *
 * Run: npx vitest run packages/core/src/runner/concurrency.test.ts
 */
import { describe, it, expect, vi } from "vitest";
import { TestRunner } from "./TestRunner.js";
import type { TestResult } from "./TestRunner.js";
import type { TestCase, CheckSpecCollection } from "./TestCollection.js";
import type { MCPRecordingClient } from "../client/MCPRecordingClient.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeResult(id: string, passed = true): TestResult {
  return { testId: id, testName: id, passed, durationMs: 5 };
}

function makeCollection(
  testIds: string[],
  concurrency?: number
): CheckSpecCollection {
  return {
    version: "1.0",
    name: "Concurrency test",
    server: { command: "node", args: [] },
    tests: testIds.map((id) => ({
      id,
      name: id,
      type: "tool-call" as const,
      tool: "echo",
      input: {},
    })),
    ...(concurrency !== undefined ? { concurrency } : {}),
  } as CheckSpecCollection;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("concurrency", () => {
  it("default (concurrency=1) runs tests serially", async () => {
    const log: string[] = [];
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockImplementation(async (test) => {
      log.push(`start:${test.id}`);
      await sleep(30);
      log.push(`end:${test.id}`);
      return makeResult(test.id);
    });

    await runner.runCollection(makeCollection(["a", "b", "c"]));

    // Serial: each test starts after the previous one ends
    expect(log).toEqual([
      "start:a", "end:a",
      "start:b", "end:b",
      "start:c", "end:c",
    ]);
  });

  it("concurrency=3 runs all tests in the same chunk concurrently", async () => {
    const log: string[] = [];
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockImplementation(async (test) => {
      log.push(`start:${test.id}`);
      await sleep(30);
      log.push(`end:${test.id}`);
      return makeResult(test.id);
    });

    await runner.runCollection(makeCollection(["a", "b", "c"], 3));

    // Concurrent: all 3 start before any of them ends
    expect(log.slice(0, 3)).toEqual(["start:a", "start:b", "start:c"]);
    // All ends come after all starts
    expect(log.slice(3)).toEqual(expect.arrayContaining(["end:a", "end:b", "end:c"]));
  });

  it("concurrency=2 processes 4 tests in 2 chunks of 2", async () => {
    const log: string[] = [];
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockImplementation(async (test) => {
      log.push(`start:${test.id}`);
      await sleep(30);
      log.push(`end:${test.id}`);
      return makeResult(test.id);
    });

    await runner.runCollection(makeCollection(["a", "b", "c", "d"], 2));

    // Chunk 1: a and b start concurrently
    expect(log[0]).toBe("start:a");
    expect(log[1]).toBe("start:b");
    // Both end before chunk 2 starts
    const cStart = log.indexOf("start:c");
    const aEnd = log.indexOf("end:a");
    const bEnd = log.indexOf("end:b");
    expect(cStart).toBeGreaterThan(aEnd);
    expect(cStart).toBeGreaterThan(bEnd);
    // Chunk 2: c and d start concurrently
    expect(log[cStart + 1]).toBe("start:d");
  });

  it("bail stops launching new chunks after a failure", async () => {
    const runner = new TestRunner(makeMockClient(), { bail: true });
    vi.spyOn(runner, "runTest").mockImplementation(async (test) => {
      await sleep(10);
      // First test fails
      return makeResult(test.id, test.id !== "a");
    });

    const summary = await runner.runCollection(
      makeCollection(["a", "b", "c", "d"], 2)
    );

    // Chunk 1 runs both a and b (a fails, b passes)
    // Chunk 2 is skipped because bail is set
    expect(summary.results).toHaveLength(2);
    expect(summary.skipped).toBe(2);
  });

  it("concurrency works inside describe blocks", async () => {
    const log: string[] = [];
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockImplementation(async (test) => {
      log.push(`start:${test.id}`);
      await sleep(30);
      log.push(`end:${test.id}`);
      return makeResult(test.id);
    });

    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Describe concurrency",
      server: { command: "node", args: [] },
      describe: [{
        name: "group",
        tests: [
          { id: "g1", name: "g1", type: "tool-call", tool: "echo", input: {} },
          { id: "g2", name: "g2", type: "tool-call", tool: "echo", input: {} },
        ] as TestCase[],
      }],
      tests: [],
      concurrency: 2,
    } as CheckSpecCollection;

    await runner.runCollection(collection);

    // Both tests in the describe block start concurrently
    expect(log[0]).toBe("start:g1");
    expect(log[1]).toBe("start:g2");
  });

  it("total / passed / failed counts are correct with concurrency", async () => {
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockImplementation(async (test) => {
      return makeResult(test.id, test.id !== "b");
    });

    const summary = await runner.runCollection(
      makeCollection(["a", "b", "c"], 3)
    );

    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.results).toHaveLength(3);
  });

  it("concurrency=1 is equivalent to omitting concurrency", async () => {
    const log1: string[] = [];
    const runner1 = new TestRunner(makeMockClient());
    vi.spyOn(runner1, "runTest").mockImplementation(async (test) => {
      log1.push(`start:${test.id}`);
      await sleep(10);
      log1.push(`end:${test.id}`);
      return makeResult(test.id);
    });
    await runner1.runCollection(makeCollection(["a", "b"], 1));

    const log2: string[] = [];
    const runner2 = new TestRunner(makeMockClient());
    vi.spyOn(runner2, "runTest").mockImplementation(async (test) => {
      log2.push(`start:${test.id}`);
      await sleep(10);
      log2.push(`end:${test.id}`);
      return makeResult(test.id);
    });
    await runner2.runCollection(makeCollection(["a", "b"]));

    // Both produce the same serial order
    expect(log1).toEqual(log2);
    expect(log1).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("capture dependencies are respected with concurrency > 1", async () => {
    // Test A captures 'userId', test B consumes {{userId}}.
    // With concurrency=2 and naive chunking, A and B would be in the same
    // chunk and B might run before A captures. buildExecutionLayers must
    // put B in a later chunk than A.
    const log: string[] = [];
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockImplementation(async (test) => {
      log.push(`start:${test.id}`);
      await sleep(30);
      log.push(`end:${test.id}`);
      return makeResult(test.id);
    });

    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Capture dep test",
      server: { command: "node", args: [] },
      concurrency: 2,
      tests: [
        {
          id: "a",
          name: "a",
          type: "tool-call" as const,
          tool: "create_user",
          input: {},
          capture: { userId: "$.user.id" },
        },
        {
          id: "b",
          name: "b",
          type: "tool-call" as const,
          tool: "get_user",
          input: { id: "{{userId}}" },
        },
      ] as TestCase[],
    } as CheckSpecCollection;

    await runner.runCollection(collection);

    // A must start and end before B starts
    const aStart = log.indexOf("start:a");
    const aEnd = log.indexOf("end:a");
    const bStart = log.indexOf("start:b");

    expect(aStart).toBeLessThan(bStart);
    expect(aEnd).toBeLessThan(bStart);
  });

  it("independent tests still run concurrently even when capture deps exist", async () => {
    // Tests x and y are independent of each other (no capture deps between them).
    // Test z depends on x's capture. x and y should run in the same chunk;
    // z should run in a later chunk.
    const log: string[] = [];
    const runner = new TestRunner(makeMockClient());
    vi.spyOn(runner, "runTest").mockImplementation(async (test) => {
      log.push(`start:${test.id}`);
      await sleep(30);
      log.push(`end:${test.id}`);
      return makeResult(test.id);
    });

    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Independent concurrent + capture dep",
      server: { command: "node", args: [] },
      concurrency: 3,
      tests: [
        {
          id: "x",
          name: "x",
          type: "tool-call" as const,
          tool: "setup",
          input: {},
          capture: { token: "$.token" },
        },
        {
          id: "y",
          name: "y",
          type: "tool-call" as const,
          tool: "independent",
          input: {},
        },
        {
          id: "z",
          name: "z",
          type: "tool-call" as const,
          tool: "use_token",
          input: { auth: "{{token}}" },
        },
      ] as TestCase[],
    } as CheckSpecCollection;

    await runner.runCollection(collection);

    const xStart = log.indexOf("start:x");
    const yStart = log.indexOf("start:y");
    const xEnd = log.indexOf("end:x");
    const zStart = log.indexOf("start:z");

    // x and y start concurrently (both in layer 0)
    expect(Math.abs(xStart - yStart)).toBeLessThanOrEqual(1);
    // z only starts after x finishes
    expect(xEnd).toBeLessThan(zStart);
  });
});
