/**
 * Unit tests for collectionSchema.
 *
 * These are pure unit tests — no live server, no filesystem reads, no async.
 * Run with:  npx vitest run packages/core/src/schema/collectionSchema.test.ts
 *
 * ── Actual Zod error messages for common mistakes ──────────────────────────
 *
 * Typo in expect block:
 *   Validation error: Unrecognized key(s) in object: 'sucess' at "tests[0].expect"
 *
 * retry out of range:
 *   Validation error: Number must be less than or equal to 5 at "tests[0].retry"
 *
 * Empty parametrize label:
 *   Validation error: label must not be empty at "tests[0].parametrize[0].label"
 *
 * Unknown key in parametrize row:
 *   Validation error: Unrecognized key(s) in object: 'exepct' at "tests[0].parametrize[0]"
 *
 * Unknown key in row-level expect:
 *   Validation error: Unrecognized key(s) in object: 'sucess' at "tests[0].parametrize[0].expect"
 */
import { describe, it, expect } from "vitest";
import { collectionSchema, validateCollection } from "./collectionSchema.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Minimal valid server block — reused across tests */
const minimalServer = { command: "node", args: ["dist/index.js"] };

/** Validate and return the human-readable error message (asserts failure first) */
function parseError(input: unknown): string {
  const result = validateCollection(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected failure"); // type narrowing
  return result.message;
}

// ── Valid collections ──────────────────────────────────────────────────────

describe("valid collections", () => {
  it("parses a minimal collection (name + server + one tool-call test)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Minimal",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "add › 1+1",
          type: "tool-call",
          tool: "add",
          input: { a: 1, b: 1 },
          expect: { success: true, contains: "2" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts tests without an id field (id is optional, auto-generated at runtime)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "No IDs",
      server: minimalServer,
      tests: [
        {
          name: "echo works",
          type: "tool-call",
          tool: "echo",
          input: { message: "hi" },
          expect: { success: true },
        },
        {
          name: "another tool",
          type: "tool-call",
          tool: "greet",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("parses a collection with a streaming-tool-call test and streamExpect", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Streaming",
      server: minimalServer,
      tests: [
        {
          id: "s1",
          name: "countdown › streams 5 chunks",
          type: "streaming-tool-call",
          tool: "stream_countdown",
          input: { from: 5 },
          streamExpect: {
            minChunks: 5,
            chunkContains: "tick",
            maxChunkIntervalMs: 500,
            finalContains: "done",
            maxTotalMs: 3000,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("parses a collection with all four hook phases populated", () => {
    const hookEntry = {
      name: "seed user",
      run: { type: "tool-call", tool: "create_user", input: { id: "alice" } },
    };
    const shellHook = {
      name: "cleanup",
      run: { type: "shell", command: "rm", args: ["-f", "/tmp/test.db"] },
    };
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "With hooks",
      server: minimalServer,
      hooks: {
        beforeAll: [hookEntry],
        afterAll: [shellHook],
        beforeEach: [{ name: "ping", run: { type: "tool-call", tool: "ping", input: {} } }],
        afterEach: [{ name: "cleanup each", run: { type: "shell", command: "echo", args: ["done"] } }],
      },
      tests: [{ id: "t1", name: "pass", type: "protocol" }],
    });
    expect(result.success).toBe(true);
  });

  it("parses a collection with concurrency set", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Concurrent",
      server: minimalServer,
      tests: [{ id: "t1", name: "test", type: "tool-call", tool: "echo" }],
      concurrency: 4,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concurrency).toBe(4);
    }
  });

  it("parses when all optional fields are omitted", () => {
    // No description, no hooks, no expect, no input, no tags
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Bare minimum",
      server: { command: "node" },
      tests: [{ id: "p1", name: "init", type: "protocol" }],
    });
    expect(result.success).toBe(true);
  });

  it("parses every test type in a single collection", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "All types",
      server: minimalServer,
      tests: [
        { id: "a", name: "protocol", type: "protocol" },
        { id: "b", name: "tool-call", type: "tool-call", tool: "add", input: { a: 1 } },
        { id: "c", name: "security", type: "security", tool: "add", securityThreshold: "high" },
        { id: "d", name: "fuzz", type: "fuzz", tool: "add" },
        { id: "e", name: "resource-read", type: "resource-read", uri: "notes://count" },
        { id: "f", name: "prompt-get", type: "prompt-get", promptName: "summarize" },
        {
          id: "g",
          name: "streaming",
          type: "streaming-tool-call",
          tool: "countdown",
          input: {},
          streamExpect: { minChunks: 3 },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts server.env and server.cwd", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Python server",
      server: {
        command: "uv",
        args: ["run", "server.py"],
        cwd: "/projects/my-server",
        env: { LOG_LEVEL: "WARNING", PORT: "8080" },
      },
      tests: [{ id: "t1", name: "init", type: "protocol" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts expect with schema field", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Schema test",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "get_user › returns schema",
          type: "tool-call",
          tool: "get_user",
          input: { id: "alice" },
          expect: {
            success: true,
            schema: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" } },
              required: ["id", "name"],
            },
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts hook with failFast and timeoutMs overrides", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Hook config",
      server: minimalServer,
      hooks: {
        beforeAll: [
          {
            name: "slow seed",
            run: { type: "tool-call", tool: "seed_db", input: {} },
            failFast: false,
            timeoutMs: 30000,
          },
        ],
      },
      tests: [{ id: "t1", name: "init", type: "protocol" }],
    });
    expect(result.success).toBe(true);
  });
});

// ── Invalid collections — expect block typos ───────────────────────────────

describe("invalid: typos in expect block", () => {
  it("rejects unknown key 'sucess' in expect block", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "bad expect",
          type: "tool-call",
          tool: "add",
          input: { a: 1 },
          expect: { sucess: true },
        },
      ],
    });
    expect(msg).toContain("sucess");
  });

  it("rejects unknown key 'contians' in expect block", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "bad expect",
          type: "tool-call",
          tool: "add",
          input: { a: 1 },
          expect: { contians: "hello" },
        },
      ],
    });
    expect(msg).toContain("contians");
  });

  it("rejects multiple unknown keys in expect block", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "bad expect",
          type: "tool-call",
          tool: "add",
          input: {},
          expect: { sucess: true, executionTime: 500 }, // executionTime instead of executionTimeMs
        },
      ],
    });
    // At least one of the bad keys must appear in the message
    expect(msg.includes("sucess") || msg.includes("executionTime")).toBe(true);
  });
});

