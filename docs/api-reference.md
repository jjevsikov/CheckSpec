# @checkspec/core API Reference

The `@checkspec/core` package is the library powering CheckSpec. It can be used programmatically — in CI scripts, test helpers, or custom tooling — without the CLI.

```bash
npm install @checkspec/core
```

All public exports are available from the root:

```typescript
import {
  MCPRecordingClient,
  TestRunner,
  HookContext,
  expect,
  SchemaInputGenerator,
  SecurityScanner,
  ConsoleReporter,
  JUnitReporter,
  JSONReporter,
  HTMLReporter,
  captureSnapshot,
  diffSnapshots,
} from "@checkspec/core";
import type {
  CheckSpecCollection,
  DescribeBlock,
  TestCase,
  TestResult,
  RunSummary,
  SecurityFinding,
  RecordedMessage,
} from "@checkspec/core";
```

---

## MCPRecordingClient

Wraps the official MCP SDK `Client` to record all request/response pairs with timestamps and timing.

### Constructor

```typescript
new MCPRecordingClient(transport: Transport)
```

`transport` — any MCP transport. Typically `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`.

### Methods

#### `connect(): Promise<void>`

Connects to the server and performs the MCP initialization handshake. Must be called before any other method.

#### `disconnect(): Promise<void>`

Closes the connection. Always call this in `afterAll` / `finally` blocks to avoid orphaned server processes.

#### `listTools(): Promise<Tool[]>`

Returns all tools the server advertises. Records the request/response pair with timing.

#### `callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>`

Calls a named tool with the given arguments.

**Important:** MCP tool errors are returned as `{ isError: true, content: [...] }` — this method does **not** throw on tool errors. Check `result.isError` to detect failures.

#### `listResources(): Promise<Resource[]>`

Lists available resources. Records timing.

#### `readResource(uri: string): Promise<ReadResourceResult>`

Reads a specific resource by URI. Records timing.

```typescript
const result = await client.readResource("version://info");
// result.contents: Array<TextResourceContents | BlobResourceContents>
const textItems = result.contents.filter((c) => "text" in c);
```

#### `listPrompts(): Promise<Prompt[]>`

Lists available prompts. Records timing.

#### `getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult>`

Fetches a prompt template with optional arguments. MCP requires all argument values to be strings.

```typescript
const result = await client.getPrompt("summarize", { topic: "TypeScript" });
// result.messages: Array<{ role: "user"|"assistant", content: TextContent|ImageContent|... }>
const text = result.messages
  .filter((m) => m.content.type === "text")
  .map((m) => (m.content as { text: string }).text)
  .join("\n");
```

#### `getRecording(): RecordedMessage[]`

Returns a **copy** of the interaction log since the last `clearRecording()`. Safe to mutate the returned array — it does not affect internal state.

#### `clearRecording(): void`

Empties the recording buffer.

### `RecordedMessage` type

```typescript
interface RecordedMessage {
  direction: "request" | "response";
  method: string;          // "tools/call", "tools/list", "resources/read", "prompts/get", etc.
  params?: unknown;        // request parameters (only on "request" messages)
  result?: unknown;        // response payload (only on "response" messages)
  error?: { code: number; message: string };
  timestamp: number;       // Date.now() at time of message
  durationMs?: number;     // only on "response" messages
}
```

### Example

```typescript
import { MCPRecordingClient } from "@checkspec/core";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["path/to/server/dist/index.js"],
});

const client = new MCPRecordingClient(transport);

try {
  await client.connect();

  // Discover
  const tools = await client.listTools();
  const resources = await client.listResources();
  const prompts = await client.listPrompts();

  // Call a tool
  const result = await client.callTool("read_file", { file_path: "/etc/hosts" });
  console.log("isError:", result.isError);

  // Read a resource
  const resource = await client.readResource("version://info");
  const text = resource.contents
    .filter((c) => "text" in c)
    .map((c) => (c as { text: string }).text)
    .join("");

  // Get a prompt
  const prompt = await client.getPrompt("summarize", { topic: "TypeScript" });

  // Inspect recording
  const recording = client.getRecording();
  console.log(`${recording.length} messages recorded`);
  console.log(`Last call took ${recording.at(-1)?.durationMs}ms`);
} finally {
  await client.disconnect();
}
```

