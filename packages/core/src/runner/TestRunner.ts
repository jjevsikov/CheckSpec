import type { MCPRecordingClient } from "../client/MCPRecordingClient.js";
import type { CheckSpecCollection, TestCase, StreamingTestCase, TestHooks } from "./TestCollection.js";
import { expect as mcpExpect, AssertionError } from "../assertions/expect.js";
import { SecurityScanner } from "../security/SecurityScanner.js";
import { runStreamingTest } from "../streaming/StreamingTestRunner.js";
import type { StreamingActual } from "../streaming/StreamingTestRunner.js";
import { HookRunner, HookAbortError } from "../hooks/HookRunner.js";
import type { HookResult } from "../hooks/HookRunner.js";
import { HookContext } from "../hooks/HookContext.js";
import { expandParametrizedTests, countParametrizedSources } from "./expander.js";
import { resolveIds } from "./resolveIds.js";
import { buildExecutionLayers } from "./captureDeps.js";

export interface TestResult {
  testId: string;
  testName: string;
  testType?: string;
  tags?: string[];
  passed: boolean;
  durationMs: number;
  error?: string;
  actual?: unknown;
  testCase?: TestCase;
  /**
   * Number of retry attempts consumed (only present when retry > 0 was configured).
   * E.g. retry:2 that passed on attempt 2 → retryCount: 1, retryExhausted: false.
   * E.g. retry:2 that failed all 3 attempts → retryCount: 2, retryExhausted: true.
   */
  retryCount?: number;
  /** True when all configured retries were consumed and the test still failed. */
  retryExhausted?: boolean;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: TestResult[];
  /** Results from all hook executions across all phases */
  hookResults: HookResult[];
  /**
   * Number of original test definitions that had a `parametrize` array.
   * Used by reporters to show "(N cases from M parametrized tests)".
   * Zero when no parametrized tests exist.
   */
  parametrizedSourceCount: number;
}

export interface RunnerOptions {
  timeout?: number;
  bail?: boolean;
  tags?: string[];
  /** Called immediately before each test starts */
  onTestStart?: (test: TestCase | StreamingTestCase) => void;
  /** Called immediately after each test completes */
  onTestEnd?: (result: TestResult) => void;
  /** Called immediately after each hook completes (all phases) */
  onHookEnd?: (result: HookResult) => void;
  /** Called when entering a describe block (for reporters to print section headers) */
  onDescribeStart?: (name: string) => void;
  /** Called when leaving a describe block (after all tests and teardown hooks) */
  onDescribeEnd?: (name: string) => void;
}

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;

/** Simple promise-based delay — no external dependency needed. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns true when an error message indicates a transport-layer failure
 * (broken pipe, connection reset, server process crash, etc.).
 *
 * Transport errors should NOT be retried — the server is gone, not flaky.
 * They surface from `runTest`'s catch block as `{ passed: false, error: msg }`.
 */
function isTransportError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("epipe") ||
    lower.includes("broken pipe") ||
    lower.includes("connection closed") ||
    lower.includes("econnreset") ||
    lower.includes("connection reset") ||
    lower.includes("socket hang up") ||
    /\beof\b/.test(lower) ||
    lower.includes("spawn enoent")
  );
}

export class TestRunner {
  constructor(
    private client: MCPRecordingClient,
    private options: RunnerOptions = {}
  ) {}

