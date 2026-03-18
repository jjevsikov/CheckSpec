// ── Hook types ────────────────────────────────────────────────────────────────

/** What a hook runs — either a tool call on the connected server or a local shell command. */
export type HookCommand =
  | { type: "tool-call"; tool: string; input: Record<string, unknown> }
  | { type: "shell"; command: string; args?: string[] };

export interface HookDefinition {
  /** Human-readable label shown in test output */
  name: string;
  /** What to run */
  run: HookCommand;
  /**
   * If true and this hook fails, abort the entire suite.
   * Defaults to true for setup hooks (beforeAll/beforeEach) and false for teardown hooks.
   */
  failFast?: boolean;
  /** ms before the hook is considered hung. Default: 10000 */
  timeoutMs?: number;
  /**
   * For `tool-call` hooks only: extract named variables from the JSON response.
   * Keys are variable names; values are JSONPath-like expressions (`$.field` or `$.field.nested`).
   * Captured variables are available as `{{varName}}` placeholders in all subsequent
   * hook inputs and test inputs/expects within the same collection run.
   *
   * @example
   * ```json
   * "capture": { "userId": "$.user.id", "userName": "$.user.name" }
   * ```
   */
  capture?: Record<string, string>;
}

export interface TestHooks {
  /** Runs once before the first test in the collection */
  beforeAll?: HookDefinition[];
  /** Runs once after the last test, even if tests failed */
  afterAll?: HookDefinition[];
  /** Runs before each individual test */
  beforeEach?: HookDefinition[];
  /** Runs after each individual test */
  afterEach?: HookDefinition[];
}

// ── Describe blocks ──────────────────────────────────────────────────────────

/**
 * A named group of tests with optional per-group hooks.
 *
 * Describe blocks provide scoped setup/teardown — e.g. an "auth" group can
 * `beforeAll: login` and `afterAll: logout` without affecting other groups.
 * Top-level hooks still apply: the execution order for each test is
 * `top-level beforeEach → group beforeEach → test → group afterEach → top-level afterEach`.
 *
 * Only single-level nesting is supported (no `describe` within `describe`).
 */
export interface DescribeBlock {
  /** Group name displayed by reporters as a section header */
  name: string;
  /** Optional per-group hooks (scoped to this describe block) */
  hooks?: TestHooks;
  /** Tests within this group */
  tests: (TestCase | StreamingTestCase)[];
}

// ── Collection ────────────────────────────────────────────────────────────────

/**
 * Server configuration.
 *
 * Exactly one of `command` or `url` must be provided:
 * - `command` — spawn a stdio MCP server as a child process
 * - `url` — connect to an already-running HTTP-based MCP server
 */
export interface ServerConfig {
  /** Command to start a stdio MCP server, e.g. "node" or "uv". */
  command?: string;
  /** Arguments for the stdio command. */
  args?: string[];
  /** Extra environment variables for the stdio server process. */
  env?: Record<string, string>;
  /** Working directory for the stdio server process. Required for Python uv/venv projects. */
  cwd?: string;
  /** URL of a running HTTP-based MCP server, e.g. "http://localhost:3001/mcp". */
  url?: string;
  /**
   * Transport protocol to use when `url` is provided.
   * Defaults to `"streamable-http"` (MCP 2025-03-26 spec).
   * Use `"sse"` for legacy servers that only support Server-Sent Events.
   */
  transport?: "stdio" | "streamable-http" | "sse";
  /** HTTP headers sent with every request (e.g. `{ "Authorization": "Bearer tok" }`). */
  headers?: Record<string, string>;
}

/**
 * The .checkspec collection format (JSON).
 * Describes a set of tests to run against an MCP server.
 */
export interface CheckSpecCollection {
  version: "1.0";
  name: string;
  description?: string;
  server: ServerConfig;
  /** Optional setup and teardown hooks */
  hooks?: TestHooks;
  /**
   * Grouped test blocks with optional per-group hooks.
   * Each block runs its own beforeAll/afterAll lifecycle; top-level hooks still apply.
   * Only single-level nesting is supported (no describe within describe).
   */
  describe?: DescribeBlock[];
  tests: (TestCase | StreamingTestCase)[];
  /**
   * Maximum number of tests to run in parallel within each describe block
   * or the top-level test list.  Default: 1 (serial).
   *
   * `beforeAll` / `afterAll` always run serially regardless of this setting.
   * Each test's full lifecycle (beforeEach → test → afterEach) runs as one
   * concurrent unit — hooks are never interleaved with their own test.
   *
   * **Warning:** If hooks or tests mutate shared server state (e.g. database
   * rows), concurrent execution may cause flaky results.  Use `concurrency: 1`
   * (the default) when tests depend on shared state.
   */
  concurrency?: number;
}

/**
 * Assertions for streaming tool calls.
 * All fields are optional — omit any you don't need.
 */
export interface StreamExpect {
  /** Minimum number of progress chunks received before the final result */
  minChunks?: number;
  /** Every chunk's message must contain this string */
  chunkContains?: string;
  /** Maximum allowed gap between consecutive chunks in milliseconds (tests backpressure) */
  maxChunkIntervalMs?: number;
  /** The final assembled result must contain this string */
  finalContains?: string;
  /** Total stream duration (first chunk → final result) must be under this many ms */
  maxTotalMs?: number;
}