// ── Invalid collections — streamExpect block typos ─────────────────────────

describe("invalid: typos in streamExpect block", () => {
  it("rejects unknown key 'finalContians' in streamExpect block", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "s1",
          name: "bad stream",
          type: "streaming-tool-call",
          tool: "countdown",
          input: {},
          streamExpect: { finalContians: "done" },
        },
      ],
    });
    expect(msg).toContain("finalContians");
  });

  it("rejects unknown key 'minChunk' (missing 's') in streamExpect block", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "s1",
          name: "bad stream",
          type: "streaming-tool-call",
          tool: "countdown",
          input: {},
          streamExpect: { minChunk: 3 },
        },
      ],
    });
    expect(msg).toContain("minChunk");
  });
});

// ── Invalid collections — missing required fields ──────────────────────────

describe("invalid: missing required fields", () => {
  it("rejects a tool-call test with no 'tool' field", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "missing tool",
          type: "tool-call",
          // tool: missing
          input: { a: 1 },
        },
      ],
    });
    expect(msg.toLowerCase()).toMatch(/tool|required/);
  });

  it("rejects a streaming test with no 'streamExpect' field", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "s1",
          name: "missing streamExpect",
          type: "streaming-tool-call",
          tool: "countdown",
          input: {},
          // streamExpect: missing
        },
      ],
    });
    expect(msg.toLowerCase()).toMatch(/streamexpect|required/);
  });

  it("rejects a server block with no 'command' field", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: { args: ["dist/index.js"] }, // command missing
      tests: [{ id: "t1", name: "init", type: "protocol" }],
    });
    expect(msg.toLowerCase()).toMatch(/command|required/);
  });

  it("accepts a collection with no 'tests' field (defaults to empty array)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "No tests",
      server: minimalServer,
      // tests: omitted
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tests).toEqual([]);
    }
  });

  it("parses a collection with describe blocks and no top-level tests field", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Describe only",
      server: minimalServer,
      describe: [
        {
          name: "auth tools",
          tests: [
            { id: "t1", name: "login", type: "tool-call", tool: "login", input: { user: "admin" } },
          ],
        },
      ],
      // tests: omitted entirely
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tests).toEqual([]);
    }
  });
});

// ── Invalid collections — wrong types ─────────────────────────────────────

