/**
 * Zod schema for the CheckSpec collection format (.checkspec.json).
 *
 * Mirrors every field in TestCollection.ts so that JSON loaded from disk
 * is fully validated before it reaches the runner.  Unknown keys in
 * `expect` and `streamExpect` blocks are rejected via z.strictObject(),
 * catching common typos like `"sucess"` or `"finalContians"` that would
 * otherwise silently pass all assertions.
 */
import { z } from "zod";
import { fromZodError } from "zod-validation-error";

// ── Hook types ─────────────────────────────────────────────────────────────

const hookCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool-call"),
    tool: z.string(),
    input: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("shell"),
    command: z.string(),
    args: z.array(z.string()).optional(),
  }),
]);

const hookDefinitionSchema = z.object({
  name: z.string(),
  run: hookCommandSchema,
  failFast: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  /**
   * For tool-call hooks only: extract named variables from the JSON response.
   * Keys are variable names; values are JSONPath-like expressions (`$.field`).
   */
  capture: z.record(z.string()).optional(),
});

const testHooksSchema = z.object({
  beforeAll: z.array(hookDefinitionSchema).optional(),
  afterAll: z.array(hookDefinitionSchema).optional(),
  beforeEach: z.array(hookDefinitionSchema).optional(),
  afterEach: z.array(hookDefinitionSchema).optional(),
});

// ── Assertion blocks (strictObject — rejects unknown keys) ─────────────────

/**
 * A single JSONPath assertion entry.
 * Used in the `jsonPath` field of `expectSchema`.
 */
const jsonPathEntrySchema = z.strictObject({
  /** JSONPath expression, e.g. "$.user.id" or "$.items[0].name" */
  path: z.string(),
  /** Assert the extracted value equals this string exactly */
  equals: z.string().optional(),
  /** Assert the extracted value contains this substring */
  contains: z.string().optional(),
  /** Assert the extracted value matches this regex pattern */
  matches: z.string().optional(),
});

/**
 * `expect` block for tool-call / resource-read / prompt-get tests.
 * Uses z.strictObject() so typos like `"sucess"` are caught immediately.
 */
const expectSchema = z.strictObject({
  success: z.boolean().optional(),
  /** JSON Schema the result content must match */
  schema: z.record(z.string(), z.unknown()).optional(),
  contains: z.string().optional(),
  /** Assert result text does NOT contain this string */
  notContains: z.string().optional(),
  /** Assert exact equality of the full response text */
  equals: z.string().optional(),
  /** Assert response text matches this regex pattern (JavaScript regex syntax) */
  matches: z.string().optional(),
  /**
   * JSONPath-based field extraction and assertion.
   * Each entry extracts a value and runs one or more assertions on it.
   * Path syntax: $.field, $.field.nested (array indexing not yet supported)
   *
   * Accepts either an array of entries or a single entry object (shorthand).
   * After parsing, the value is always normalized to an array.
   *
   * @example
   * // array form (multi-assertion):
   * "jsonPath": [{ "path": "$.id", "equals": "alice" }]
   *
   * // object shorthand (single assertion):
   * "jsonPath": { "path": "$.status", "equals": "completed" }
   */
  jsonPath: z.union([
    z.array(jsonPathEntrySchema),
    jsonPathEntrySchema,
  ]).transform((val) => Array.isArray(val) ? val : [val]).optional(),
  executionTimeMs: z.number().optional(),
  /**
   * Maximum allowed response size in tokens (~4 chars/token).
   * Catches unexpectedly verbose responses that inflate LLM context cost.
   */
  maxTokens: z.number().optional(),
});

/**
 * `streamExpect` block for streaming-tool-call tests.
 * Uses z.strictObject() so typos like `"finalContians"` are caught.
 */
const streamExpectSchema = z.strictObject({
  minChunks: z.number().optional(),
  chunkContains: z.string().optional(),
  maxChunkIntervalMs: z.number().optional(),
  finalContains: z.string().optional(),
  maxTotalMs: z.number().optional(),
});

// ── Parametrize row schema ─────────────────────────────────────────────────

/**
 * A single row in a `parametrize` array.
 * Per-row `expect` and `streamExpect` use `.partial()` so you only need to
 * specify the fields you want to override — not the full object.
 * Uses z.strictObject() so a typo like `"exepct"` at the row level is caught
 * immediately rather than silently ignored.
 */