---

## TestRunner

Runs an `CheckSpecCollection` against a connected client and returns a structured `RunSummary`.

### Constructor

```typescript
new TestRunner(client: MCPRecordingClient, options?: RunnerOptions)
```

```typescript
interface RunnerOptions {
  timeout?: number;    // per-test timeout in ms (default: none)
  bail?: boolean;      // stop on first failure (default: false)
  tags?: string[];     // only run tests whose tags include one of these
  onTestStart?: (test: TestCase) => void;   // called before each test begins
  onTestEnd?:   (result: TestResult) => void; // called immediately after each test
  onHookEnd?:   (result: HookResult) => void; // called after each hook completes
  onDescribeStart?: (name: string) => void;  // called when entering a describe block
  onDescribeEnd?:   (name: string) => void;  // called when leaving a describe block
}
```

### Methods

#### `runCollection(collection: CheckSpecCollection): Promise<RunSummary>`

Runs the full lifecycle: `beforeAll` hooks → tests (with `beforeEach`/`afterEach` around each) → `afterAll` hooks. Returns a summary.

- If a `beforeAll` hook with `failFast: true` fails, all tests are skipped but `afterAll` still runs.
- Teardown hooks (`afterAll`, `afterEach`) never throw — failures are recorded but execution continues.
- Tests with `retry > 0` are re-run up to `retry` additional times on failure. Hooks run once per test, not once per attempt. `retryCount` and `retryExhausted` are set on the returned `TestResult` when retries were consumed.
- Transport-level errors (EPIPE, ECONNRESET, EOF, spawn ENOENT) bypass retry and propagate immediately — retrying a dead server process is pointless.
- A test's `timeoutMs` (or `RunnerOptions.timeout`, defaulting to 30000ms) cancels the tool call if it hangs. The test fails with `"Test timed out after Nms"`.
- A test's `capture` field extracts values from the result into the shared `HookContext` after the test passes. These values are available as `{{varName}}` in all subsequent tests and hooks.
- Tests with a `parametrize` array are expanded into individual test cases before any hooks run. The runner never sees parametrize fields.
- `describe` blocks execute in order before top-level tests. Each block runs its own `beforeAll`/`afterAll` lifecycle. If a describe-level `beforeAll` fails, that group's tests are skipped but other groups still run. The `onDescribeStart` and `onDescribeEnd` callbacks fire around each group.

#### `runTest(test: TestCase): Promise<TestResult>`

Runs a single test case. **Never throws** — errors are caught and returned as `{ passed: false, error: "..." }`.

Dispatches on `test.type`:
- `"tool-call"` → calls `client.callTool()`, runs `MCPExpect` assertions
- `"resource-read"` → calls `client.readResource()`, validates content
- `"prompt-get"` → calls `client.getPrompt()`, validates messages
- `"protocol"` → calls `client.listTools()` as a liveness check
- `"fuzz"` → calls `client.callTool()`, passes on **any** MCP response (crash/timeout = fail); does not assert content
- `"security"` → runs `SecurityScanner.scanTool()`, checks against threshold

### Types

```typescript
interface TestResult {
  testId: string;
  testName: string;
  passed: boolean;
  durationMs: number;
  error?: string;           // set when passed === false
  actual?: unknown;         // the raw result (CallToolResult, ReadResourceResult, etc.)
  testCase?: TestCase;      // the originating test case (set by TestRunner)
  /**
   * Number of retry attempts consumed (only present when retry > 0 was configured
   * and at least one retry was used).
   * Example: retry:2, passed on attempt 2 → retryCount: 1, retryExhausted: false
   * Example: retry:2, failed all 3 attempts → retryCount: 2, retryExhausted: true
   */
  retryCount?: number;
  /** true when all configured retries were consumed and the test still failed. */
  retryExhausted?: boolean;
}

interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: TestResult[];
  hookResults: HookResult[];  // results from all beforeAll/afterAll/beforeEach/afterEach hooks
  /** Number of original test definitions that had a non-empty `parametrize` array.
   *  Used by reporters to show "(N cases from M parametrized tests)". Zero when none. */
  parametrizedSourceCount: number;
}
```