  async runCollection(collection: CheckSpecCollection): Promise<RunSummary> {
    // Fill in any missing `id` fields before processing — enables id-free collections.
    resolveIds(collection);

    const start = Date.now();
    const results: TestResult[] = [];
    const hookResults: HookResult[] = [];
    let skipped = 0;
    let aborted = false;

    const hookRunner = new HookRunner(this.client);
    // One context per collection run — shared across all hooks and tests.
    const context = new HookContext();

    /** Run a hook phase from the given hooks config.
     *  For teardown (isTeardown=true), swallows HookAbortError and returns false.
     *  For setup, returns true if aborted, false otherwise. */
    const runHookPhase = async (
      hooks: TestHooks | undefined,
      phase: "beforeAll" | "afterAll" | "beforeEach" | "afterEach",
      isTeardown: boolean
    ): Promise<boolean> => {
      const list = hooks?.[phase];
      if (!list?.length) return false;

      try {
        await hookRunner.runHooks(list, phase, (r) => {
          hookResults.push(r);
          this.options.onHookEnd?.(r);
        }, context);
        return false;
      } catch (err) {
        if (err instanceof HookAbortError) return !isTeardown;
        throw err;
      }
    };

    // ── Expand all tests upfront for total count and parametrize count ───────
    const rawAllTests: (TestCase | StreamingTestCase)[] = [
      ...(collection.tests as (TestCase | StreamingTestCase)[]),
      ...(collection.describe ?? []).flatMap(d => d.tests as (TestCase | StreamingTestCase)[]),
    ];
    const parametrizedSourceCount = countParametrizedSources(rawAllTests);

    const expandedDescribeBlocks = (collection.describe ?? []).map(block => ({
      name: block.name,
      hooks: block.hooks,
      expandedTests: expandParametrizedTests(block.tests as (TestCase | StreamingTestCase)[]),
    }));
    const expandedTopLevel = expandParametrizedTests(
      collection.tests as (TestCase | StreamingTestCase)[]
    );
    const totalCount = expandedTopLevel.length
      + expandedDescribeBlocks.reduce((sum, b) => sum + b.expandedTests.length, 0);

    const concurrency = collection.concurrency ?? 1;

    // ── Per-test lifecycle helper ───────────────────────────────────────────
    // Encapsulates: tag filter → beforeEach → test (with retry) → afterEach.
    // Runs as one concurrent unit so hooks are never interleaved with their
    // own test even when concurrency > 1.
    const runOneTest = async (
      test: TestCase | StreamingTestCase,
      collectionHooks: TestHooks | undefined,
      blockHooks?: TestHooks
    ): Promise<void> => {
      if (aborted) { skipped++; return; }

      // Tag filter
      if (this.options.tags?.length) {
        if (!test.tags?.some(t => this.options.tags!.includes(t))) { skipped++; return; }
      }

      // beforeEach: top-level then group
      let eachAborted = await runHookPhase(collectionHooks, "beforeEach", false);
      if (!eachAborted && blockHooks) {
        eachAborted = await runHookPhase(blockHooks, "beforeEach", false);
      }
      if (eachAborted) {
        if (blockHooks) await runHookPhase(blockHooks, "afterEach", true);
        await runHookPhase(collectionHooks, "afterEach", true);
        skipped++;
        aborted = true;
        return;
      }

      // Test (with retry + template resolution)
      const resolvedTest = context.resolve(test);
      this.options.onTestStart?.(resolvedTest);
      const result = await this.executeWithRetry(resolvedTest);
      results.push(result);
      this.options.onTestEnd?.(result);

      // Apply capture: extract values from passing test results into HookContext.
      // Only runs on passing tests and only for types that return structured output.
      if (
        result.passed &&
        (resolvedTest as TestCase).capture &&
        result.actual !== undefined
      ) {
        const captureMap = (resolvedTest as TestCase).capture!;
        const actual = result.actual;
        let text = "";

        if (
          resolvedTest.type === "tool-call" &&
          actual != null &&
          typeof actual === "object" &&
          "content" in actual
        ) {
          const content = (actual as { content?: Array<{ type: string; text?: string }> }).content ?? [];
          text = content
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
        } else if (
          resolvedTest.type === "resource-read" &&
          actual != null &&
          typeof actual === "object" &&
          "contents" in actual
        ) {
          const contents = (actual as { contents: Array<Record<string, unknown>> }).contents;
          text = contents.map((c) => (typeof c["text"] === "string" ? c["text"] : "")).join("");
        } else if (
          resolvedTest.type === "prompt-get" &&
          actual != null &&
          typeof actual === "object" &&
          "messages" in actual
        ) {
          const messages = (actual as { messages: Array<{ content: { type: string; text?: string } }> }).messages;
          text = messages
            .map((m) => (m.content.type === "text" ? m.content.text ?? "" : ""))
            .join("\n");
        } else if (
          resolvedTest.type === "streaming-tool-call" &&
          actual != null &&
          typeof actual === "object" &&
          "finalResult" in actual
        ) {
          const finalResult = (actual as StreamingActual).finalResult;
          const content = finalResult.content ?? [];
          text = content
            .filter((c) => c.type === "text")
            .map((c) => (c as { type: "text"; text: string }).text ?? "")
            .join("");
        }

        if (text) {
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* use raw string */
          }

          for (const [varName, path] of Object.entries(captureMap)) {
            const value = HookContext.extractValue(parsed, path);
            if (value !== undefined) {
              context.set(varName, value);
            } else {
              console.warn(
                `[capture] "${path}" matched nothing in test "${resolvedTest.name}" — variable "{{${varName}}}" not set`
              );
            }
          }
        }
      }

      // afterEach: group then top-level (teardown — always runs)
      if (blockHooks) await runHookPhase(blockHooks, "afterEach", true);
      await runHookPhase(collectionHooks, "afterEach", true);

      if (!result.passed && this.options.bail) { aborted = true; }
    };

