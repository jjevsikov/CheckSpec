/**
 * Unit tests for extractTemplateVars and buildExecutionLayers.
 *
 * Pure functions - no live server required.
 *
 * Run: ./node_modules/.bin/vitest run packages/core/src/runner/captureDeps.test.ts
 */
import { describe, it, expect } from "vitest";
import { extractTemplateVars, buildExecutionLayers } from "./captureDeps.js";
import type { TestCase, StreamingTestCase } from "./TestCollection.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTest(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "test-id",
    name: "Test Name",
    type: "tool-call",
    tool: "my_tool",
    input: {},
    ...overrides,
  };
}

function makeStreamingTest(overrides: Partial<StreamingTestCase> = {}): StreamingTestCase {
  return {
    id: "stream-id",
    name: "Streaming Test",
    type: "streaming-tool-call",
    tool: "stream_tool",
    input: {},
    streamExpect: { minChunks: 2 },
    ...overrides,
  };
}

// ── extractTemplateVars ───────────────────────────────────────────────────────

describe("extractTemplateVars", () => {
  it("returns empty set for test with no templates", () => {
    const test = makeTest({ input: { x: 1, y: "hello" } });
    expect(extractTemplateVars(test).size).toBe(0);
  });

  it("extracts vars from input", () => {
    const test = makeTest({ input: { id: "{{userId}}" } });
    expect(extractTemplateVars(test)).toEqual(new Set(["userId"]));
  });

  it("extracts vars from expect.contains", () => {
    const test = makeTest({
      expect: { contains: "hello {{userName}}" },
    });
    expect(extractTemplateVars(test)).toEqual(new Set(["userName"]));
  });

  it("extracts vars from expect.equals", () => {
    const test = makeTest({
      expect: { equals: "{{expectedResult}}" },
    });
    expect(extractTemplateVars(test)).toEqual(new Set(["expectedResult"]));
  });

  it("extracts vars from uri", () => {
    const test = makeTest({ type: "resource-read", uri: "resource://{{resourceId}}/data" });
    expect(extractTemplateVars(test)).toEqual(new Set(["resourceId"]));
  });

  it("extracts vars from promptArgs", () => {
    const test = makeTest({
      type: "prompt-get",
      promptArgs: { greeting: "Hello {{firstName}}" },
    });
    expect(extractTemplateVars(test)).toEqual(new Set(["firstName"]));
  });

  it("extracts vars from nested input objects", () => {
    const test = makeTest({
      input: {
        user: { id: "{{userId}}", role: "{{userRole}}" },
        metadata: { token: "{{authToken}}" },
      },
    });
    expect(extractTemplateVars(test)).toEqual(
      new Set(["userId", "userRole", "authToken"])
    );
  });

  it("extracts multiple vars from a single string", () => {
    const test = makeTest({
      input: { message: "{{greeting}} {{firstName}} {{lastName}}" },
    });
    expect(extractTemplateVars(test)).toEqual(
      new Set(["greeting", "firstName", "lastName"])
    );
  });

  it("extracts vars from expect.notContains and expect.matches", () => {
    const test = makeTest({
      expect: {
        notContains: "{{badValue}}",
        matches: "^{{prefix}}.*",
      },
    });
    expect(extractTemplateVars(test)).toEqual(new Set(["badValue", "prefix"]));
  });

  it("extracts vars from expect.jsonPath entries", () => {
    const test = makeTest({
      expect: {
        jsonPath: [
          { path: "$.id", equals: "{{expectedId}}" },
          { path: "$.name", contains: "{{nameFragment}}" },
        ],
      },
    });
    expect(extractTemplateVars(test)).toEqual(
      new Set(["expectedId", "nameFragment"])
    );
  });

  it("de-duplicates vars that appear multiple times", () => {
    const test = makeTest({
      input: { a: "{{userId}}", b: "{{userId}}" },
      expect: { contains: "{{userId}}" },
    });
    const vars = extractTemplateVars(test);
    expect(vars.size).toBe(1);
    expect(vars.has("userId")).toBe(true);
  });
});