describe("invalid: wrong value types", () => {
  it("rejects 'input' as a string (must be object)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "bad input",
          type: "tool-call",
          tool: "add",
          input: "this should be an object",
        },
      ],
    });
    expect(msg.toLowerCase()).toMatch(/input|object|expected/);
  });

  it("rejects 'streamExpect.minChunks' as a string (must be number)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "s1",
          name: "bad minChunks",
          type: "streaming-tool-call",
          tool: "countdown",
          input: {},
          streamExpect: { minChunks: "five" },
        },
      ],
    });
    expect(msg.toLowerCase()).toMatch(/minchunks|number|expected/);
  });

  it("rejects version '2.0' (only '1.0' is valid)", () => {
    const msg = parseError({
      version: "2.0",
      name: "Broken",
      server: minimalServer,
      tests: [],
    });
    expect(msg.toLowerCase()).toMatch(/version|invalid/);
  });
});

// ── Invalid collections — concurrency ────────────────────────────────────

describe("invalid: concurrency", () => {
  it("rejects concurrency: 0 (must be >= 1)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [{ id: "t1", name: "t", type: "protocol" }],
      concurrency: 0,
    });
    expect(msg.toLowerCase()).toMatch(/concurrency|number|too_small/);
  });

  it("rejects concurrency: -1 (must be >= 1)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [{ id: "t1", name: "t", type: "protocol" }],
      concurrency: -1,
    });
    expect(msg.toLowerCase()).toMatch(/concurrency|number|too_small/);
  });

  it("rejects concurrency: 1.5 (must be integer)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [{ id: "t1", name: "t", type: "protocol" }],
      concurrency: 1.5,
    });
    expect(msg.toLowerCase()).toMatch(/concurrency|integer/);
  });

  it("rejects concurrency: 51 (max is 50)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [{ id: "t1", name: "t", type: "protocol" }],
      concurrency: 51,
    });
    expect(msg.toLowerCase()).toMatch(/concurrency|too_big|number/);
  });
});

// ── Invalid collections — unknown test type ────────────────────────────────

describe("invalid: unknown test type", () => {
  it("rejects type: 'banana' with a discriminated union error", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "bad type",
          type: "banana",
          tool: "add",
          input: {},
        },
      ],
    });
    // Should mention the invalid value or the discriminated union
    expect(msg.toLowerCase()).toMatch(/banana|invalid_union|type/);
  });

  it("rejects type: 'http-call' hook command with a clear error", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      hooks: {
        beforeAll: [
          {
            name: "bad hook",
            run: { type: "http", url: "https://example.com" },
          },
        ],
      },
      tests: [{ id: "t1", name: "init", type: "protocol" }],
    });
    expect(msg.toLowerCase()).toMatch(/http|type|invalid/);
  });
});

// ── Invalid collections — securityThreshold enum ──────────────────────────

describe("invalid: bad securityThreshold value", () => {
  it("rejects securityThreshold: 'extreme' (not in enum)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "bad threshold",
          type: "security",
          tool: "add",
          securityThreshold: "extreme",
        },
      ],
    });
    expect(msg.toLowerCase()).toMatch(/extreme|securitythreshold|invalid/);
  });
});

// ── Security test: expect field (B4) ──────────────────────────────────────