const parameterRowSchema = z.strictObject({
  /** Human-readable label appended to the test name */
  label: z.string().min(1, "label must not be empty"),
  /** Merged over the base test.input at runtime (row wins on conflict) */
  input: z.record(z.unknown()),
  /** Shallow-merged over base expect — only fields listed here are overridden */
  expect: expectSchema.partial().optional(),
  /** Shallow-merged over base streamExpect — only fields listed here are overridden */
  streamExpect: streamExpectSchema.partial().optional(),
});

// ── Shared fields ──────────────────────────────────────────────────────────

const baseTestFields = {
  /** Unique identifier for this test. Auto-generated from the name when omitted. */
  id: z.string().optional(),
  name: z.string(),
  tags: z.array(z.string()).optional(),
  /**
   * Retry count: how many times to re-run the test on failure (max 5).
   * z.max(5) prevents typos like `retry: 999` from stalling a suite.
   */
  retry: z.number().int().min(0).max(5).optional(),
  /** Milliseconds to wait between retry attempts. */
  retryDelayMs: z.number().int().min(0).optional(),
  /**
   * Parametrize: expand this single test definition into one execution per row.
   * A test with an empty array is dropped (with a warning) before the suite runs.
   */
  parametrize: z.array(parameterRowSchema).optional(),
  /**
   * Extract values from the test result into HookContext for use in later tests.
   * Keys are variable names (referenced as {{varName}}), values are JSONPath expressions.
   * Only runs on passing tests. Supports the same JSONPath syntax as hook capture.
   * Only applies to tool-call, resource-read, and prompt-get test types.
   *
   * @example
   * "capture": { "userId": "$.id", "token": "$.auth.token" }
   */
  capture: z.record(z.string()).optional(),
  /**
   * Per-test timeout in milliseconds. Overrides RunnerOptions.timeout.
   * Min: 100ms. Max: 300000ms (5 minutes).
   * On timeout, the test fails with a clear message.
   */
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
} as const;

const securityThresholdSchema = z.enum(["critical", "high", "medium", "low", "info"]);

// ── Test case variants (discriminated union on "type") ─────────────────────

const toolCallTestSchema = z.object({
  ...baseTestFields,
  type: z.literal("tool-call"),
  tool: z.string(),
  input: z.record(z.unknown()).optional(),
  expect: expectSchema.optional(),
});

const protocolTestSchema = z.object({
  ...baseTestFields,
  type: z.literal("protocol"),
});

const securityTestSchema = z.object({
  ...baseTestFields,
  type: z.literal("security"),
  /** Tool to probe; if omitted the scanner probes all tools */
  tool: z.string().optional(),
  securityThreshold: securityThresholdSchema.optional(),
  expect: expectSchema.optional(),
});

const fuzzTestSchema = z.object({
  ...baseTestFields,
  type: z.literal("fuzz"),
  tool: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  expect: expectSchema.optional(),
});

const resourceReadTestSchema = z.object({
  ...baseTestFields,
  type: z.literal("resource-read"),
  uri: z.string(),
  expect: expectSchema.optional(),
});

const promptGetTestSchema = z.object({
  ...baseTestFields,
  type: z.literal("prompt-get"),
  /** Prompt name; falls back to `tool` field if omitted */
  promptName: z.string().optional(),
  /** Fallback prompt name (legacy field) */
  tool: z.string().optional(),
  /** Template arguments — MCP requires all values to be strings */
  promptArgs: z.record(z.string()).optional(),
  expect: expectSchema.optional(),
});

const streamingTestCaseSchema = z.object({
  ...baseTestFields,
  type: z.literal("streaming-tool-call"),
  tool: z.string(),
  input: z.record(z.unknown()),
  streamExpect: streamExpectSchema,
});

/**
 * Discriminated union across all seven test types.
 * The `type` field is the discriminant.
 */
const testCaseSchema = z.discriminatedUnion("type", [
  toolCallTestSchema,
  protocolTestSchema,
  securityTestSchema,
  fuzzTestSchema,
  resourceReadTestSchema,
  promptGetTestSchema,
  streamingTestCaseSchema,
]);

// ── Server config ──────────────────────────────────────────────────────────

