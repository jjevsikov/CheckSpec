import { describe, it, expect } from "vitest";
import { evaluateStreamExpect } from "@checkspec/core";
import type { StreamChunk } from "@checkspec/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeChunks(count: number, intervalMs = 100): StreamChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    progress: i + 1,
    total: count,
    message: `chunk-${i + 1}`,
    timestamp: 1000 + i * intervalMs,
  }));
}

function makeResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("evaluateStreamExpect", () => {
  describe("minChunks", () => {
    it("passes when chunk count equals minChunks", () => {
      expect(() =>
        evaluateStreamExpect(makeChunks(3), makeResult("done"), { minChunks: 3 }, 500)
      ).not.toThrow();
    });

    it("passes when chunk count exceeds minChunks", () => {
      expect(() =>
        evaluateStreamExpect(makeChunks(5), makeResult("done"), { minChunks: 3 }, 500)
      ).not.toThrow();
    });

    it("fails when chunk count is below minChunks", () => {
      expect(() =>
        evaluateStreamExpect(makeChunks(2), makeResult("done"), { minChunks: 5 }, 500)
      ).toThrow("Expected at least 5 chunk(s) but got 2");
    });

    it("fails with 0 chunks when minChunks > 0", () => {
      expect(() =>
        evaluateStreamExpect([], makeResult("done"), { minChunks: 1 }, 500)
      ).toThrow("Expected at least 1 chunk(s) but got 0");
    });
  });

  describe("chunkContains", () => {
    it("passes when every chunk message contains the substring", () => {
      const chunks = makeChunks(3);
      expect(() =>
        evaluateStreamExpect(chunks, makeResult("done"), { chunkContains: "chunk-" }, 500)
      ).not.toThrow();
    });

    it("fails when a chunk message does not contain the substring", () => {
      const chunks = makeChunks(3);
      expect(() =>
        evaluateStreamExpect(chunks, makeResult("done"), { chunkContains: "MISSING" }, 500)
      ).toThrow(/does not contain "MISSING"/);
    });

    it("falls back to progress number string when message is absent", () => {
      const chunks: StreamChunk[] = [{ progress: 1, timestamp: 1000 }];
      expect(() =>
        evaluateStreamExpect(chunks, makeResult("done"), { chunkContains: "1" }, 500)
      ).not.toThrow();
    });
  });

  describe("maxChunkIntervalMs", () => {
    it("passes when all intervals are within the limit", () => {
      const chunks = makeChunks(3, 50); // 50ms apart
      expect(() =>
        evaluateStreamExpect(chunks, makeResult("done"), { maxChunkIntervalMs: 100 }, 500)
      ).not.toThrow();
    });

    it("fails when a gap between chunks exceeds the limit", () => {
      const chunks: StreamChunk[] = [
        { progress: 1, message: "a", timestamp: 1000 },
        { progress: 2, message: "b", timestamp: 1050 },
        { progress: 3, message: "c", timestamp: 1500 }, // 450ms gap
      ];
      expect(() =>
        evaluateStreamExpect(chunks, makeResult("done"), { maxChunkIntervalMs: 200 }, 1000)
      ).toThrow(/Gap between chunk 1 and chunk 2 was 450ms/);
    });

    it("skips interval check when fewer than 2 chunks", () => {
      const chunks = makeChunks(1);
      expect(() =>
        evaluateStreamExpect(chunks, makeResult("done"), { maxChunkIntervalMs: 1 }, 500)
      ).not.toThrow();
    });
  });

  describe("finalContains", () => {
    it("passes when final result text contains the substring", () => {
      expect(() =>
        evaluateStreamExpect(makeChunks(2), makeResult("operation complete"), { finalContains: "complete" }, 500)
      ).not.toThrow();
    });

    it("fails when final result text does not contain the substring", () => {
      expect(() =>
        evaluateStreamExpect(makeChunks(2), makeResult("nope"), { finalContains: "done" }, 500)
      ).toThrow(/Final result does not contain "done"/);
    });

    it("concatenates multiple text blocks for the check", () => {
      const result: CallToolResult = {
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      };
      expect(() =>
        evaluateStreamExpect([], result, { finalContains: "hello world" }, 500)
      ).not.toThrow();
    });
  });

  describe("maxTotalMs", () => {
    it("passes when total duration is within the limit", () => {
      expect(() =>
        evaluateStreamExpect(makeChunks(3), makeResult("done"), { maxTotalMs: 1000 }, 800)
      ).not.toThrow();
    });

    it("fails when total duration exceeds the limit", () => {
      expect(() =>
        evaluateStreamExpect(makeChunks(3), makeResult("done"), { maxTotalMs: 500 }, 800)
      ).toThrow("Total stream took 800ms, exceeds maxTotalMs of 500ms");
    });
  });

  describe("combined assertions", () => {
    it("passes all assertions together on a happy-path result", () => {
      const chunks = makeChunks(5, 80);
      expect(() =>
        evaluateStreamExpect(chunks, makeResult("complete"), {
          minChunks: 5,
          chunkContains: "chunk-",
          maxChunkIntervalMs: 200,
          finalContains: "complete",
          maxTotalMs: 2000,
        }, 600)
      ).not.toThrow();
    });

    it("reports the first failing assertion and stops", () => {
      // minChunks fails first
      expect(() =>
        evaluateStreamExpect(makeChunks(1), makeResult("done"), {
          minChunks: 999,
          finalContains: "done",
        }, 500)
      ).toThrow("Expected at least 999 chunk(s) but got 1");
    });
  });

  describe("empty streamExpect", () => {
    it("passes with no assertions defined", () => {
      expect(() =>
        evaluateStreamExpect(makeChunks(3), makeResult("done"), {}, 500)
      ).not.toThrow();
    });
  });
});