    // ── Chunked concurrent execution ─────────────────────────────────────
    // Processes tests in capture-dependency-aware chunks.  Tests within a
    // chunk run in parallel; the next chunk waits for the previous one to
    // finish.  `buildExecutionLayers` ensures that if test B consumes a
    // {{varName}} produced by test A's `capture`, A lands in an earlier chunk
    // than B.  For tests with no capture dependencies the chunking is
    // identical to the naive fixed-size approach.
    // Bail stops launching new chunks but lets in-flight tests complete.
    const runTestsConcurrently = async (
      tests: (TestCase | StreamingTestCase)[],
      collectionHooks: TestHooks | undefined,
      blockHooks?: TestHooks
    ): Promise<void> => {
      const chunks = buildExecutionLayers(tests, concurrency);
      let remaining = tests.length;
      for (const chunk of chunks) {
        if (aborted) { skipped += remaining; break; }
        remaining -= chunk.length;
        if (chunk.length === 1) {
          // Fast path — avoid Promise.all overhead for serial execution
          await runOneTest(chunk[0]!, collectionHooks, blockHooks);
        } else {
          await Promise.all(
            chunk.map(t => runOneTest(t, collectionHooks, blockHooks))
          );
        }
      }
    };

    // ── Top-level beforeAll ─────────────────────────────────────────────────
    aborted = await runHookPhase(collection.hooks, "beforeAll", false);

    if (!aborted) {
      // ── Describe blocks (sequential; tests within each block concurrent) ─
      for (const block of expandedDescribeBlocks) {
        if (aborted) { skipped += block.expandedTests.length; continue; }

        // Describe-level beforeAll
        const describeAborted = await runHookPhase(block.hooks, "beforeAll", false);
        if (describeAborted) {
          skipped += block.expandedTests.length;
          await runHookPhase(block.hooks, "afterAll", true);
          continue; // other describe blocks can still run
        }

        // Emit header only after successful setup
        this.options.onDescribeStart?.(block.name);

        await runTestsConcurrently(
          block.expandedTests, collection.hooks, block.hooks
        );

        // Describe-level afterAll (teardown — always runs since beforeAll ran)
        await runHookPhase(block.hooks, "afterAll", true);
        this.options.onDescribeEnd?.(block.name);
      }

      // ── Top-level tests (concurrent) ──────────────────────────────────────
      await runTestsConcurrently(expandedTopLevel, collection.hooks);
    } else {
      skipped = totalCount;
    }