describe("valid: security test accepts expect field", () => {
  it("parses security test with expect: { success: false }", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Security expect",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "expect findings",
          type: "security",
          tool: "add",
          securityThreshold: "medium",
          expect: { success: false },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("parses security test without tool field (scan-all)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Security scan all",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "scan all tools",
          type: "security",
          securityThreshold: "critical",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ── Describe blocks ──────────────────────────────────────────────────────

describe("valid: describe blocks", () => {
  it("parses a collection with one describe block and empty top-level tests", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Describe only",
      server: minimalServer,
      describe: [
        {
          name: "auth tools",
          tests: [
            { id: "t1", name: "login", type: "tool-call", tool: "login", input: { user: "admin" } },
          ],
        },
      ],
      tests: [],
    });
    expect(result.success).toBe(true);
  });

  it("parses a collection with multiple describe blocks and top-level tests", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Mixed",
      server: minimalServer,
      describe: [
        {
          name: "auth",
          tests: [
            { id: "a1", name: "login", type: "tool-call", tool: "login", input: {} },
          ],
        },
        {
          name: "public",
          tests: [
            { id: "p1", name: "version", type: "protocol" },
          ],
        },
      ],
      tests: [
        { id: "t1", name: "ungrouped", type: "protocol" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("parses a describe block with per-group hooks", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Describe with hooks",
      server: minimalServer,
      describe: [
        {
          name: "stateful group",
          hooks: {
            beforeAll: [
              { name: "seed", run: { type: "tool-call", tool: "seed", input: { data: "test" } } },
            ],
            afterAll: [
              { name: "cleanup", run: { type: "shell", command: "echo", args: ["done"] } },
            ],
            beforeEach: [
              { name: "ping", run: { type: "tool-call", tool: "ping", input: {} } },
            ],
          },
          tests: [
            { id: "s1", name: "stateful test", type: "tool-call", tool: "get", input: {} },
          ],
        },
      ],
      tests: [],
    });
    expect(result.success).toBe(true);
  });

  it("parses a collection with describe blocks containing parametrized tests", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Parametrize in describe",
      server: minimalServer,
      describe: [
        {
          name: "math",
          tests: [
            {
              id: "add",
              name: "add",
              type: "tool-call",
              tool: "add",
              input: { a: 0, b: 0 },
              expect: { success: true },
              parametrize: [
                { label: "1+1", input: { a: 1, b: 1 }, expect: { contains: "2" } },
                { label: "2+3", input: { a: 2, b: 3 }, expect: { contains: "5" } },
              ],
            },
          ],
        },
      ],
      tests: [],
    });
    expect(result.success).toBe(true);
  });

  it("allows describe to be omitted (backwards compatible)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "No describe",
      server: minimalServer,
      tests: [{ id: "t1", name: "init", type: "protocol" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.describe).toBeUndefined();
    }
  });
});

describe("valid: new assertion fields (equals, notContains, matches, jsonPath)", () => {
  it("accepts equals in expect block", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Equals test",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "exact match",
          type: "tool-call",
          tool: "echo",
          input: { message: "hi" },
          expect: { equals: "hi" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts notContains in expect block", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "notContains test",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "absence check",
          type: "tool-call",
          tool: "echo",
          input: { message: "hello" },
          expect: { notContains: "error" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts matches in expect block", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "matches test",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "regex match",
          type: "tool-call",
          tool: "echo",
          input: { message: "user-42" },
          expect: { matches: "^user-\\d+$" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts jsonPath with equals, contains, and matches fields", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "jsonPath test",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "jsonPath assertions",
          type: "tool-call",
          tool: "get_user",
          input: { id: "alice" },
          expect: {
            jsonPath: [
              { path: "$.user.id", equals: "alice" },
              { path: "$.user.name", contains: "Ali" },
              { path: "$.user.email", matches: "@example\\.com$" },
            ],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts all new expect fields combined", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "all new fields",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "all assertions",
          type: "tool-call",
          tool: "greet",
          input: { name: "Alice" },
          expect: {
            success: true,
            contains: "Alice",
            notContains: "error",
            equals: "Hello, Alice!",
            matches: "^Hello",
            jsonPath: [{ path: "$.greeting", equals: "Hello, Alice!" }],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts new fields in parametrize row expect (partial override)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "parametrize new fields",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "parametrized with new assertions",
          type: "tool-call",
          tool: "echo",
          input: { message: "" },
          expect: { success: true },
          parametrize: [
            {
              label: "exact",
              input: { message: "hi" },
              expect: { equals: "hi", notContains: "error", matches: "^hi$" },
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown key inside a jsonPath entry (strictObject)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      tests: [
        {
          id: "t1",
          name: "bad jsonPath entry",
          type: "tool-call",
          tool: "get_user",
          input: {},
          expect: {
            jsonPath: [
              { path: "$.id", equls: "alice" }, // typo: equls
            ],
          },
        },
      ],
    });
    expect(msg).toContain("equls");
  });

  it("accepts jsonPath as a single object (shorthand)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "jsonPath shorthand",
      server: minimalServer,
      tests: [{
        id: "t1",
        name: "test",
        type: "tool-call",
        tool: "my_tool",
        input: {},
        expect: { jsonPath: { path: "$.id", equals: "alice" } },
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const test = result.data.tests[0] as { expect?: { jsonPath?: unknown[] } };
      expect(test.expect!.jsonPath).toEqual([{ path: "$.id", equals: "alice" }]);
    }
  });

  it("normalizes single jsonPath object to array after parse", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "jsonPath normalize",
      server: minimalServer,
      tests: [{
        id: "t1",
        name: "test",
        type: "tool-call",
        tool: "my_tool",
        input: {},
        expect: { jsonPath: { path: "$.x", equals: "y" } },
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const test = result.data.tests[0] as { expect?: { jsonPath?: unknown[] } };
      expect(Array.isArray(test.expect!.jsonPath)).toBe(true);
      expect(test.expect!.jsonPath).toHaveLength(1);
    }
  });

  it("rejects unknown key inside single jsonPath object (strictObject)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "jsonPath typo",
      server: minimalServer,
      tests: [{
        id: "t1",
        name: "test",
        type: "tool-call",
        tool: "my_tool",
        input: {},
        expect: { jsonPath: { path: "$.id", equls: "alice" } },
      }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts jsonPath array (existing behavior unchanged)", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "jsonPath array",
      server: minimalServer,
      tests: [{
        id: "t1",
        name: "test",
        type: "tool-call",
        tool: "my_tool",
        input: {},
        expect: { jsonPath: [{ path: "$.id", equals: "alice" }] },
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const test = result.data.tests[0] as { expect?: { jsonPath?: unknown[] } };
      expect(test.expect!.jsonPath).toEqual([{ path: "$.id", equals: "alice" }]);
    }
  });
});

describe("invalid: describe blocks", () => {
  it("rejects a describe block with no name", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      describe: [
        {
          // name: missing
          tests: [{ id: "t1", name: "test", type: "protocol" }],
        },
      ],
      tests: [],
    });
    expect(msg.toLowerCase()).toMatch(/name|required/);
  });

  it("rejects a describe block with no tests field", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      describe: [
        { name: "empty group" },
      ],
      tests: [],
    });
    expect(msg.toLowerCase()).toMatch(/tests|required/);
  });

  it("rejects a typo in expect block inside a describe block test", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: minimalServer,
      describe: [
        {
          name: "bad group",
          tests: [
            {
              id: "t1",
              name: "bad expect",
              type: "tool-call",
              tool: "add",
              input: {},
              expect: { sucess: true },
            },
          ],
        },
      ],
      tests: [],
    });
    expect(msg).toContain("sucess");
  });
});