### Example

```typescript
import { MCPRecordingClient, TestRunner } from "@checkspec/core";
import type { CheckSpecCollection } from "@checkspec/core";

const collection: CheckSpecCollection = {
  version: "1.0",
  name: "My tests",
  server: { command: "node", args: ["dist/index.js"] },
  tests: [
    {
      id: "t1",
      name: "echo works",
      type: "tool-call",
      tool: "echo",
      input: { message: "ping" },
      expect: { success: true, contains: "ping" },
    },
    {
      id: "t2",
      name: "version resource valid",
      type: "resource-read",
      uri: "version://info",
      expect: { contains: "version" },
    },
  ],
};

// client must already be connected
const runner = new TestRunner(client, { bail: false });
const summary = await runner.runCollection(collection);

console.log(`Passed: ${summary.passed}/${summary.total}`);
process.exitCode = summary.failed > 0 ? 1 : 0;
```

---

## expect (MCPExpect)

Chainable assertions for `CallToolResult` values. Throws `AssertionError` on failure.

### Factory Function

```typescript
function expect(result: CallToolResult, durationMs?: number): MCPExpect
```

Pass `durationMs` to enable `toRespondWithin()`.

### Assertions

#### `.toSucceed(): this`

Asserts `result.isError` is falsy.

#### `.toFail(): this`

Asserts `result.isError === true`.

#### `.toContainText(text: string): this`

Asserts that the concatenated text of all `TextContent` items contains `text`.

#### `.toNotContainText(text: string): this`

Asserts that the concatenated text of all `TextContent` items does NOT contain `text`. Equivalent to `.not.toContainText(text)`.

#### `.toEqualText(text: string): this`

Asserts that the full concatenated text exactly equals `text`. Useful when the response must have a precise format with no extra whitespace or characters.

#### `.toMatchPattern(pattern: string): this`

Asserts that the concatenated text matches the given regular expression pattern (JavaScript regex syntax). Throws `AssertionError` immediately — before evaluating negation — if `pattern` is not a valid regex.

```typescript
mcpExpect(result).toMatchPattern("^Hello,\\s+\\w+!$");
mcpExpect(result).not.toMatchPattern("Error|Fail");
```

#### `.toMatchSchema(schema: object): this`

Parses the result text as JSON and validates it against the given JSON Schema (using Ajv v8). Throws if the text is not valid JSON or doesn't match the schema.

#### `.toRespondWithin(ms: number): this`

Asserts that `durationMs <= ms`. Throws if `durationMs` was not passed to `expect()`.

#### `.toBeLessThanTokens(maxTokens: number): this`

Estimates token count from the response text (~4 characters per token) and asserts it is at most `maxTokens`. Useful for guarding against unexpectedly verbose tool responses that could blow out LLM context windows.

#### `.not`

Returns a new `MCPExpect` with all assertions negated. Chainable.

### Example

```typescript
import { expect as mcpExpect } from "@checkspec/core";

const start = Date.now();
const result = await client.callTool("greet", { name: "Alice" });
const durationMs = Date.now() - start;

mcpExpect(result, durationMs)
  .toSucceed()
  .toContainText("Alice")
  .toNotContainText("Error")
  .toRespondWithin(500);

// Exact equality
mcpExpect(result).toEqualText("Hello, Alice!");

// Regex matching
mcpExpect(result).toMatchPattern("^Hello,\\s+\\w+!$");

// Negation
mcpExpect(result).not.toFail();
mcpExpect(result).not.toContainText("Error");
```

---

## SchemaInputGenerator

Generates test inputs from JSON Schema objects.

### Constructor

```typescript
new SchemaInputGenerator()
```

Stateless — safe to reuse across multiple calls.

### Methods

#### `generate(schema: object, options: GeneratorOptions): Record<string, unknown>[]`

```typescript
interface GeneratorOptions {
  mode: "valid" | "invalid" | "edge" | "fuzz";
  count?: number;   // how many inputs to generate (default varies by mode)
  seed?: number;    // for reproducible output
}
```

