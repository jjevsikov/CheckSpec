import type { MCPRecordingClient } from "../client/MCPRecordingClient.js";
import type { StreamingTestCase, StreamExpect } from "../runner/TestCollection.js";
import type { TestResult } from "../runner/TestRunner.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** One progress notification received from the server. */
export interface StreamChunk {
  progress: number;
  total?: number;
  message?: string;
  /** Wall-clock time when this chunk arrived (Date.now()) */
  timestamp: number;
}

/** Detailed streaming result attached to the TestResult.actual field. */
export interface StreamingActual {
  chunks: StreamChunk[];
  finalResult: CallToolResult;
  totalDurationMs: number;
}

/**
 * Pure function: evaluate StreamExpect assertions against collected chunks.
 * Throws an Error with a descriptive message on the first violation.
 * Exported for unit testing without a live server.
 */
export function evaluateStreamExpect(
  chunks: StreamChunk[],
  finalResult: CallToolResult,
  expect: StreamExpect,
  totalDurationMs: number
): void {
  if (expect.minChunks !== undefined && chunks.length < expect.minChunks) {
    throw new Error(
      `Expected at least ${expect.minChunks} chunk(s) but got ${chunks.length}`
    );
  }

  if (expect.chunkContains !== undefined) {
    for (let i = 0; i < chunks.length; i++) {
      const msg = chunks[i].message ?? String(chunks[i].progress);
      if (!msg.includes(expect.chunkContains)) {
        throw new Error(
          `Chunk ${i} ("${msg}") does not contain "${expect.chunkContains}"`
        );
      }
    }
  }

  if (expect.maxChunkIntervalMs !== undefined && chunks.length >= 2) {
    for (let i = 1; i < chunks.length; i++) {
      const gap = chunks[i].timestamp - chunks[i - 1].timestamp;
      if (gap > expect.maxChunkIntervalMs) {
        throw new Error(
          `Gap between chunk ${i - 1} and chunk ${i} was ${gap}ms, ` +
            `exceeds maxChunkIntervalMs of ${expect.maxChunkIntervalMs}ms`
        );
      }
    }
  }

  if (expect.finalContains !== undefined) {
    const text = (finalResult.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    if (!text.includes(expect.finalContains)) {
      throw new Error(
        `Final result does not contain "${expect.finalContains}". Got: "${text.slice(0, 200)}"`
      );
    }
  }

  if (expect.maxTotalMs !== undefined && totalDurationMs > expect.maxTotalMs) {
    throw new Error(
      `Total stream took ${totalDurationMs}ms, exceeds maxTotalMs of ${expect.maxTotalMs}ms`
    );
  }
}

/**
 * Runs a single streaming-tool-call test against an already-connected client.
 * Collects all progress notifications, then evaluates StreamExpect assertions.
 */
export async function runStreamingTest(
  client: MCPRecordingClient,
  test: StreamingTestCase,
  timeoutMs = 30_000
): Promise<TestResult> {
  const start = Date.now();
  const chunks: StreamChunk[] = [];

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);

  try {
    const finalResult = await client.callToolStreaming(
      test.tool,
      test.input,
      (chunk) => {
        chunks.push(chunk);
      }
    );

    clearTimeout(timeoutHandle);

    if (timedOut) {
      return {
        testId: test.id,
        testName: test.name,
        testType: test.type,
        tags: test.tags,
        passed: false,
        durationMs: Date.now() - start,
        error: `Streaming test timed out after ${timeoutMs}ms (received ${chunks.length} chunks)`,
      };
    }

    const totalDurationMs = Date.now() - start;

    evaluateStreamExpect(chunks, finalResult, test.streamExpect, totalDurationMs);

    const actual: StreamingActual = { chunks, finalResult, totalDurationMs };

    return {
      testId: test.id,
      testName: test.name,
      testType: test.type,
      tags: test.tags,
      passed: true,
      durationMs: totalDurationMs,
      actual,
    };
  } catch (err) {
    clearTimeout(timeoutHandle);
    return {
      testId: test.id,
      testName: test.name,
      testType: test.type,
      tags: test.tags,
      passed: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      actual: { chunks, totalDurationMs: Date.now() - start },
    };
  }
}