// ── HTTP / URL-based server config ─────────────────────────────────────────

const minimalTest = [{ id: "t1", name: "init", type: "protocol" }];

describe("valid: server.url (HTTP transport)", () => {
  it("accepts a collection with server.url only", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "HTTP server",
      server: { url: "http://localhost:3001/mcp" },
      tests: minimalTest,
    });
    expect(result.success).toBe(true);
  });

  it("accepts server.url with transport: streamable-http", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "HTTP streamable",
      server: { url: "http://localhost:3001/mcp", transport: "streamable-http" },
      tests: minimalTest,
    });
    expect(result.success).toBe(true);
  });

  it("accepts server.url with transport: sse", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "SSE server",
      server: { url: "http://localhost:3001/sse", transport: "sse" },
      tests: minimalTest,
    });
    expect(result.success).toBe(true);
  });

  it("accepts server.url with headers", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Authenticated HTTP",
      server: {
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer tok123" },
      },
      tests: minimalTest,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.server.headers?.["Authorization"]).toBe("Bearer tok123");
    }
  });

  it("accepts server.url with transport: sse and headers together", () => {
    const result = collectionSchema.safeParse({
      version: "1.0",
      name: "Auth SSE",
      server: {
        url: "http://internal.example.com/sse",
        transport: "sse",
        headers: { "X-Api-Key": "secret" },
      },
      tests: minimalTest,
    });
    expect(result.success).toBe(true);
  });
});

describe("invalid: server config mutual exclusion", () => {
  it("rejects a collection with neither command nor url", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: {},
      tests: minimalTest,
    });
    expect(msg.toLowerCase()).toMatch(/command|url|requires/);
  });

  it("rejects a collection with both command and url", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: { command: "node", url: "http://localhost:3001/mcp" },
      tests: minimalTest,
    });
    expect(msg.toLowerCase()).toMatch(/command|url|both/);
  });

  it("rejects server.url with an invalid URL string", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: { url: "not-a-url" },
      tests: minimalTest,
    });
    expect(msg.toLowerCase()).toMatch(/url|invalid/);
  });

  it("rejects server.transport: 'ws' (not in enum)", () => {
    const msg = parseError({
      version: "1.0",
      name: "Broken",
      server: { url: "http://localhost:3001/mcp", transport: "ws" },
      tests: minimalTest,
    });
    expect(msg.toLowerCase()).toMatch(/transport|invalid/);
  });
});