// ── buildExecutionLayers ─────────────────────────────────────────────────────

describe("buildExecutionLayers", () => {
  it("empty array returns empty", () => {
    expect(buildExecutionLayers([], 2)).toEqual([]);
  });

  it("no capture fields: returns same chunking as naive approach", () => {
    const tests = [
      makeTest({ id: "a", name: "a" }),
      makeTest({ id: "b", name: "b" }),
      makeTest({ id: "c", name: "c" }),
      makeTest({ id: "d", name: "d" }),
    ];
    const chunks = buildExecutionLayers(tests, 2);
    // Naive: [a,b], [c,d]
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[0]!.map((t) => t.id)).toEqual(["a", "b"]);
    expect(chunks[1]!.map((t) => t.id)).toEqual(["c", "d"]);
  });

  it("concurrency=1 returns one test per chunk", () => {
    const tests = [
      makeTest({ id: "a", name: "a" }),
      makeTest({ id: "b", name: "b" }),
      makeTest({ id: "c", name: "c" }),
    ];
    const chunks = buildExecutionLayers(tests, 1);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c[0]?.id)).toEqual(["a", "b", "c"]);
  });

  it("simple A->B chain: A in first chunk, B in second", () => {
    // A captures userId, B consumes {{userId}}
    const testA = makeTest({
      id: "a", name: "a",
      capture: { userId: "$.user.id" },
    });
    const testB = makeTest({
      id: "b", name: "b",
      input: { id: "{{userId}}" },
    });
    const chunks = buildExecutionLayers([testA, testB], 2);
    // A has no deps (layer 0), B depends on A (layer 1)
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.map((t) => t.id)).toEqual(["a"]);
    expect(chunks[1]!.map((t) => t.id)).toEqual(["b"]);
  });

  it("transitive A->B->C: three layers", () => {
    const testA = makeTest({
      id: "a", name: "a",
      capture: { step1: "$.result" },
    });
    const testB = makeTest({
      id: "b", name: "b",
      input: { prev: "{{step1}}" },
      capture: { step2: "$.result" },
    });
    const testC = makeTest({
      id: "c", name: "c",
      input: { prev: "{{step2}}" },
    });
    const chunks = buildExecutionLayers([testA, testB, testC], 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.map((t) => t.id)).toEqual(["a"]);
    expect(chunks[1]!.map((t) => t.id)).toEqual(["b"]);
    expect(chunks[2]!.map((t) => t.id)).toEqual(["c"]);
  });

  it("independent tests are packed into the same layer/chunk", () => {
    // a and b are independent (no capture deps)
    // c depends on a
    const testA = makeTest({
      id: "a", name: "a",
      capture: { fromA: "$.id" },
    });
    const testB = makeTest({ id: "b", name: "b" });
    const testC = makeTest({
      id: "c", name: "c",
      input: { x: "{{fromA}}" },
    });
    const chunks = buildExecutionLayers([testA, testB, testC], 3);
    // Layer 0: a and b (both have no deps) -> one chunk of 2
    // Layer 1: c -> one chunk of 1
    expect(chunks).toHaveLength(2);
    // a and b should be in the same chunk (layer 0)
    const firstChunkIds = chunks[0]!.map((t) => t.id).sort();
    expect(firstChunkIds).toEqual(["a", "b"]);
    expect(chunks[1]!.map((t) => t.id)).toEqual(["c"]);
  });

  it("independent tests still respect concurrency size within a layer", () => {
    // 4 independent tests (no capture) with concurrency=2
    const tests = [
      makeTest({ id: "a", name: "a" }),
      makeTest({ id: "b", name: "b" }),
      makeTest({ id: "c", name: "c" }),
      makeTest({ id: "d", name: "d" }),
    ];
    const chunks = buildExecutionLayers(tests, 2);
    // All in layer 0, split into 2 chunks of 2
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[1]).toHaveLength(2);
  });

  it("consumer of hook-produced variable (not test-produced) is freely schedulable", () => {
    // userId is used via template but not produced by any test (it comes from a beforeAll hook)
    const testA = makeTest({
      id: "a", name: "a",
      input: { id: "{{userId}}" },
    });
    const testB = makeTest({
      id: "b", name: "b",
      input: { token: "{{authToken}}" },
    });
    // No test has capture -> naiveChunks path with concurrency=2
    const chunks = buildExecutionLayers([testA, testB], 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("circular dependency throws Error with descriptive message", () => {
    // A captures from B, B captures from A -> circular
    const testA = makeTest({
      id: "a", name: "testA",
      input: { x: "{{fromB}}" },
      capture: { fromA: "$.result" },
    });
    const testB = makeTest({
      id: "b", name: "testB",
      input: { x: "{{fromA}}" },
      capture: { fromB: "$.result" },
    });
    expect(() => buildExecutionLayers([testA, testB], 2)).toThrow(
      /[Cc]ircular/
    );
  });

  it("mixed: some tests with deps, some without, correct layering", () => {
    // independent1, independent2 have no deps
    // producer captures something
    // consumer depends on producer
    const independent1 = makeTest({ id: "i1", name: "i1" });
    const independent2 = makeTest({ id: "i2", name: "i2" });
    const producer = makeTest({
      id: "p", name: "p",
      capture: { token: "$.token" },
    });
    const consumer = makeTest({
      id: "c", name: "c",
      input: { auth: "{{token}}" },
    });
    const chunks = buildExecutionLayers(
      [independent1, independent2, producer, consumer],
      4
    );
    // Layer 0: i1, i2, p (no deps) -> one chunk (concurrency=4 fits all)
    // Layer 1: c -> one chunk
    expect(chunks).toHaveLength(2);
    const layer0Ids = chunks[0]!.map((t) => t.id).sort();
    expect(layer0Ids).toEqual(["i1", "i2", "p"]);
    expect(chunks[1]!.map((t) => t.id)).toEqual(["c"]);
  });

  it("streaming test with capture dep is handled correctly", () => {
    // A (tool-call) captures something, B (streaming) consumes it
    const testA = makeTest({
      id: "a", name: "a",
      capture: { streamId: "$.id" },
    });
    const testB = makeStreamingTest({
      id: "b", name: "b",
      input: { id: "{{streamId}}" },
    });
    const chunks = buildExecutionLayers([testA, testB], 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.map((t) => t.id)).toEqual(["a"]);
    expect(chunks[1]!.map((t) => t.id)).toEqual(["b"]);
  });

  it("single test with no deps returns one chunk", () => {
    const test = makeTest({ id: "solo", name: "solo" });
    const chunks = buildExecutionLayers([test], 5);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.map((t) => t.id)).toEqual(["solo"]);
  });

  it("diamond: D depends on both B (layer 1) and C (layer 0)", () => {
    // A captures x, B consumes x + captures y, C captures z, D consumes y + z
    const testA = { id: "a", name: "a", type: "tool-call", tool: "t", input: {}, capture: { x: "$.x" } };
    const testB = { id: "b", name: "b", type: "tool-call", tool: "t", input: { v: "{{x}}" }, capture: { y: "$.y" } };
    const testC = { id: "c", name: "c", type: "tool-call", tool: "t", input: {}, capture: { z: "$.z" } };
    const testD = { id: "d", name: "d", type: "tool-call", tool: "t", input: { a: "{{y}}", b: "{{z}}" } };
    const chunks = buildExecutionLayers([testA, testB, testC, testD] as any, 4);
    // A and C: layer 0, B: layer 1, D: layer 2
    expect(chunks).toHaveLength(3);
    // Layer 0: A and C
    const layer0Ids = chunks[0]!.map((t: any) => t.id).sort();
    expect(layer0Ids).toEqual(["a", "c"]);
    // Layer 1: B
    expect(chunks[1]!.map((t: any) => t.id)).toEqual(["b"]);
    // Layer 2: D
    expect(chunks[2]!.map((t: any) => t.id)).toEqual(["d"]);
  });
});
