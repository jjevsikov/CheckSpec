import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  MCPRecordingClient,
  TestRunner,
} from "@checkspec/core";
import type { CheckSpecCollection } from "@checkspec/core";
import { collectionSchema } from "@checkspec/core/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_SERVER = resolve(__dirname, "../../fixtures/echo-server/dist/index.js");
const BUGGY_SERVER = resolve(__dirname, "../../fixtures/buggy-server/dist/index.js");

const ECHO_COLLECTION: CheckSpecCollection = {
  version: "1.0",
  name: "Echo Server Tests",
  server: { command: "node", args: [ECHO_SERVER] },
  tests: [
    {
      id: "echo-hello",
      name: "echo returns hello",
      type: "tool-call",
      tool: "echo",
      input: { message: "hello" },
      expect: { success: true, contains: "hello" },
      tags: ["smoke"],
    },
    {
      id: "protocol-test",
      name: "Protocol: basic capability check",
      type: "protocol",
      tags: ["protocol"],
    },
  ],
};

describe("TestRunner (against echo-server)", () => {
  let client: MCPRecordingClient;
  let runner: TestRunner;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [ECHO_SERVER],
    });
    client = new MCPRecordingClient(transport);
    await client.connect();
    runner = new TestRunner(client, { timeout: 5000 });
  });

  afterAll(async () => {
    await client.disconnect();
  });

  it("runCollection returns correct summary shape", async () => {
    const summary = await runner.runCollection(ECHO_COLLECTION);
    expect(summary).toMatchObject({
      total: 2,
      passed: expect.any(Number),
      failed: expect.any(Number),
      skipped: expect.any(Number),
      durationMs: expect.any(Number),
      results: expect.any(Array),
    });
  });

  it("runCollection passes all tests in echo collection", async () => {
    const summary = await runner.runCollection(ECHO_COLLECTION);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.results).toHaveLength(2);
  });

  it("runTest returns correct TestResult shape", async () => {
    const result = await runner.runTest(ECHO_COLLECTION.tests[0]);
    expect(result).toMatchObject({
      testId: "echo-hello",
      testName: "echo returns hello",
      passed: expect.any(Boolean),
      durationMs: expect.any(Number),
    });
  });

  it("runTest passes for valid echo call", async () => {
    const result = await runner.runTest({
      id: "t1",
      name: "basic echo",
      type: "tool-call",
      tool: "echo",
      input: { message: "test" },
      expect: { success: true },
    });
    expect(result.passed).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runTest fails when assertion fails", async () => {
    const result = await runner.runTest({
      id: "t2",
      name: "failing contains assertion",
      type: "tool-call",
      tool: "echo",
      input: { message: "hello" },
      expect: { contains: "THIS_WILL_NEVER_BE_IN_RESPONSE" },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("bail option stops on first failure", async () => {
    const bailRunner = new TestRunner(client, { bail: true });
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Bail test",
      server: { command: "node", args: [ECHO_SERVER] },
      tests: [
        {
          id: "fail-1",
          name: "Failing test",
          type: "tool-call",
          tool: "echo",
          input: { message: "x" },
          expect: { contains: "WILL_NOT_MATCH" },
        },
        {
          id: "pass-2",
          name: "This should be skipped",
          type: "tool-call",
          tool: "echo",
          input: { message: "hi" },
          expect: { success: true },
        },
      ],
    };
    const summary = await bailRunner.runCollection(collection);
    // With bail, only 1 result should be in the results array
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].passed).toBe(false);
  });

  it("tag filtering skips non-matching tests", async () => {
    const tagRunner = new TestRunner(client, { tags: ["smoke"] });
    const summary = await tagRunner.runCollection(ECHO_COLLECTION);
    // Only the "smoke"-tagged test should run
    expect(summary.results).toHaveLength(1);
    expect(summary.skipped).toBe(1);
  });

  it("runTest passes for resource-read on version://info", async () => {
    const result = await runner.runTest({
      id: "res-1",
      name: "read version resource",
      type: "resource-read",
      uri: "version://info",
      expect: { contains: "version" },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("runTest passes for resource-read with JSON schema assertion", async () => {
    const result = await runner.runTest({
      id: "res-2",
      name: "version resource matches schema",
      type: "resource-read",
      uri: "version://info",
      expect: {
        schema: {
          type: "object",
          properties: {
            version: { type: "string" },
            name: { type: "string" },
          },
          required: ["version"],
        },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("runTest passes security check on clean echo tool (at critical threshold)", async () => {
    // The echo tool echoes back inputs, so it will get a prompt-injection finding
    // at "high" severity. At "critical" threshold, only critical findings fail the test.
    const result = await runner.runTest({
      id: "sec-1",
      name: "echo tool has no critical security findings",
      type: "security",
      tool: "echo",
      securityThreshold: "critical",
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("securityThreshold: 'high' allows HIGH findings — only CRITICAL fails (fix #10)", async () => {
    // echo echoes injection payloads → HIGH finding. With threshold "high",
    // HIGH is the maximum *allowed* severity, so the test should pass.
    const result = await runner.runTest({
      id: "sec-threshold-high",
      name: "echo: high threshold allows HIGH findings",
      type: "security",
      tool: "echo",
      securityThreshold: "high",
    });
    expect(result.passed).toBe(true);
  });

  it("securityThreshold: 'medium' (default) fails when HIGH findings exist", async () => {
    // echo echoes injection payloads → HIGH finding. With default threshold
    // "medium", anything above MEDIUM (i.e. HIGH+) causes failure.
    const result = await runner.runTest({
      id: "sec-threshold-medium",
      name: "echo: medium threshold fails on HIGH findings",
      type: "security",
      tool: "echo",
      securityThreshold: "medium",
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/high/i);
  });

  it("security test with expect.success:false on echo tool PASSES when findings detected (B4)", async () => {
    // echo has a HIGH prompt-injection finding; expect.success:false means we
    // expect findings — so the test should PASS when violations are found.
    const result = await runner.runTest({
      id: "sec-expect-false",
      name: "echo: expect findings detected",
      type: "security",
      tool: "echo",
      securityThreshold: "medium",
      expect: { success: false },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("security test with no tool field scans all tools without error (B4)", async () => {
    // Omitting `tool` triggers scan of all server tools — should not throw
    const result = await runner.runTest({
      id: "sec-scan-all",
      name: "scan all tools",
      type: "security",
      securityThreshold: "critical",
    });
    // echo-server tools are clean at critical threshold — should pass
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("runTest passes for prompt-get on greet prompt", async () => {
    const result = await runner.runTest({
      id: "prompt-1",
      name: "greet prompt returns greeting",
      type: "prompt-get",
      promptName: "greet",
      promptArgs: { name: "world" },
      expect: { contains: "Hello" },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("runTest fails resource-read when contains assertion does not match", async () => {
    const result = await runner.runTest({
      id: "res-fail",
      name: "resource contains mismatch",
      type: "resource-read",
      uri: "version://info",
      expect: { contains: "THIS_WILL_NEVER_BE_IN_THE_RESOURCE" },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("resource-read: success: true on valid URI passes", async () => {
    const result = await runner.runTest({
      id: "res-success-true",
      name: "version resource: success true",
      type: "resource-read",
      uri: "version://info",
      expect: { success: true },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("resource-read: success: true on invalid URI fails", async () => {
    const result = await runner.runTest({
      id: "res-success-true-invalid",
      name: "version resource: success true on invalid URI",
      type: "resource-read",
      uri: "nonexistent://bogus",
      expect: { success: true },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("resource-read: success: false on a valid URI fails (succeeded unexpectedly)", async () => {
    const result = await runner.runTest({
      id: "res-success-false-valid",
      name: "version resource: success false on valid URI",
      type: "resource-read",
      uri: "version://info",
      expect: { success: false },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/expected.*to fail.*succeeded/i);
  });

  it("resource-read: success: false on invalid URI passes (expected failure)", async () => {
    const result = await runner.runTest({
      id: "res-success-false-invalid",
      name: "version resource: success false on invalid URI",
      type: "resource-read",
      uri: "nonexistent://bogus",
      expect: { success: false },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("prompt-get: success: true on valid prompt passes", async () => {
    const result = await runner.runTest({
      id: "prompt-success-true",
      name: "greet prompt: success true",
      type: "prompt-get",
      promptName: "greet",
      promptArgs: { name: "world" },
      expect: { success: true },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("prompt-get: success: true on invalid prompt fails", async () => {
    const result = await runner.runTest({
      id: "prompt-success-true-invalid",
      name: "greet prompt: success true on invalid prompt",
      type: "prompt-get",
      promptName: "nonexistent_prompt",
      promptArgs: {},
      expect: { success: true },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("prompt-get: success: false on a valid prompt fails (succeeded unexpectedly)", async () => {
    const result = await runner.runTest({
      id: "prompt-success-false-valid",
      name: "greet prompt: success false on valid prompt",
      type: "prompt-get",
      promptName: "greet",
      promptArgs: { name: "world" },
      expect: { success: false },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/expected.*to fail.*succeeded/i);
  });

  it("prompt-get: success: false on invalid prompt passes (expected failure)", async () => {
    const result = await runner.runTest({
      id: "prompt-success-false-invalid",
      name: "greet prompt: success false on invalid prompt",
      type: "prompt-get",
      promptName: "nonexistent_prompt",
      promptArgs: {},
      expect: { success: false },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // ── Describe blocks ──────────────────────────────────────────────────────

  it("runCollection processes tests inside describe blocks", async () => {
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Describe test",
      server: { command: "node", args: [ECHO_SERVER] },
      describe: [
        {
          name: "echo group",
          tests: [
            {
              id: "d-echo",
              name: "describe echo test",
              type: "tool-call",
              tool: "echo",
              input: { message: "grouped" },
              expect: { success: true, contains: "grouped" },
            },
          ],
        },
      ],
      tests: [],
    };
    const summary = await runner.runCollection(collection);
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].testId).toBe("d-echo");
  });

  it("runCollection runs describe blocks before top-level tests", async () => {
    const executionOrder: string[] = [];
    const orderRunner = new TestRunner(client, {
      onTestEnd: (r) => executionOrder.push(r.testId),
    });
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Order test",
      server: { command: "node", args: [ECHO_SERVER] },
      describe: [
        {
          name: "group A",
          tests: [
            { id: "da-1", name: "A test", type: "tool-call", tool: "echo", input: { message: "a" }, expect: { success: true } },
          ],
        },
      ],
      tests: [
        { id: "top-1", name: "top test", type: "tool-call", tool: "echo", input: { message: "top" }, expect: { success: true } },
      ],
    };
    const summary = await orderRunner.runCollection(collection);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    // Describe block tests run before top-level tests
    expect(executionOrder).toEqual(["da-1", "top-1"]);
  });

  it("runCollection calls onDescribeStart for each describe block", async () => {
    const describeNames: string[] = [];
    const describeRunner = new TestRunner(client, {
      onDescribeStart: (name) => describeNames.push(name),
    });
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Describe callback test",
      server: { command: "node", args: [ECHO_SERVER] },
      describe: [
        {
          name: "alpha",
          tests: [{ id: "a1", name: "a", type: "protocol" }],
        },
        {
          name: "beta",
          tests: [{ id: "b1", name: "b", type: "protocol" }],
        },
      ],
      tests: [],
    };
    await describeRunner.runCollection(collection);
    expect(describeNames).toEqual(["alpha", "beta"]);
  });

  it("runCollection includes describe block hook results in hookResults", async () => {
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Describe hooks test",
      server: { command: "node", args: [ECHO_SERVER] },
      describe: [
        {
          name: "with hooks",
          hooks: {
            beforeAll: [
              { name: "group setup", run: { type: "tool-call", tool: "echo", input: { message: "setup" } } },
            ],
            afterAll: [
              { name: "group teardown", run: { type: "tool-call", tool: "echo", input: { message: "teardown" } } },
            ],
          },
          tests: [
            { id: "h1", name: "hook test", type: "tool-call", tool: "echo", input: { message: "hi" }, expect: { success: true } },
          ],
        },
      ],
      tests: [],
    };
    const summary = await runner.runCollection(collection);
    expect(summary.passed).toBe(1);
    // Both describe-level hooks should appear in hookResults
    const hookNames = summary.hookResults.map(h => h.name);
    expect(hookNames).toContain("group setup");
    expect(hookNames).toContain("group teardown");
  });

  it("runCollection correctly counts total across describe blocks and top-level tests", async () => {
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Count test",
      server: { command: "node", args: [ECHO_SERVER] },
      describe: [
        {
          name: "group1",
          tests: [
            { id: "g1", name: "g1", type: "protocol" },
            { id: "g2", name: "g2", type: "protocol" },
          ],
        },
      ],
      tests: [
        { id: "t1", name: "t1", type: "protocol" },
      ],
    };
    const summary = await runner.runCollection(collection);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
  });

  it("bail stops after first failure within a describe block and skips remaining groups", async () => {
    const bailRunner = new TestRunner(client, { bail: true });
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Bail in describe",
      server: { command: "node", args: [ECHO_SERVER] },
      describe: [
        {
          name: "first group",
          tests: [
            {
              id: "pass-first",
              name: "passes",
              type: "tool-call",
              tool: "echo",
              input: { message: "ok" },
              expect: { success: true, contains: "ok" },
            },
            {
              id: "fail-here",
              name: "fails deliberately",
              type: "tool-call",
              tool: "echo",
              input: { message: "hello" },
              expect: { success: true, contains: "IMPOSSIBLE_STRING_NEVER_FOUND" },
            },
          ],
        },
        {
          name: "second group",
          tests: [
            { id: "never-runs", name: "should be skipped", type: "protocol" },
          ],
        },
      ],
      tests: [
        { id: "also-skipped", name: "top-level skipped", type: "protocol" },
      ],
    };
    const summary = await bailRunner.runCollection(collection);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(2); // one from second group, one top-level
    expect(summary.total).toBe(4);
  });

  it("runCollection fires onDescribeEnd after each describe block completes", async () => {
    const describeEnds: string[] = [];
    const endRunner = new TestRunner(client, {
      onDescribeEnd: (name) => describeEnds.push(name),
    });
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "DescribeEnd test",
      server: { command: "node", args: [ECHO_SERVER] },
      describe: [
        {
          name: "alpha",
          tests: [{ id: "a1", name: "a", type: "protocol" }],
        },
        {
          name: "beta",
          tests: [{ id: "b1", name: "b", type: "protocol" }],
        },
      ],
      tests: [],
    };
    await endRunner.runCollection(collection);
    expect(describeEnds).toEqual(["alpha", "beta"]);
  });

  // ── New assertions: equals, notContains, matches, jsonPath ──────────────

  it("tool-call: equals passes when response exactly matches", async () => {
    const result = await runner.runTest({
      id: "eq-pass",
      name: "echo exact match",
      type: "tool-call",
      tool: "echo",
      input: { message: "exact-value" },
      expect: { equals: "exact-value" },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("tool-call: equals fails when response does not match exactly", async () => {
    const result = await runner.runTest({
      id: "eq-fail",
      name: "echo exact mismatch",
      type: "tool-call",
      tool: "echo",
      input: { message: "hello world" },
      expect: { equals: "hello" },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("tool-call: notContains passes when string is absent", async () => {
    const result = await runner.runTest({
      id: "nc-pass",
      name: "echo notContains passes",
      type: "tool-call",
      tool: "echo",
      input: { message: "hello" },
      expect: { notContains: "ABSENT" },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("tool-call: notContains fails when string is present", async () => {
    const result = await runner.runTest({
      id: "nc-fail",
      name: "echo notContains fails",
      type: "tool-call",
      tool: "echo",
      input: { message: "hello world" },
      expect: { notContains: "hello" },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("tool-call: matches passes when regex matches", async () => {
    const result = await runner.runTest({
      id: "match-pass",
      name: "echo regex match",
      type: "tool-call",
      tool: "echo",
      input: { message: "user-42" },
      expect: { matches: "^user-\\d+$" },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("tool-call: matches fails when regex does not match", async () => {
    const result = await runner.runTest({
      id: "match-fail",
      name: "echo regex no match",
      type: "tool-call",
      tool: "echo",
      input: { message: "hello" },
      expect: { matches: "^\\d+$" },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("tool-call: jsonPath extracts and asserts nested field correctly", async () => {
    // echo returns the message verbatim — send JSON so jsonPath can parse it
    const result = await runner.runTest({
      id: "jp-pass",
      name: "echo jsonPath equals",
      type: "tool-call",
      tool: "echo",
      input: { message: '{"user":{"id":"abc123"}}' },
      expect: { jsonPath: [{ path: "$.user.id", equals: "abc123" }] },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("tool-call: jsonPath fails when extracted value does not match", async () => {
    const result = await runner.runTest({
      id: "jp-eq-fail",
      name: "echo jsonPath equals mismatch",
      type: "tool-call",
      tool: "echo",
      input: { message: '{"user":{"id":"abc123"}}' },
      expect: { jsonPath: [{ path: "$.user.id", equals: "wrong-id" }] },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/jsonPath.*expected.*wrong-id/i);
  });

  it("tool-call: jsonPath fails with clear message when path matches nothing", async () => {
    const result = await runner.runTest({
      id: "jp-missing",
      name: "echo jsonPath missing path",
      type: "tool-call",
      tool: "echo",
      input: { message: '{"user":{"id":"abc"}}' },
      expect: { jsonPath: [{ path: "$.nonexistent.field", equals: "x" }] },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/matched nothing/i);
  });

  it("tool-call: jsonPath contains assertion works", async () => {
    const result = await runner.runTest({
      id: "jp-contains",
      name: "echo jsonPath contains",
      type: "tool-call",
      tool: "echo",
      input: { message: '{"message":"hello world"}' },
      expect: { jsonPath: [{ path: "$.message", contains: "hello" }] },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("tool-call: jsonPath matches assertion works", async () => {
    const result = await runner.runTest({
      id: "jp-matches",
      name: "echo jsonPath matches regex",
      type: "tool-call",
      tool: "echo",
      input: { message: '{"code":"ERR-42"}' },
      expect: { jsonPath: [{ path: "$.code", matches: "^ERR-\\d+$" }] },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("tool-call: jsonPath object shorthand is normalized and evaluated correctly", async () => {
    // The object shorthand { path, equals } is normalized to [{ path, equals }] by
    // collectionSchema. This test exercises the full schema-parse → runner path to
    // confirm the shorthand reaches the runner in the expected array form.
    const raw = {
      version: "1.0",
      name: "jsonPath object shorthand test",
      server: { command: "node", args: [ECHO_SERVER] },
      tests: [
        {
          id: "jp-shorthand",
          name: "echo jsonPath object shorthand",
          type: "tool-call",
          tool: "echo",
          input: { message: '{"result":"42"}' },
          expect: { jsonPath: { path: "$.result", equals: "42" } },
        },
      ],
    };
    const collection = collectionSchema.parse(raw);
    const summary = await runner.runCollection(collection);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results[0].passed).toBe(true);
    expect(summary.results[0].error).toBeUndefined();
  });

  it("tool-call: jsonPath object shorthand produces same result as array form", async () => {
    // Verify that { path, equals } and [{ path, equals }] produce identical outcomes.
    const buildRaw = (jsonPath: unknown) => ({
      version: "1.0",
      name: "jsonPath equivalence test",
      server: { command: "node", args: [ECHO_SERVER] },
      tests: [
        {
          id: "jp-equiv",
          name: "echo jsonPath equiv",
          type: "tool-call",
          tool: "echo",
          input: { message: '{"value":"hello"}' },
          expect: { jsonPath },
        },
      ],
    });

    const objectForm = collectionSchema.parse(
      buildRaw({ path: "$.value", equals: "hello" })
    );
    const arrayForm = collectionSchema.parse(
      buildRaw([{ path: "$.value", equals: "hello" }])
    );

    // Both should normalize to the same array shape
    const objectJsonPath = (objectForm.tests[0] as { expect?: { jsonPath?: unknown } }).expect?.jsonPath;
    const arrayJsonPath = (arrayForm.tests[0] as { expect?: { jsonPath?: unknown } }).expect?.jsonPath;
    expect(objectJsonPath).toEqual(arrayJsonPath);

    // Both should produce a passing test result
    const objectResult = await runner.runCollection(objectForm);
    const arrayResult = await runner.runCollection(arrayForm);
    expect(objectResult.passed).toBe(1);
    expect(arrayResult.passed).toBe(1);
    expect(objectResult.results[0].passed).toBe(true);
    expect(arrayResult.results[0].passed).toBe(true);
  });

  // ── Test-level capture ────────────────────────────────────────────────────

  it("capture: passing tool-call writes extracted value to context for use in next test", async () => {
    // Test 1: echo a JSON payload and capture a field from it.
    // Test 2: use {{capturedId}} in its input — should resolve to the captured value.
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Capture chain test",
      server: { command: "node", args: [ECHO_SERVER] },
      tests: [
        {
          id: "capture-source",
          name: "echo JSON and capture id",
          type: "tool-call",
          tool: "echo",
          input: { message: '{"id":"user-99"}' },
          expect: { success: true },
          capture: { capturedId: "$.id" },
        },
        {
          id: "capture-consumer",
          name: "use captured id in input",
          type: "tool-call",
          tool: "echo",
          input: { message: "{{capturedId}}" },
          expect: { success: true, equals: "user-99" },
        },
      ],
    };
    const summary = await runner.runCollection(collection);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it("capture: failing test does NOT write to context", async () => {
    // Test 1: fails its assertion — capture should NOT set the variable.
    // Test 2: uses {{missedCapture}} — should remain unresolved (literal string).
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Capture fail test",
      server: { command: "node", args: [ECHO_SERVER] },
      tests: [
        {
          id: "capture-fail-source",
          name: "fails and should not capture",
          type: "tool-call",
          tool: "echo",
          input: { message: '{"id":"user-99"}' },
          // This assertion will fail because echo doesn't return "IMPOSSIBLE"
          expect: { contains: "IMPOSSIBLE_STRING" },
          capture: { missedCapture: "$.id" },
        },
        {
          id: "capture-fail-consumer",
          name: "placeholder stays unresolved",
          type: "tool-call",
          tool: "echo",
          // Since capture didn't run, {{missedCapture}} stays as a literal string.
          // The echo tool returns it verbatim — so equals check shows it was NOT resolved.
          input: { message: "{{missedCapture}}" },
          expect: { equals: "{{missedCapture}}" },
        },
      ],
    };
    const summary = await runner.runCollection(collection);
    // First test fails, second passes (because {{missedCapture}} was not resolved)
    expect(summary.failed).toBe(1);
    expect(summary.results[0]!.passed).toBe(false);
    expect(summary.results[1]!.passed).toBe(true);
  });

  it("capture: unmatched path warns but does not fail the test", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const collection: CheckSpecCollection = {
        version: "1.0",
        name: "Capture warn test",
        server: { command: "node", args: [ECHO_SERVER] },
        tests: [
          {
            id: "capture-missing-path",
            name: "capture path that does not exist",
            type: "tool-call",
            tool: "echo",
            input: { message: '{"id":"user-1"}' },
            expect: { success: true },
            capture: { noSuchField: "$.nonexistent.field" },
          },
        ],
      };
      const summary = await runner.runCollection(collection);
      // Test should still pass
      expect(summary.passed).toBe(1);
      expect(summary.failed).toBe(0);
      // A warning should have been emitted
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("matched nothing")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("capture: works on resource-read result", async () => {
    // version://info returns JSON with a "version" field
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Capture resource test",
      server: { command: "node", args: [ECHO_SERVER] },
      tests: [
        {
          id: "capture-resource",
          name: "capture version from resource",
          type: "resource-read",
          uri: "version://info",
          expect: { contains: "version" },
          capture: { serverVersion: "$.version" },
        },
        {
          id: "use-captured-version",
          name: "use captured version in echo",
          type: "tool-call",
          tool: "echo",
          input: { message: "{{serverVersion}}" },
          expect: { success: true, equals: "1.0.0" },
        },
      ],
    };
    const summary = await runner.runCollection(collection);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it("capture: works on prompt-get result", async () => {
    // greet prompt returns "Hello, world!" — capture the text via a simple path
    // Since the text is not JSON, extractValue won't find $.greeting, and will warn.
    // This test verifies that prompt-get capture runs and warns gracefully.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const collection: CheckSpecCollection = {
        version: "1.0",
        name: "Capture prompt test",
        server: { command: "node", args: [ECHO_SERVER] },
        tests: [
          {
            id: "capture-prompt",
            name: "capture from prompt-get",
            type: "prompt-get",
            promptName: "greet",
            promptArgs: { name: "Alice" },
            expect: { contains: "Hello" },
            capture: { greeting: "$.greeting" },
          },
        ],
      };
      const summary = await runner.runCollection(collection);
      // Test passes even though capture path won't match (non-JSON response)
      expect(summary.passed).toBe(1);
      expect(summary.failed).toBe(0);
      // Warning is emitted for the unmatched path
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("matched nothing")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("capture: works on streaming-tool-call finalResult", async () => {
    // Spy on callToolStreaming to return a known JSON payload as finalResult
    // without needing a real streaming server.
    const streamingSpy = vi
      .spyOn(client, "callToolStreaming")
      .mockImplementation(
        async (
          _name: string,
          _args: Record<string, unknown>,
          _onChunk: (params: { progress: number; total?: number; message?: string; timestamp: number }) => void
        ) => ({
          content: [{ type: "text" as const, text: '{"streamId":"stream-42"}' }],
        })
      );
    try {
      const collection: CheckSpecCollection = {
        version: "1.0",
        name: "Capture streaming test",
        server: { command: "node", args: [ECHO_SERVER] },
        tests: [
          {
            id: "capture-streaming",
            name: "streaming-tool-call capture",
            type: "streaming-tool-call",
            tool: "mock_stream",
            input: {},
            streamExpect: { minChunks: 0 },
            capture: { streamId: "$.streamId" },
          },
          {
            id: "use-captured-stream-id",
            name: "use captured streamId in echo",
            type: "tool-call",
            tool: "echo",
            input: { message: "{{streamId}}" },
            expect: { success: true, equals: "stream-42" },
          },
        ],
      };
      const summary = await runner.runCollection(collection);
      expect(summary.passed).toBe(2);
      expect(summary.failed).toBe(0);
    } finally {
      streamingSpy.mockRestore();
    }
  });

  it("runCollection expands parametrized tests inside describe blocks", async () => {
    const collection: CheckSpecCollection = {
      version: "1.0",
      name: "Describe + parametrize",
      server: { command: "node", args: [ECHO_SERVER] },
      describe: [
        {
          name: "echo variants",
          tests: [
            {
              id: "echo-param",
              name: "echo parametrized",
              type: "tool-call" as const,
              tool: "echo",
              input: { message: "" },
              expect: { success: true },
              parametrize: [
                { label: "hello", input: { message: "hello" }, expect: { contains: "hello" } },
                { label: "world", input: { message: "world" }, expect: { contains: "world" } },
                { label: "test",  input: { message: "test" },  expect: { contains: "test" } },
              ],
            },
          ],
        },
      ],
      tests: [],
    };
    const summary = await runner.runCollection(collection);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.parametrizedSourceCount).toBe(1);
  });
});

// ── Per-test timeout tests (against buggy-server's slow-op) ─────────────────

describe("TestRunner per-test timeoutMs (against buggy-server)", () => {
  let buggyClient: MCPRecordingClient;
  let buggyRunner: TestRunner;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [BUGGY_SERVER],
    });
    buggyClient = new MCPRecordingClient(transport);
    await buggyClient.connect();
    // Use a generous RunnerOptions.timeout (20 s) so per-test timeoutMs can override it down
    buggyRunner = new TestRunner(buggyClient, { timeout: 20_000 });
  });

  afterAll(async () => {
    await buggyClient.disconnect();
  });

  it("slow-op with per-test timeoutMs: 500 fails with timeout message", async () => {
    const result = await buggyRunner.runTest({
      id: "timeout-per-test",
      name: "slow-op per-test timeout",
      type: "tool-call",
      tool: "slow-op",
      input: {},
      timeoutMs: 500,
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/timed out after 500ms/i);
    expect(result.error).toContain("slow-op per-test timeout");
  });

  it("fast test with generous timeoutMs passes normally", async () => {
    const fastRunner = new TestRunner(buggyClient, { timeout: 5_000 });
    // divide tool responds immediately with a valid result
    const result = await fastRunner.runTest({
      id: "fast-with-timeout",
      name: "divide responds quickly",
      type: "tool-call",
      tool: "divide",
      input: { a: 10, b: 2 },
      timeoutMs: 10_000,
      expect: { success: true, contains: "5" },
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("per-test timeoutMs overrides RunnerOptions.timeout", async () => {
    // Runner has timeout: 20_000, but the test overrides with 500 ms
    const result = await buggyRunner.runTest({
      id: "timeout-override",
      name: "slow-op override timeout",
      type: "tool-call",
      tool: "slow-op",
      input: {},
      timeoutMs: 500,
    });
    // Should fail in ~500 ms, NOT wait for the 20 s runner-level timeout
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/timed out after 500ms/i);
  });

  it("RunnerOptions.timeout is used when per-test timeoutMs is absent", async () => {
    // Build a runner with a short global timeout; no per-test override
    const shortRunner = new TestRunner(buggyClient, { timeout: 500 });
    const result = await shortRunner.runTest({
      id: "timeout-runner-level",
      name: "slow-op runner-level timeout",
      type: "tool-call",
      tool: "slow-op",
      input: {},
      // No timeoutMs — should fall back to RunnerOptions.timeout: 500
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/timed out after 500ms/i);
  });
});