| Mode | Description |
|------|-------------|
| `"valid"` | Inputs that conform to the schema (via json-schema-faker) |
| `"invalid"` | Type mismatches, missing required fields |
| `"edge"` | Empty string, null, 10K-char string, unicode, injection payloads |
| `"fuzz"` | Mix of all three modes |

#### `generateEdgeCases(schema: object): Record<string, unknown>[]`

Generates the full set of 19 adversarial edge-case inputs (empty string, whitespace, control chars, null, SQL injection, XSS, path traversal, null bytes, 10KB string, etc.). The CLI `scan` command uses the first 5 by default and all 19 with `--fuzz`.

> **Note:** These inputs test *resilience* — whether the server stays alive when given unexpected values. They are not security probes. Use `SecurityScanner` (or `type: "security"` test cases) to detect malicious tool behavior.

### Example

```typescript
import { SchemaInputGenerator } from "@checkspec/core";

const gen = new SchemaInputGenerator();

const validInputs = gen.generate(
  { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  { mode: "valid", count: 3 }
);
// → [{ query: "..." }, { query: "..." }, { query: "..." }]

const edgeCases = gen.generateEdgeCases(tool.inputSchema);
// → [{ query: "" }, { query: " " }, { query: "\n\r\t" }, ...]
```

---

## SecurityScanner

Scans a connected MCP server for common security vulnerabilities.

### Constructor

```typescript
new SecurityScanner()
```

### Methods

#### `scan(client: MCPRecordingClient): Promise<SecurityFinding[]>`

Runs all security probes against every tool the server exposes. Returns combined findings.

Probes run per tool:
1. **Tool poisoning** — static analysis of tool name and description
2. **Rug-pull** — calls the tool 3× with identical input and compares call-1 to call-3
3. **Prompt injection** — sends 4 injection payloads and checks responses

#### `scanTool(client: MCPRecordingClient, tool: Tool): Promise<SecurityFinding[]>`

Runs all probes against a single tool. Used by `TestRunner` for `type: "security"` test cases. Also useful for targeted scanning in custom scripts.

```typescript
import { SecurityScanner } from "@checkspec/core";

const scanner = new SecurityScanner();
const tools = await client.listTools();
const myTool = tools.find((t) => t.name === "read_file")!;

const findings = await scanner.scanTool(client, myTool);
```

### Detection details

**Tool poisoning** — checks tool `name` and `description` for:
- Regex patterns: `ignore previous instructions`, `do not tell`, `system prompt`, `SYSTEM:`, `<script`, `<iframe`, HTML comments, and more
- Hidden/invisible unicode: zero-width space (`\u200B`), zero-width joiners, bidi override characters, BOM
- Description length > 1000 chars (may contain hidden instructions)

**Rug-pull** — calls the tool 3× with minimal inputs from its schema, compares call-1 to call-3:
- If results differ by Levenshtein edit-distance ratio > 20%, flags as rug-pull
- Allows numeric/timestamp variance (pure digit changes are ignored)
- Returns `"high"` severity finding with the two differing responses as evidence

**Prompt injection** — sends 4 payloads (including `"Ignore all previous instructions"`, `"]] SYSTEM: new task"`, etc.) and checks if the response:
- Contains the payload verbatim (echo check)
- Contains AI system-prompt leakage markers (`"as an ai"`, `"i cannot"`, `"my previous instructions"`)

### `SecurityFinding` type

```typescript
interface SecurityFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  type:
    | "tool-poisoning"
    | "prompt-injection"
    | "rug-pull"
    | "data-exfiltration"
    | "resource-exhaustion";
  tool?: string;         // which tool triggered this finding
  description: string;   // human-readable explanation
  evidence?: string;     // the suspicious text or diffed responses
}
```

### Example

```typescript
import { MCPRecordingClient, SecurityScanner } from "@checkspec/core";

await client.connect();

const scanner = new SecurityScanner();
const findings = await scanner.scan(client);

for (const f of findings) {
  console.log(`[${f.severity.toUpperCase()}] ${f.type} (${f.tool}): ${f.description}`);
  if (f.evidence) console.log(`  Evidence: ${f.evidence}`);
}

// Exit 1 if any critical findings
const critical = findings.filter((f) => f.severity === "critical");
if (critical.length > 0) process.exit(1);
```