/**
 * Server configuration block.
 *
 * Exactly one of `command` or `url` must be provided:
 * - `command` — spawn a stdio MCP server as a child process
 * - `url` — connect to an already-running HTTP-based MCP server
 *
 * For HTTP servers, `transport` selects the protocol
 * (`"streamable-http"` is the default; `"sse"` is the legacy option).
 * Headers for authentication can be passed via `headers`.
 */
const serverConfigSchema = z.object({
  /** Command to start a stdio MCP server, e.g. "node" or "uv". */
  command: z.string().optional(),
  /** Arguments for the stdio command. */
  args: z.array(z.string()).optional(),
  /** Extra environment variables for the stdio server process. */
  env: z.record(z.string()).optional(),
  /** Working directory for the stdio server process. Required for Python uv/venv projects. */
  cwd: z.string().optional(),
  /** URL of a running HTTP-based MCP server, e.g. "http://localhost:3001/mcp". */
  url: z.string().url().optional(),
  /**
   * Transport protocol to use when `url` is provided.
   * Defaults to `"streamable-http"` (MCP 2025-03-26 spec).
   * Use `"sse"` for legacy servers that only support Server-Sent Events.
   */
  transport: z.enum(["stdio", "streamable-http", "sse"]).optional(),
  /** HTTP headers sent with every request (e.g. `{ "Authorization": "Bearer tok" }`). */
  headers: z.record(z.string()).optional(),
})
  .refine((s) => s.command !== undefined || s.url !== undefined, {
    message: 'server requires either "command" or "url"',
  })
  .refine((s) => !(s.command !== undefined && s.url !== undefined), {
    message: 'server cannot have both "command" and "url"',
  });

// ── Describe block schema ─────────────────────────────────────────────────

/**
 * A named group of tests with optional per-group hooks.
 * Only single-level nesting is supported (no describe within describe).
 */
const describeBlockSchema = z.object({
  name: z.string(),
  hooks: testHooksSchema.optional(),
  tests: z.array(testCaseSchema),
});

// ── Top-level collection schema ────────────────────────────────────────────

/**
 * Full Zod schema for a `.checkspec.json` collection file.
 *
 * Usage:
 * ```typescript
 * import { collectionSchema } from "@checkspec/core/schema";
 * import { fromZodError } from "zod-validation-error";
 *
 * const result = collectionSchema.safeParse(JSON.parse(raw));
 * if (!result.success) {
 *   console.error(fromZodError(result.error).toString());
 *   process.exit(1);
 * }
 * const collection = result.data;
 * ```
 */
export const collectionSchema = z.object({
  version: z.literal("1.0"),
  name: z.string(),
  description: z.string().optional(),
  server: serverConfigSchema,
  hooks: testHooksSchema.optional(),
  /** Grouped test blocks with optional per-group hooks (single-level only). */
  describe: z.array(describeBlockSchema).optional(),
  tests: z.array(testCaseSchema).default([]),
  /**
   * Maximum number of tests to run in parallel (default: 1 = serial).
   * Applies within each describe block and the top-level test list.
   * beforeAll/afterAll always run serially.
   */
  concurrency: z.number().int().min(1).max(50).optional(),
});

/**
 * TypeScript type inferred from the Zod schema.
 * This is the validated form of a collection — use it instead of casting
 * `JSON.parse()` output directly to `CheckSpecCollection`.
 */
export type CollectionInput = z.infer<typeof collectionSchema>;

// ── High-level validation helper ───────────────────────────────────────────

/** Discriminated-union result returned by `validateCollection`. */
export type ValidationResult =
  | { success: true; data: CollectionInput }
  | { success: false; message: string };

/**
 * Validates an unknown value against the collection schema and returns a
 * human-readable error message on failure.  The message is produced by
 * `zod-validation-error`, which lives in `@checkspec/core` — callers
 * (such as `packages/cli`) do NOT need to add `zod-validation-error` as a
 * direct dependency.
 *
 * @example
 * ```typescript
 * import { validateCollection } from "@checkspec/core/schema";
 *
 * const result = validateCollection(JSON.parse(raw));
 * if (!result.success) {
 *   console.error("✗ Invalid collection file:");
 *   console.error(result.message);
 *   process.exit(1);
 * }
 * const collection = result.data;
 * ```
 */
export function validateCollection(raw: unknown): ValidationResult {
  const parsed = collectionSchema.safeParse(raw);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, message: fromZodError(parsed.error).toString() };
}
