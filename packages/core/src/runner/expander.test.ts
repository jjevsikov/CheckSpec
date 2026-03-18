/**
 * Unit tests for expandParametrizedTests and countParametrizedSources.
 *
 * Pure function — no live server required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { expandParametrizedTests, countParametrizedSources } from "./expander.js";
import type { TestCase, StreamingTestCase } from "./TestCollection.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToolCallTest(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "test-id",
    name: "Test Name",
    type: "tool-call",
    tool: "my_tool",
    input: { x: 1 },
    expect: { success: true },
    ...overrides,
  };
}

function makeStreamingTest(overrides: Partial<StreamingTestCase> = {}): StreamingTestCase {
  return {
    id: "stream-id",
    name: "Streaming Test",
    type: "streaming-tool-call",
    tool: "stream_tool",
    input: { q: "hello" },
    streamExpect: { minChunks: 2 },
    ...overrides,
  };
}

// ── expandParametrizedTests ──────────────────────────────────────────────────

describe("expandParametrizedTests", () => {
  it("passes through tests without parametrize unchanged", () => {
    const test = makeToolCallTest();
    const result = expandParametrizedTests([test]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(test); // same reference
  });

  it("expands a test with two rows into two tests", () => {
    const test = makeToolCallTest({
      parametrize: [
        { label: "row A", input: { x: 10 } },
        { label: "row B", input: { x: 20 } },
      ],
    });
    const result = expandParametrizedTests([test]);
    expect(result).toHaveLength(2);
  });

  it("uses indexed id format: base-id[0], base-id[1]", () => {
    const test = makeToolCallTest({
      id: "my-test",
      parametrize: [
        { label: "first", input: { x: 1 } },
        { label: "second", input: { x: 2 } },
      ],
    });
    const result = expandParametrizedTests([test]);
    expect(result[0].id).toBe("my-test[0]");
    expect(result[1].id).toBe("my-test[1]");
  });

  it("appends [case: label] to the test name", () => {
    const test = makeToolCallTest({
      name: "add tool",
      parametrize: [{ label: "positive", input: { a: 1 } }],
    });
    const result = expandParametrizedTests([test]);
    expect(result[0].name).toBe("add tool [case: positive]");
  });

  it("merges row input over base input (row wins on conflict)", () => {
    const test = makeToolCallTest({
      input: { a: 1, b: 2 },
      parametrize: [{ label: "override b", input: { b: 99 } }],
    });
    const result = expandParametrizedTests([test]);
    expect((result[0] as TestCase).input).toEqual({ a: 1, b: 99 });
  });

  it("merges row expect over base expect when row.expect is provided", () => {
    const test = makeToolCallTest({
      expect: { success: true, contains: "foo" },
      parametrize: [{ label: "override contains", input: {}, expect: { contains: "bar" } }],
    });
    const result = expandParametrizedTests([test]);
    expect((result[0] as TestCase).expect).toEqual({ success: true, contains: "bar" });
  });

  it("does not modify expect when row.expect is absent", () => {
    const test = makeToolCallTest({
      expect: { success: true },
      parametrize: [{ label: "no expect override", input: { x: 5 } }],
    });
    const result = expandParametrizedTests([test]);
    expect((result[0] as TestCase).expect).toEqual({ success: true });
  });

  it("does not include parametrize key in expanded tests", () => {
    const test = makeToolCallTest({
      parametrize: [{ label: "only row", input: {} }],
    });
    const result = expandParametrizedTests([test]);
    expect("parametrize" in result[0]).toBe(false);
  });

  it("drops tests with empty parametrize array and emits console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const test = makeToolCallTest({ name: "empty-param", parametrize: [] });
    const result = expandParametrizedTests([test]);
    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty-param")
    );
    warnSpy.mockRestore();
  });

  it("expands streaming tests with streamExpect merge", () => {
    const test = makeStreamingTest({
      streamExpect: { minChunks: 2, maxTotalMs: 5000 },
      parametrize: [
        {
          label: "higher chunk count",
          input: { q: "complex" },
          streamExpect: { minChunks: 5 },
        },
      ],
    });
    const result = expandParametrizedTests([test]);
    expect(result).toHaveLength(1);
    expect((result[0] as StreamingTestCase).streamExpect).toEqual({
      minChunks: 5,
      maxTotalMs: 5000,
    });
  });

  it("handles base test with no input field — row input becomes the full input", () => {
    const test: TestCase = {
      id: "no-base-input",
      name: "no input test",
      type: "tool-call",
      tool: "my_tool",
      // input intentionally omitted
      parametrize: [{ label: "row only", input: { x: 99 } }],
    };
    const result = expandParametrizedTests([test]);
    expect(result).toHaveLength(1);
    expect((result[0] as TestCase).input).toEqual({ x: 99 });
  });

  it("handles multiple tests — both parametrized and plain — in one call", () => {
    const plain = makeToolCallTest({ id: "plain", name: "plain test" });
    const parametrized = makeToolCallTest({
      id: "param",
      name: "param test",
      parametrize: [
        { label: "A", input: { x: 1 } },
        { label: "B", input: { x: 2 } },
        { label: "C", input: { x: 3 } },
      ],
    });
    const result = expandParametrizedTests([plain, parametrized]);
    // 1 plain + 3 expanded
    expect(result).toHaveLength(4);
    expect(result[0].id).toBe("plain");
    expect(result[1].id).toBe("param[0]");
    expect(result[2].id).toBe("param[1]");
    expect(result[3].id).toBe("param[2]");
  });
});

// ── countParametrizedSources ─────────────────────────────────────────────────

describe("countParametrizedSources", () => {
  it("returns 0 for an empty array", () => {
    expect(countParametrizedSources([])).toBe(0);
  });

  it("returns 0 when no tests have parametrize", () => {
    const tests = [makeToolCallTest(), makeToolCallTest({ id: "t2" })];
    expect(countParametrizedSources(tests)).toBe(0);
  });

  it("returns the count of tests with non-empty parametrize arrays", () => {
    const tests = [
      makeToolCallTest({ parametrize: [{ label: "a", input: {} }] }),
      makeToolCallTest({ id: "plain" }),
      makeToolCallTest({ id: "p2", parametrize: [{ label: "b", input: {} }] }),
    ];
    expect(countParametrizedSources(tests)).toBe(2);
  });

  it("does not count tests with empty parametrize arrays", () => {
    const tests = [
      makeToolCallTest({ parametrize: [] }),
      makeToolCallTest({ id: "p2", parametrize: [{ label: "row", input: {} }] }),
    ];
    expect(countParametrizedSources(tests)).toBe(1);
  });
});