---

## HookRunner

Executes `beforeAll/afterAll/beforeEach/afterEach` hook definitions. Used internally by `TestRunner.runCollection()`. Available for custom orchestration.

### Constructor

```typescript
new HookRunner(client: MCPRecordingClient)
```

### Methods

#### `runHooks(hooks, phase, onResult?): Promise<HookResult[]>`

Runs a list of hook definitions in order.

```typescript
async runHooks(
  hooks: HookDefinition[],
  phase: "beforeAll" | "afterAll" | "beforeEach" | "afterEach",
  onResult?: (result: HookResult) => void
): Promise<HookResult[]>
```

- `onResult` — called immediately after each hook so callers can stream output in real time.
- Setup phases (`beforeAll`, `beforeEach`) default `failFast` to `true`: a failing hook throws `HookAbortError` and stops the chain.
- Teardown phases (`afterAll`, `afterEach`) default `failFast` to `false`: all hooks run regardless of individual failures.
- Individual hooks can override the default via `failFast: true/false` in their definition.

### `HookAbortError`

Thrown by `runHooks()` when a hook with `failFast: true` fails. Use `instanceof` to distinguish it from other errors:

```typescript
import { HookRunner, HookAbortError } from "@checkspec/core";

try {
  await hookRunner.runHooks(beforeAllHooks, "beforeAll");
} catch (err) {
  if (err instanceof HookAbortError) {
    console.error("Setup failed, skipping tests:", err.message);
  } else {
    throw err; // unexpected error
  }
}
```

### `HookResult` type

```typescript
interface HookResult {
  name: string;       // hook's display name
  phase: string;      // "beforeAll" | "afterAll" | "beforeEach" | "afterEach"
  passed: boolean;
  durationMs: number;
  error?: string;     // set when passed === false
}
```

---

## HookContext

Stores named variables captured by hooks and resolves `{{varName}}` placeholder templates. Used internally by `TestRunner.runCollection()` and available for custom orchestration.

### Constructor

```typescript
new HookContext()
```

Creates an empty context with no variables set.

### Methods

#### `set(key: string, value: string): void`

Stores a string value under the given key. Overwrites any existing value.

#### `has(key: string): boolean`

Returns `true` if a value has been stored under `key`.

#### `resolve<T>(value: T): T`

Recursively walks `value` (string, array, or object) and replaces all `{{varName}}` substrings with stored values. Returns the same shape as the input:
- Strings: placeholders are substituted in place
- Arrays: each element is resolved recursively
- Objects: each value is resolved recursively (keys are not modified)
- Other types (number, boolean, null): returned unchanged

Unrecognised keys (no matching variable) are left as the literal `{{varName}}` string. Circular object references are detected and left unresolved.

#### `static extractValue(json: unknown, path: string): string | undefined`

Extracts a value from a parsed JSON object using a dot-notation JSONPath expression.

```typescript
HookContext.extractValue({ user: { id: "alice-123", active: true } }, "$.user.id");
// → "alice-123"

HookContext.extractValue({ user: { id: "alice-123" } }, "$.user.missing");
// → undefined

HookContext.extractValue({ items: [1, 2, 3] }, "$.items");
// → "[1,2,3]"  (objects/arrays are JSON-stringified)
```

`path` must start with `$.`. Returns `undefined` for missing paths, null values, or paths that don't start with `$.`.

### Example

```typescript
import { HookContext } from "@checkspec/core";

const ctx = new HookContext();

// Populate after a hook tool-call response
const response = { user: { id: "u-9f3a", name: "Alice" } };
ctx.set("userId",   HookContext.extractValue(response, "$.user.id")   ?? "");
ctx.set("userName", HookContext.extractValue(response, "$.user.name") ?? "");

// Resolve placeholders in test input
const testInput = { id: "{{userId}}", greeting: "Hello {{userName}}" };
const resolved = ctx.resolve(testInput);
// → { id: "u-9f3a", greeting: "Hello Alice" }
```