/**
 * A single row in a parametrized test definition.
 * Each row produces one fully-resolved test execution.
 */
export interface ParameterRow {
  /** Human-readable label appended to the test name: "add › sum [case: positive numbers]" */
  label: string;
  /** Merged into the base test.input at runtime — keys here override base keys */
  input: Record<string, unknown>;
  /** Optionally override expect fields for this row only (shallow merge over base expect) */
  expect?: Partial<NonNullable<TestCase["expect"]>>;
  /** Optionally override streamExpect fields for this row only (shallow merge over base streamExpect) */
  streamExpect?: Partial<StreamExpect>;
}

export interface StreamingTestCase {
  /** Unique test identifier. Auto-generated from the name if omitted in the collection file. */
  id: string;
  name: string;
  type: "streaming-tool-call";
  tool: string;
  input: Record<string, unknown>;
  streamExpect: StreamExpect;
  tags?: string[];
  /** How many times to retry on failure. Default: 0 (no retries). Max: 5. */
  retry?: number;
  /** Milliseconds to wait between retry attempts. Default: 500. */
  retryDelayMs?: number;
  /**
   * Per-test timeout in milliseconds. Overrides RunnerOptions.timeout.
   * Min: 100ms. Max: 300000ms (5 minutes).
   * On timeout, the test fails with a clear message.
   */
  timeoutMs?: number;
  /**
   * When present, this single test definition is expanded into one execution per row.
   * The base input/streamExpect are the defaults; each row's fields are merged on top.
   * A test with an empty array is dropped with a console warning.
   */
  parametrize?: ParameterRow[];
  /**
   * Extract values from the test result into HookContext for use in later tests.
   * Keys are variable names (referenced as {{varName}}), values are JSONPath expressions.
   * Only runs on passing tests. Applies to tool-call, streaming-tool-call, resource-read, and prompt-get types.
   */
  capture?: Record<string, string>;
}

export interface TestCase {
  /** Unique test identifier. Auto-generated from the name if omitted in the collection file. */
  id: string;
  name: string;
  type: "tool-call" | "protocol" | "security" | "fuzz" | "resource-read" | "prompt-get" | "streaming-tool-call";

  /** Tool name to call (for tool-call, fuzz, and security types) */
  tool?: string;

  /** Input arguments for the tool call */
  input?: Record<string, unknown>;

  /** Resource URI to read (for resource-read type) */
  uri?: string;

  /** Prompt name to fetch (for prompt-get type; falls back to `tool` if omitted) */
  promptName?: string;

  /**
   * Prompt template arguments (for prompt-get type).
   * MCP requires all argument values to be strings.
   */
  promptArgs?: Record<string, string>;

  /**
   * For security-type tests: the minimum severity level that counts as a failure.
   * Defaults to "medium" if omitted.
   */
  securityThreshold?: "critical" | "high" | "medium" | "low" | "info";

  expect?: {
    /** Whether the call should succeed (isError !== true for tools; no error for resources/prompts) */
    success?: boolean;
    /** JSON Schema the result content must match */
    schema?: object;
    /** Result text must contain this string */
    contains?: string;
    /** Result text must NOT contain this string */
    notContains?: string;
    /** Result text must exactly equal this string */
    equals?: string;
    /** Result text must match this regex pattern (JavaScript regex syntax) */
    matches?: string;
    /**
     * JSONPath-based field extraction and assertion.
     * Each entry extracts a value from the parsed JSON response and asserts on it.
     * Path syntax: $.field, $.field.nested
     */
    jsonPath?: Array<{
      /** JSONPath expression, e.g. "$.user.id" or "$.items[0].name" */
      path: string;
      /** Assert the extracted value equals this string exactly */
      equals?: string;
      /** Assert the extracted value contains this substring */
      contains?: string;
      /** Assert the extracted value matches this regex pattern */
      matches?: string;
    }>;
    /** Maximum allowed execution time in milliseconds */
    executionTimeMs?: number;
    /**
     * Maximum allowed response size in tokens (estimated at ~4 chars/token).
     * Useful for catching unexpectedly verbose responses that inflate LLM context cost.
     * Example: 500 tokens ≈ 2 KB of text.
     */
    maxTokens?: number;
  };

  tags?: string[];
  /** How many times to retry on failure. Default: 0 (no retries). Max: 5. */
  retry?: number;
  /** Milliseconds to wait between retry attempts. Default: 500. */
  retryDelayMs?: number;
  /**
   * Per-test timeout in milliseconds. Overrides RunnerOptions.timeout.
   * Min: 100ms. Max: 300000ms (5 minutes).
   * On timeout, the test fails with a clear message.
   */
  timeoutMs?: number;
  /**
   * When present, this single test definition is expanded into one execution per row.
   * The base input/expect are the defaults; each row's fields are merged on top.
   * A test with an empty array is dropped with a console warning.
   */
  parametrize?: ParameterRow[];
  /**
   * Extract values from the test result into HookContext for use in later tests.
   * Keys are variable names (referenced as {{varName}}), values are JSONPath expressions.
   * Only runs on passing tests. Applies to tool-call, streaming-tool-call, resource-read, and prompt-get types.
   */
  capture?: Record<string, string>;
}