    // ── Top-level afterAll — always runs ──────────────────────────────────────
    await runHookPhase(collection.hooks, "afterAll", true);

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    return {
      total: totalCount,
      passed,
      failed,
      skipped,
      durationMs: Date.now() - start,
      results,
      hookResults,
      parametrizedSourceCount,
    };
  }

  /**
   * Wraps `runTest` with retry logic.
   *
   * - Retries only on assertion failures (`result.passed === false`).
   * - Transport-layer exceptions propagate unchanged (not caught here).
   * - Hooks are NOT retried — this wraps a single test execution only.
   * - `retryCount` and `retryExhausted` are only set on the result when
   *   `retry > 0` was configured AND retries were actually consumed.
   */
  private async executeWithRetry(
    test: TestCase | StreamingTestCase
  ): Promise<TestResult> {
    const configuredRetry = test.retry ?? 0;
    const maxAttempts = 1 + configuredRetry;
    const delayMs = test.retryDelayMs ?? 500;

    let lastResult!: TestResult;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await this.runTest(test);

      if (lastResult.passed) {
        // Annotate only when we actually used at least one retry
        if (attempt > 1) {
          return { ...lastResult, retryCount: attempt - 1, retryExhausted: false };
        }
        return lastResult; // first-attempt pass — no annotation
      }

      // Transport errors (EPIPE, connection closed, etc.) are not transient —
      // the server is gone. Bail immediately rather than wasting retry attempts.
      if (isTransportError(lastResult.error)) {
        // Return directly with accurate retryCount (retries actually consumed),
        // not configuredRetry which would overstate the attempts made.
        if (configuredRetry > 0) {
          return { ...lastResult, retryCount: attempt - 1, retryExhausted: true };
        }
        return lastResult;
      }

      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }

    // All attempts exhausted — annotate only when retry was configured
    if (configuredRetry > 0) {
      return { ...lastResult, retryCount: configuredRetry, retryExhausted: true };
    }
    return lastResult;
  }

  /**
   * Races `promise` against a timeout rejection.
   * Always clears the timer in a `finally` block so no handles leak into the event loop.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    testName: string
  ): Promise<T> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      handle = setTimeout(
        () => reject(new Error(`Test timed out after ${ms}ms: "${testName}"`)),
        ms
      );
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(handle);
    }
  }

  /**
   * Dispatches a test to the appropriate handler based on its type.
   * Extracted from `runTest` so it can be wrapped with `withTimeout`.
   */
  private async dispatchByType(
    test: TestCase | StreamingTestCase,
    start: number
  ): Promise<TestResult> {
    switch (test.type) {
      case "tool-call":
        return await this.runToolCallTest(test, start);
      case "protocol":
        return await this.runProtocolTest(test, start);
      case "fuzz":
        return await this.runFuzzTest(test, start);
      case "security":
        return await this.runSecurityTest(test, start);
      case "resource-read":
        return await this.runResourceReadTest(test, start);
      case "prompt-get":
        return await this.runPromptGetTest(test, start);
      case "streaming-tool-call":
        return await runStreamingTest(
          this.client,
          test as StreamingTestCase,
          this.options.timeout
        );
      default: {
        const unknown = test as unknown as TestCase;
        return {
          testId: unknown.id,
          testName: unknown.name,
          testType: unknown.type,
          tags: unknown.tags,
          passed: false,
          durationMs: Date.now() - start,
          error: `Unknown test type: ${unknown.type}`,
        };
      }
    }
  }

  async runTest(test: TestCase | StreamingTestCase): Promise<TestResult> {
    const start = Date.now();
    const effectiveTimeout =
      (test as TestCase).timeoutMs ?? this.options.timeout ?? 30_000;

    try {
      const result = await this.withTimeout(
        this.dispatchByType(test, start),
        effectiveTimeout,
        test.name
      );
      result.testCase = test as TestCase;
      return result;
    } catch (err) {
      return {
        testId: (test as TestCase).id,
        testName: (test as TestCase).name,
        testType: test.type,
        tags: test.tags,
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        testCase: test as TestCase,
      };
    }
  }

  // ── Tool call ────────────────────────────────────────────────────────────

  private async runToolCallTest(
    test: TestCase,
    start: number
  ): Promise<TestResult> {
    if (!test.tool) {
      throw new Error(`Test "${test.id}" missing required field: tool`);
    }

    const result = await this.client.callTool(test.tool, test.input ?? {});
    const durationMs = Date.now() - start;
    const assertion = mcpExpect(result, durationMs);

    if (test.expect) {
      if (test.expect.success === true) assertion.toSucceed();
      if (test.expect.success === false) assertion.toFail();
      if (test.expect.schema) assertion.toMatchSchema(test.expect.schema);
      if (test.expect.contains) assertion.toContainText(test.expect.contains);
      if (test.expect.notContains) assertion.toNotContainText(test.expect.notContains);
      if (test.expect.equals !== undefined) assertion.toEqualText(test.expect.equals);
      if (test.expect.matches) assertion.toMatchPattern(test.expect.matches);
      if (test.expect.executionTimeMs)
        assertion.toRespondWithin(test.expect.executionTimeMs);
      if (test.expect.maxTokens)
        assertion.toBeLessThanTokens(test.expect.maxTokens);

      if (test.expect.jsonPath) {
        const allText = result.content
          ? result.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { type: "text"; text: string }).text)
              .join("")
          : "";
        let parsed: unknown = allText;
        try {
          parsed = JSON.parse(allText);
        } catch {
          /* validate as raw string */
        }
        const jsonPathAssertions = Array.isArray(test.expect.jsonPath)
          ? test.expect.jsonPath
          : [test.expect.jsonPath];
        for (const jp of jsonPathAssertions) {
          const extracted = HookContext.extractValue(parsed, jp.path);
          if (extracted === undefined) {
            throw new AssertionError(
              `jsonPath "${jp.path}" matched nothing in the response`
            );
          }
          if (jp.equals !== undefined && extracted !== jp.equals) {
            throw new AssertionError(
              `jsonPath "${jp.path}": expected "${jp.equals}", got "${extracted}"`
            );
          }
          if (jp.contains !== undefined && !extracted.includes(jp.contains)) {
            throw new AssertionError(
              `jsonPath "${jp.path}": expected to contain "${jp.contains}", got "${extracted}"`
            );
          }
          if (jp.matches !== undefined) {
            try {
              if (!new RegExp(jp.matches).test(extracted)) {
                throw new AssertionError(
                  `jsonPath "${jp.path}": expected to match /${jp.matches}/, got "${extracted}"`
                );
              }
            } catch (e) {
              if (e instanceof AssertionError) throw e;
              throw new AssertionError(
                `jsonPath "${jp.path}": invalid regex /${jp.matches}/`
              );
            }
          }
        }
      }
    }

    return {
      testId: test.id,
      testName: test.name,
      testType: test.type,
      tags: test.tags,
      passed: true,
      durationMs,
      actual: result,
    };
  }

  // ── Protocol ─────────────────────────────────────────────────────────────

  private async runProtocolTest(
    test: TestCase,
    start: number
  ): Promise<TestResult> {
    await this.client.listTools();
    return {
      testId: test.id,
      testName: test.name,
      testType: test.type,
      tags: test.tags,
      passed: true,
      durationMs: Date.now() - start,
    };
  }

  // ── Fuzz ─────────────────────────────────────────────────────────────────

  private async runFuzzTest(
    test: TestCase,
    start: number
  ): Promise<TestResult> {
    if (!test.tool) {
      throw new Error(`Fuzz test "${test.id}" missing required field: tool`);
    }
    const result = await this.client.callTool(test.tool, test.input ?? {});
    return {
      testId: test.id,
      testName: test.name,
      testType: test.type,
      tags: test.tags,
      passed: true,
      durationMs: Date.now() - start,
      actual: result,
    };
  }

  // ── Resource read ─────────────────────────────────────────────────────────

  private async runResourceReadTest(
    test: TestCase,
    start: number
  ): Promise<TestResult> {
    if (!test.uri) {
      throw new Error(`Resource-read test "${test.id}" missing required field: uri`);
    }

    // Handle expected failure case first — resource should throw.
    if (test.expect?.success === false) {
      try {
        await this.client.readResource(test.uri);
        throw new AssertionError(
          `Expected resource "${test.uri}" to fail, but it succeeded`
        );
      } catch (err) {
        if (err instanceof AssertionError) throw err;
        // Resource threw as expected — test passes.
        return {
          testId: test.id,
          testName: test.name,
          testType: test.type,
          tags: test.tags,
          passed: true,
          durationMs: Date.now() - start,
        };
      }
    }

    const result = await this.client.readResource(test.uri);
    const durationMs = Date.now() - start;

    // success: true is now actively enforced — readResource throws on failure,
    // so reaching here means the call succeeded. No extra assertion needed.

    const text = result.contents
      .map((c) => ("text" in c ? (c as { text?: string }).text ?? "" : ""))
      .join("");

    if (test.expect?.contains) {
      if (!text.includes(test.expect.contains)) {
        throw new AssertionError(
          `Resource "${test.uri}" content does not contain "${test.expect.contains}"`,
          text
        );
      }
    }

    if (test.expect?.notContains) {
      if (text.includes(test.expect.notContains)) {
        throw new AssertionError(
          `Resource "${test.uri}" content should NOT contain "${test.expect.notContains}"`,
          text
        );
      }
    }

    if (test.expect?.equals !== undefined) {
      if (text !== test.expect.equals) {
        throw new AssertionError(
          `Resource "${test.uri}" content does not equal "${test.expect.equals}", got "${text}"`,
          text
        );
      }
    }

    if (test.expect?.matches) {
      let regex: RegExp;
      try {
        regex = new RegExp(test.expect.matches);
      } catch {
        throw new AssertionError(
          `Resource "${test.uri}": invalid regex pattern: "${test.expect.matches}"`
        );
      }
      if (!regex.test(text)) {
        throw new AssertionError(
          `Resource "${test.uri}" content does not match pattern /${test.expect.matches}/, got "${text}"`,
          text
        );
      }
    }

    if (test.expect?.schema) {
      const { Ajv } = await import("ajv");
      const ajv = new Ajv();
      const validate = ajv.compile(test.expect.schema);
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* validate as raw string */
      }
      if (!validate(parsed)) {
        throw new AssertionError(
          `Resource content does not match schema: ${JSON.stringify(validate.errors)}`,
          text
        );
      }
    }

    if (test.expect?.jsonPath) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* validate as raw string */
      }
      const jsonPathAssertions = Array.isArray(test.expect.jsonPath)
        ? test.expect.jsonPath
        : [test.expect.jsonPath];
      for (const jp of jsonPathAssertions) {
        const extracted = HookContext.extractValue(parsed, jp.path);
        if (extracted === undefined) {
          throw new AssertionError(
            `jsonPath "${jp.path}" matched nothing in resource "${test.uri}"`
          );
        }
        if (jp.equals !== undefined && extracted !== jp.equals) {
          throw new AssertionError(
            `jsonPath "${jp.path}": expected "${jp.equals}", got "${extracted}"`
          );
        }
        if (jp.contains !== undefined && !extracted.includes(jp.contains)) {
          throw new AssertionError(
            `jsonPath "${jp.path}": expected to contain "${jp.contains}", got "${extracted}"`
          );
        }
        if (jp.matches !== undefined) {
          try {
            if (!new RegExp(jp.matches).test(extracted)) {
              throw new AssertionError(
                `jsonPath "${jp.path}": expected to match /${jp.matches}/, got "${extracted}"`
              );
            }
          } catch (e) {
            if (e instanceof AssertionError) throw e;
            throw new AssertionError(
              `jsonPath "${jp.path}": invalid regex /${jp.matches}/`
            );
          }
        }
      }
    }

    if (test.expect?.executionTimeMs && durationMs > test.expect.executionTimeMs) {
      throw new AssertionError(
        `Resource read took ${durationMs}ms, expected within ${test.expect.executionTimeMs}ms`
      );
    }

    if (test.expect?.maxTokens) {
      const estimatedTokens = Math.ceil(text.length / 4);
      if (estimatedTokens > test.expect.maxTokens) {
        throw new AssertionError(
          `Resource "${test.uri}" response exceeds token budget: estimated ${estimatedTokens} tokens (~${text.length} chars), limit is ${test.expect.maxTokens} tokens`
        );
      }
    }

    return {
      testId: test.id,
      testName: test.name,
      testType: test.type,
      tags: test.tags,
      passed: true,
      durationMs,
      actual: result,
    };
  }

  // ── Prompt get ────────────────────────────────────────────────────────────

  private async runPromptGetTest(
    test: TestCase,
    start: number
  ): Promise<TestResult> {
    const name = test.promptName ?? test.tool;
    if (!name) {
      throw new Error(
        `Prompt-get test "${test.id}" missing required field: promptName (or tool)`
      );
    }

    // Handle expected failure case first — getPrompt should throw.
    if (test.expect?.success === false) {
      try {
        await this.client.getPrompt(name, test.promptArgs);
        throw new AssertionError(
          `Expected prompt "${name}" to fail, but it succeeded`
        );
      } catch (err) {
        if (err instanceof AssertionError) throw err;
        // Prompt threw as expected — test passes.
        return {
          testId: test.id,
          testName: test.name,
          testType: test.type,
          tags: test.tags,
          passed: true,
          durationMs: Date.now() - start,
        };
      }
    }

    const result = await this.client.getPrompt(name, test.promptArgs);
    const durationMs = Date.now() - start;

    // success: true is now actively enforced — getPrompt throws on failure,
    // so reaching here means the call succeeded. No extra assertion needed.

    const text = result.messages
      .map((m) =>
        m.content.type === "text" ? (m.content as { text: string }).text : ""
      )
      .join("\n");

    if (test.expect?.contains) {
      if (!text.includes(test.expect.contains)) {
        throw new AssertionError(
          `Prompt "${name}" response does not contain "${test.expect.contains}"`,
          text
        );
      }
    }

    if (test.expect?.notContains) {
      if (text.includes(test.expect.notContains)) {
        throw new AssertionError(
          `Prompt "${name}" response should NOT contain "${test.expect.notContains}"`,
          text
        );
      }
    }

    if (test.expect?.equals !== undefined) {
      if (text !== test.expect.equals) {
        throw new AssertionError(
          `Prompt "${name}" response does not equal "${test.expect.equals}", got "${text}"`,
          text
        );
      }
    }

    if (test.expect?.matches) {
      let regex: RegExp;
      try {
        regex = new RegExp(test.expect.matches);
      } catch {
        throw new AssertionError(
          `Prompt "${name}": invalid regex pattern: "${test.expect.matches}"`
        );
      }
      if (!regex.test(text)) {
        throw new AssertionError(
          `Prompt "${name}" response does not match pattern /${test.expect.matches}/, got "${text}"`,
          text
        );
      }
    }

    if (test.expect?.jsonPath) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* validate as raw string */
      }
      const jsonPathAssertions = Array.isArray(test.expect.jsonPath)
        ? test.expect.jsonPath
        : [test.expect.jsonPath];
      for (const jp of jsonPathAssertions) {
        const extracted = HookContext.extractValue(parsed, jp.path);
        if (extracted === undefined) {
          throw new AssertionError(
            `jsonPath "${jp.path}" matched nothing in prompt "${name}" response`
          );
        }
        if (jp.equals !== undefined && extracted !== jp.equals) {
          throw new AssertionError(
            `jsonPath "${jp.path}": expected "${jp.equals}", got "${extracted}"`
          );
        }
        if (jp.contains !== undefined && !extracted.includes(jp.contains)) {
          throw new AssertionError(
            `jsonPath "${jp.path}": expected to contain "${jp.contains}", got "${extracted}"`
          );
        }
        if (jp.matches !== undefined) {
          try {
            if (!new RegExp(jp.matches).test(extracted)) {
              throw new AssertionError(
                `jsonPath "${jp.path}": expected to match /${jp.matches}/, got "${extracted}"`
              );
            }
          } catch (e) {
            if (e instanceof AssertionError) throw e;
            throw new AssertionError(
              `jsonPath "${jp.path}": invalid regex /${jp.matches}/`
            );
          }
        }
      }
    }

    if (test.expect?.executionTimeMs && durationMs > test.expect.executionTimeMs) {
      throw new AssertionError(
        `Prompt get took ${durationMs}ms, expected within ${test.expect.executionTimeMs}ms`
      );
    }

    if (test.expect?.maxTokens) {
      const estimatedTokens = Math.ceil(text.length / 4);
      if (estimatedTokens > test.expect.maxTokens) {
        throw new AssertionError(
          `Prompt "${name}" response exceeds token budget: estimated ${estimatedTokens} tokens (~${text.length} chars), limit is ${test.expect.maxTokens} tokens`
        );
      }
    }

    return {
      testId: test.id,
      testName: test.name,
      testType: test.type,
      tags: test.tags,
      passed: true,
      durationMs,
      actual: result,
    };
  }

  // ── Security ──────────────────────────────────────────────────────────────

  private async runSecurityTest(
    test: TestCase,
    start: number
  ): Promise<TestResult> {
    const threshold = test.securityThreshold ?? "medium";
    const thresholdIndex = SEVERITY_ORDER.indexOf(threshold);

    const scanner = new SecurityScanner();
    let findings;

    if (test.tool) {
      // Single-tool scan
      const allTools = await this.client.listTools();
      const targetTool = allTools.find((t) => t.name === test.tool);

      if (!targetTool) {
        throw new Error(
          `Security test "${test.id}": tool "${test.tool}" not found on server`
        );
      }

      findings = await scanner.scanTool(this.client, targetTool);
    } else {
      // No tool specified — scan all tools
      findings = await scanner.scan(this.client);
    }

    // "securityThreshold: high" means "I accept HIGH findings — fail only on
    // findings ABOVE high (i.e. critical)".  Use strict > so the threshold
    // value itself is the highest *allowed* severity, not the lowest *failing*
    // severity.  Default "medium" → fail on high + critical.
    const violations = findings.filter(
      (f) => SEVERITY_ORDER.indexOf(f.severity) > thresholdIndex
    );

    const expectDetection = test.expect?.success === false;

    if (expectDetection) {
      // Inverted logic: expect.success === false means "I expect findings"
      if (violations.length > 0) {
        // Findings detected as expected — PASS
        return {
          testId: test.id,
          testName: test.name,
          testType: test.type,
          tags: test.tags,
          passed: true,
          durationMs: Date.now() - start,
          actual: violations,
        };
      } else {
        // No findings detected but we expected them — FAIL
        return {
          testId: test.id,
          testName: test.name,
          testType: test.type,
          tags: test.tags,
          passed: false,
          durationMs: Date.now() - start,
          error: `Expected security findings above "${threshold}" but none were detected`,
        };
      }
    }

    if (violations.length > 0) {
      return {
        testId: test.id,
        testName: test.name,
        testType: test.type,
        tags: test.tags,
        passed: false,
        durationMs: Date.now() - start,
        error: `${violations.length} security finding(s) at or above "${threshold}": ${violations
          .map((f) => `[${f.severity.toUpperCase()}] ${f.description}`)
          .join("; ")}`,
        actual: violations,
      };
    }

    return {
      testId: test.id,
      testName: test.name,
      testType: test.type,
      tags: test.tags,
      passed: true,
      durationMs: Date.now() - start,
    };
  }
}