See [hook-context.md](hook-context.md) for the user-facing guide with collection format examples.

---

## Reporters

All reporters implement the `Reporter` interface:

```typescript
interface Reporter {
  onTestStart(test: TestCase): void;
  onTestEnd(result: TestResult): void;
  onHookEnd?(result: HookResult): void;  // optional — called after each hook
  onRunEnd(summary: RunSummary): void;
  flush(): string;
}
```

Call the hooks as tests run, then call `flush()` at the end to get the formatted output.

### ConsoleReporter

Prints coloured `✓` / `✗` output to the terminal in real time using chalk. `flush()` returns the same lines joined with newlines.

### JUnitReporter

Produces standard JUnit XML compatible with GitHub Actions, Jenkins, and most CI systems.

```typescript
const reporter = new JUnitReporter();
reporter.onTestStart(test);
reporter.onTestEnd(result);
reporter.onRunEnd(summary);
const xml = reporter.flush();
// → <?xml version="1.0"?><testsuites>...</testsuites>
```

### JSONReporter

Returns the full `RunSummary` as pretty-printed JSON. Useful for archiving results and feeding into `checkspec report`.

```typescript
const reporter = new JSONReporter();
reporter.onRunEnd(summary);
const json = reporter.flush();
// → "{ \"total\": 5, \"passed\": 5, ... }"
```

### HTMLReporter

Generates a self-contained HTML report with test results, timing, and security findings. The output is a single `.html` file with inline CSS — no external dependencies. Useful for attaching to CI artifacts or sharing with non-technical stakeholders.

```typescript
const reporter = new HTMLReporter();
reporter.onTestStart(test);
reporter.onTestEnd(result);
reporter.onRunEnd(summary);
const html = reporter.flush();
writeFileSync("report.html", html);
```

### Example: Custom CI Script

```typescript
import {
  MCPRecordingClient,
  TestRunner,
  JUnitReporter,
} from "@checkspec/core";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync } from "fs";
import type { CheckSpecCollection } from "@checkspec/core";

const collection = JSON.parse(
  readFileSync("my-server.checkspec.json", "utf-8")
) as CheckSpecCollection;

const transport = new StdioClientTransport({
  command: collection.server.command,
  args: collection.server.args ?? [],
  cwd: collection.server.cwd,
  env: collection.server.env
    ? { ...process.env, ...collection.server.env } as Record<string, string>
    : undefined,
});

const client = new MCPRecordingClient(transport);
await client.connect();

const reporter = new JUnitReporter();
const runner = new TestRunner(client, {
  onTestStart: (test) => reporter.onTestStart(test),
  onTestEnd: (result) => reporter.onTestEnd(result),
  onHookEnd: (result) => reporter.onHookEnd?.(result),
});
const summary = await runner.runCollection(collection);
reporter.onRunEnd(summary);

writeFileSync("junit-results.xml", reporter.flush());
await client.disconnect();

process.exitCode = summary.failed > 0 ? 1 : 0;
```

---

## CheckSpecCollection and TestCase types

```typescript
// Hook types
type HookCommand =
  | { type: "tool-call"; tool: string; input: Record<string, unknown> }
  | { type: "shell"; command: string; args?: string[] };

interface HookDefinition {
  name: string;
  run: HookCommand;
  capture?: Record<string, string>;  // JSONPath expressions → named variables
  failFast?: boolean;   // default: true for setup phases, false for teardown
  timeoutMs?: number;   // default: 10000
}

interface TestHooks {
  beforeAll?: HookDefinition[];
  afterAll?: HookDefinition[];
  beforeEach?: HookDefinition[];
  afterEach?: HookDefinition[];
}

interface CheckSpecCollection {
  version: "1.0";
  name: string;
  description?: string;
  server:
    | {
        // Stdio: spawn a local MCP server process
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      }
    | {
        // HTTP: connect to a running MCP server
        url: string;
        transport?: "streamable-http" | "sse";  // default: "streamable-http"
        headers?: Record<string, string>;        // e.g. Authorization
      };
  hooks?: TestHooks;
  describe?: DescribeBlock[];  // grouped test blocks with per-group hooks
  tests: TestCase[];
}

interface DescribeBlock {
  name: string;
  hooks?: TestHooks;
  tests: (TestCase | StreamingTestCase)[];
}

interface TestCase {
  id: string;
  name: string;
  type: "tool-call" | "streaming-tool-call" | "resource-read" | "prompt-get" | "protocol" | "fuzz" | "security";

  // tool-call / streaming-tool-call / fuzz / security
  tool?: string;
  input?: Record<string, unknown>;

  // resource-read
  uri?: string;

  // prompt-get
  promptName?: string;
  promptArgs?: Record<string, string>;   // MCP requires string values

  // security
  securityThreshold?: "critical" | "high" | "medium" | "low" | "info";

  expect?: {
    success?: boolean;          // tool-call only
    schema?: object;            // tool-call, resource-read
    contains?: string;          // all types except protocol, security
    notContains?: string;       // result text must NOT include this substring
    equals?: string;            // full result text must exactly equal this string
    matches?: string;           // result text must match this JavaScript regex pattern
    jsonPath?: Array<{          // extract a value from JSON response and assert
      path: string;             // JSONPath expression (e.g. "$.user.id")
      equals?: string;
      contains?: string;
      matches?: string;
    }>;
    executionTimeMs?: number;   // all types except protocol, security
    maxTokens?: number;         // estimated at ~4 chars/token
  };

  // streaming-tool-call assertions (all fields optional)
  streamExpect?: {
    minChunks?: number;              // minimum number of progress chunks
    chunkContains?: string;          // every chunk must contain this string
    maxChunkIntervalMs?: number;     // max gap between consecutive chunks
    finalContains?: string;          // final assembled result must contain this
    maxTotalMs?: number;             // total stream must complete within this
  };

  tags?: string[];

  /** Extra attempts after first failure. Range: 0–5. Default: 0. */
  retry?: number;
  /** Milliseconds to wait between attempts. Default: 500. */
  retryDelayMs?: number;

  /**
   * Per-test timeout in milliseconds. Overrides RunnerOptions.timeout.
   * Range: 100–300000 (5 minutes). On expiry, the test fails with a timeout message.
   */
  timeoutMs?: number;

  /**
   * Extract values from the test result into the shared context for use in later tests.
   * Keys are variable names; values are JSONPath expressions.
   * Only runs on passing tests. Applies to tool-call, resource-read, and prompt-get.
   *
   * @example { "orderId": "$.order.id", "token": "$.auth.token" }
   */
  capture?: Record<string, string>;

  /** Expand this test into N independent cases. Each row overrides base input/expect. */
  parametrize?: ParameterRow[];
}

interface ParameterRow {
  label: string;                      // appended as [case: <label>]
  input: Record<string, unknown>;     // shallow-merged over base input (row wins)
  expect?: Partial<TestExpect>;       // shallow-merged over base expect (row wins)
  streamExpect?: Partial<StreamExpect>; // shallow-merged over base streamExpect (row wins)
}
```

See [collection-format.md](collection-format.md) for the full annotated JSON format.

---

## Snapshots (Schema Drift Detection)

Capture and compare server capability snapshots to detect breaking changes.

### `captureSnapshot(client: MCPRecordingClient): Promise<ServerSnapshot>`

Connects to a live server and captures a snapshot of all tools (names, descriptions, input schemas), resources, resource templates, and prompts.

### `diffSnapshots(baseline: ServerSnapshot, current: ServerSnapshot): DriftFinding[]`

Compares two snapshots and returns an array of drift findings. Each finding has a `type` (`added`, `removed`, `changed`), `severity` (`breaking`, `compatible`, `info`), and a human-readable `message`.

```typescript
import { captureSnapshot, diffSnapshots } from "@checkspec/core";

const baseline = JSON.parse(readFileSync("checkspec-snapshot.json", "utf8"));
const current = await captureSnapshot(client);
const findings = diffSnapshots(baseline, current);

for (const f of findings) {
  console.log(`[${f.severity}] ${f.type}: ${f.message}`);
}
```

The CLI command `checkspec diff` wraps this for everyday use.
