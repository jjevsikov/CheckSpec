# CheckSpec Architecture

## Overview

CheckSpec is built as a **layered TypeScript monorepo**. The core library (`@checkspec/core`) is completely independent of the CLI (`@checkspec/cli`), making it embeddable in other tools or CI scripts.

```
┌──────────────────────────────────────────────────────────────────┐
│  User entry points                                               │
│                                                                  │
│  checkspec CLI              programmatic API                       │
│  (packages/cli)           (import from @checkspec/core)            │
└────────────────────┬─────────────────────┬───────────────────────┘
                     │                     │
                     ▼                     ▼
┌──────────────────────────────────────────────────────────────────┐
│  @checkspec/core                                                   │
│                                                                  │
│  ┌─────────────────────┐    ┌──────────────────────────────────┐ │
│  │  MCPRecordingClient │    │  SchemaInputGenerator            │ │
│  │  (client/)          │    │  (generators/)                   │ │
│  │                     │    │                                  │ │
│  │  Wraps MCP SDK      │    │  valid / invalid / edge / fuzz   │ │
│  │  Client + records   │    │  inputs from JSON Schema         │ │
│  │  all requests       │    └──────────────────────────────────┘ │
│  └──────────┬──────────┘                                        │
│             │ used by                                            │
│  ┌──────────▼──────────────────────────────────────────────┐    │
│  │  HookRunner (hooks/)                                    │    │
│  │  runHooks(hooks, phase) → HookResult[]                  │    │
│  │  HookAbortError — thrown on failFast setup failure      │    │
│  │  Supports: tool-call hooks, shell hooks, timeouts       │    │
│  └──────────┬──────────────────────────────────────────────┘    │
│             │ orchestrated by                                    │
│  ┌──────────▼──────────────────────────────────────────────┐    │
│  │  TestRunner (runner/)                                   │    │
│  │                                                         │    │
│  │  runCollection(CheckSpecCollection) → RunSummary          │    │
│  │    beforeAll → [beforeEach → runTest → afterEach]* → afterAll   │
│  │  runTest(TestCase) → TestResult                         │    │
│  │                                                         │    │
│  │  dispatches to:                                         │    │
│  │  • runToolCallTest          → callTool() + MCPExpect    │    │
│  │  • runResourceReadTest      → readResource() + asserts  │    │
│  │  • runPromptGetTest         → getPrompt() + assertions  │    │
│  │  • runProtocolTest          → listTools() liveness check│    │
│  │  • runFuzzTest              → callTool() — any response │    │
│  │  • runSecurityTest          → SecurityScanner.scanTool()│    │
│  │  • runStreamingToolCallTest → callTool() + chunk asserts│    │
│  └──────────┬──────────────────────────────────────────────┘    │
│             │ results flow to                                    │
│  ┌──────────▼──────────────────────────────────────────────┐    │
│  │  Reporters (reporters/)                                 │    │
│  │  ConsoleReporter | JUnitReporter | JSONReporter         │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│  @modelcontextprotocol/sdk (external dependency)                 │
│  Client, StdioClientTransport, types                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### MCPRecordingClient (`packages/core/src/client/`)

A thin wrapper around the official MCP SDK `Client` class. Its main job is to **record every request/response pair** and expose them via `getRecording()`.

**Why wrap instead of extending?** The SDK `Client` class uses complex generics. Composition avoids TypeScript fights and makes mocking in tests straightforward.

```
MCPRecordingClient
  constructor(transport: Transport)
    → creates MCP Client internally
    → stores transport ref for connect()

  connect() / disconnect()
    → delegates to internal Client

  listTools() / callTool() / listResources() / readResource()
  listPrompts() / getPrompt()
    → records { direction: "request", method, params, timestamp }
    → calls internal Client
    → records { direction: "response", result/error, durationMs }
    → returns result

  getRecording() → RecordedMessage[]
    → returns a copy (mutations don't affect internal state)
```

**Transport lifecycle:** The caller creates a transport (e.g., `StdioClientTransport`) and passes it to `MCPRecordingClient`. The client owns the connection lifecycle from `connect()` to `disconnect()`. The CLI creates a new client per command invocation and disconnects on exit.

---

### TestCollection (`packages/core/src/runner/TestCollection.ts`)

Plain TypeScript interfaces that define the `.checkspec.json` collection format. No runtime logic — these are pure data shapes.

```
CheckSpecCollection
  version: "1.0"
  name: string
  server: { command, args?, env? }
  tests: TestCase[]

TestCase
  id: string          (unique within collection)
  name: string        (shown in output)
  type: "tool-call" | "resource-read" | "prompt-get" | "protocol" | "fuzz" | "security"
  tool?: string       (required for tool-call, fuzz, security)
  input?: object      (tool arguments)
  uri?: string        (required for resource-read)
  promptName?: string (required for prompt-get)
  promptArgs?: Record<string, string>  (prompt template args)
  securityThreshold?: "critical"|"high"|"medium"|"low"|"info"  (default: "medium")
  expect?: {
    success?: boolean
    schema?: JSONSchema
    contains?: string
    executionTimeMs?: number
  }
  tags?: string[]
```

---

### TestRunner (`packages/core/src/runner/TestRunner.ts`)

Orchestrates test execution. Takes a `MCPRecordingClient` and `RunnerOptions`, runs a collection, and returns a `RunSummary`.

**Execution flow:**

```
runCollection(collection)
  1. Run top-level beforeAll hooks (via HookRunner + HookContext)
     → hooks with `capture` extract values from responses into named variables
     → failFast hook fails → skip all tests, still run afterAll

  2. For each describe block (in array order):
     a. expandParametrizedTests(block.tests) → flat TestCase[]
     b. Run describe-level beforeAll hooks
        → failure → skip all tests in this group, run describe afterAll, continue to next group
     c. For each expanded test in the group:
        → resolve {{varName}} templates (via HookContext)
        → filter by tags
        → run top-level beforeEach, then describe-level beforeEach
        → executeWithRetry(test)
          → runTest(test) — single attempt
          → if failed and retry > 0: sleep(retryDelayMs), retry up to N times
          → if isTransportError(error): bail immediately (no retry for EPIPE, EOF, etc.)
        → run describe-level afterEach, then top-level afterEach (always)
        → if bail and test failed: stop loop
     d. Run describe-level afterAll (always — teardown guarantee)

  3. expandParametrizedTests(top-level tests) → flat TestCase[]
     For each expanded top-level test:
     → resolve {{varName}} templates
     → filter by tags
     → run top-level beforeEach
     → executeWithRetry(test)
     → run top-level afterEach (always)
     → if bail and test failed: stop loop

  4. Run top-level afterAll hooks (always)

  5. return RunSummary { total, passed, failed, skipped, durationMs, results, hookResults, parametrizedSourceCount }

runTest(test)
  → switch on test.type
  → call appropriate private method
  → catch all errors → return { passed: false, error: message }
```

**Why per-test error catching?** Tests should never crash the runner. A buggy server or bad assertion should produce a failed `TestResult`, not an unhandled exception.

**Why teardown always runs?** `afterAll` and `afterEach` are run with `isTeardown: true`, which catches and discards `HookAbortError`. This guarantees cleanup even when tests or earlier hooks fail.

**Why transport errors bypass retry?** `isTransportError()` detects connection-level failures (EPIPE, ECONNRESET, EOF, spawn ENOENT) that will never recover by retrying. This prevents wasting retries on a dead server process. The check uses a word-boundary regex for "eof" (`/\beof\b/`) to avoid false positives on strings like "Geoffrey".

### HookRunner (`packages/core/src/hooks/`)

Executes individual hook definitions. Two hook types:

- **`tool-call`** — calls `client.callTool()` with a timeout race. Any completed MCP call (even `isError: true`) counts as a pass. Only transport-level failures (timeout, disconnect) fail the hook.
- **`shell`** — spawns the command via `child_process.spawn`. Exit code `0` = pass. Timeout triggers SIGTERM then SIGKILL (1 second escalation). stdout/stderr captured and included in the error message.

`failFast` defaults: `true` for setup phases (`beforeAll`, `beforeEach`), `false` for teardown phases (`afterAll`, `afterEach`). Individual hooks can override this default.

### HookContext (`packages/core/src/hooks/HookContext.ts`)

Stores named variables captured by hooks and resolves `{{varName}}` placeholder templates. Created per-collection-run by `TestRunner.runCollection()` and passed to both `HookRunner.runHooks()` and the test input resolver.

- **`capture` on hooks** — after a `tool-call` hook completes, `applyCapture()` extracts values from the JSON response using JSONPath dot-notation (e.g. `$.user.id`) and stores them in the context.
- **`resolve(value)`** — recursively walks objects, arrays, and strings, replacing `{{varName}}` with stored values. Circular references are detected and left unresolved.
- **`extractValue(json, path)`** — static helper for JSONPath extraction. Returns `string | undefined`.

See [hook-context.md](hook-context.md) for the user-facing guide.

---

### MCPExpect (`packages/core/src/assertions/expect.ts`)

A chainable assertion class modelled on Jest's `expect` API, specialized for `CallToolResult`.

```
expect(result, durationMs?)
  .toSucceed()           → result.isError is falsy
  .toFail()              → result.isError === true
  .toContainText(str)    → any TextContent item contains str
  .toMatchSchema(schema) → content text (parsed as JSON) validates against schema
  .toRespondWithin(ms)   → durationMs <= ms
  .not                   → returns new MCPExpect with negated=true

All methods return `this` for chaining.
All methods throw AssertionError on failure (caught by TestRunner).
```

**Negation:** The `not` getter creates a new `MCPExpect` instance with `negated: true`. Each `assert()` call inverts the condition check when negated. This avoids duplicating assertion logic.

---

### SchemaInputGenerator (`packages/core/src/generators/`)

Generates test inputs from a JSON Schema, driven by a `mode`:

| Mode | Behaviour |
|------|-----------|
| `valid` | Uses `json-schema-faker` to generate conforming data |
| `invalid` | Type mismatches and missing required fields |
| `edge` | Empty strings, null, max-length strings, unicode, injection payloads |
| `fuzz` | Mix of all three modes |

The `generateEdgeCases()` method is called directly by the CLI's scan command to produce the "edge case" test suite for each discovered tool.

**Fuzz inputs vs. security probes:** `SchemaInputGenerator` produces inputs that test *server resilience* — does it stay alive when given adversarial values? The `SecurityScanner` is a completely separate component that tests *server behavior* — does it behave maliciously? The two work at different layers and complement each other. See [getting-started.md](../docs/getting-started.md#fuzz-testing-vs-security-scanning) for the full explanation.

---

### SecurityScanner (`packages/core/src/security/`)

Runs three classes of security probes against a live server:

**Tool Poisoning** — Static analysis of tool name and description:
- Regex patterns: `ignore previous instructions`, `SYSTEM:`, `<script`, `<iframe`, HTML comments, and more
- Hidden/invisible unicode in name or description (`\u200B`, `\uFEFF`, bidi override chars)
- Description length > 1000 chars (may contain hidden instructions)

**Rug-Pull Detection** — Behavioural:
- Calls each tool **3 times** with identical minimal input
- Compares call-1 to call-3 using **Levenshtein edit-distance ratio**
- Flags if ratio > 20% (allows pure numeric/timestamp variance)

**Prompt Injection** — Active probing:
- Sends 4 injection payloads as tool inputs
- Checks if the response echoes the payload verbatim (substring match)
- Checks for AI system-prompt leakage markers in the response

Both `scan(client)` (all tools) and `scanTool(client, tool)` (single tool) are public.
`SecurityFinding` has `severity`, `type`, `tool`, `description`, and `evidence` fields.

---

### Reporters (`packages/core/src/reporters/`)

All reporters implement the `Reporter` interface:

```typescript
interface Reporter {
  onTestStart(test: TestCase): void;
  onTestEnd(result: TestResult): void;
  onHookEnd?(result: HookResult): void;       // optional
  onDescribeStart?(name: string): void;        // optional — group section header
  onDescribeEnd?(name: string): void;          // optional — group section footer
  onRunEnd(summary: RunSummary): void;
  flush(): string;
}
```

`onHookEnd`, `onDescribeStart`, and `onDescribeEnd` are optional so existing reporters don't need to implement them. The CLI passes all callbacks through `RunnerOptions` so output streams in real time.

`flush()` returns the final formatted string (used when `--output json` or `--output junit` is passed).

| Reporter | Output |
|----------|--------|
| `ConsoleReporter` | Coloured terminal with ✓/✗, `[setup]/[teardown]/[each]` hook labels, and hooks footer |
| `HTMLReporter` | Self-contained HTML report with inline CSS — single file, no external dependencies |
| `JUnitReporter` | XML for GitHub Actions / Jenkins — failed hooks emit as `<testcase classname="hooks">` |
| `JSONReporter` | Full `RunSummary` as pretty JSON |

---

## Data Flow: `checkspec scan`

```
1. CLI parses args
   command = "node dist/index.js"  (or "uv run server.py" --cwd /path)

2. CLI creates StdioClientTransport({ command, args, cwd, env, stderr })
   → spawns the server subprocess
   → stderr: "ignore" by default (suppress Python INFO logs); "inherit" with --verbose

3. CLI creates MCPRecordingClient(transport)
   → wraps MCP SDK Client

4. client.connect()
   → MCP initialize handshake

5. Discovery:
   client.listTools()              → Tool[] with inputSchema for each
   client.listResources()          → Resource[] (silently skipped if unsupported)
   client.listResourceTemplates()  → ResourceTemplate[] (silently skipped if unsupported)
   client.listPrompts()            → Prompt[] (silently skipped if unsupported)

6. Test generation per section:
   ── Protocol ──
   One protocol test (listTools liveness check)

   ── Tools ──
   For each tool:
     SchemaInputGenerator.generate(inputSchema, { mode: "valid", count: 1 })
     → 1 "valid input" tool-call test (expect: success=true)

   ── Fuzz ──
   For each tool:
     SchemaInputGenerator.generateEdgeCases(inputSchema).slice(0, 5)   (or all with --fuzz)
     SchemaInputGenerator.generate(inputSchema, { mode: "invalid" })   (with --fuzz only)
     SchemaInputGenerator.generate(inputSchema, { mode: "fuzz" })      (with --fuzz only)
     → N fuzz tests (no assertions — any response is a pass)

   ── Resources ──
   For each resource: one resource-read test (no assertions)
   For each resource template: one resource-read test with example URI (no assertions)

   ── Prompts ──
   For each prompt:
     probePromptArgs() — if prompt has required arguments, calls without args,
     parses error for valid enum values, retries with discovered values
     → one prompt-get test (no assertions)

7. TestRunner.runTest(each test) — streamed by section
   ConsoleReporter.onTestEnd(result) printed in real time

8. Security Scan:
   SecurityScanner.scan(client)
   → For each tool: checkToolPoisoning + checkRugPull + checkPromptInjection
   → Findings printed as a section; exit code 1 if any critical findings

9. If --save-recording or --output json:
   client.getRecording() → saved to JSON file

10. client.disconnect()
    → closes subprocess
```

---

## Module Resolution

All packages use `moduleResolution: "NodeNext"`. This means:

- Imports respect the package's `exports` field exactly
- All **relative imports** must have `.js` extension in source (TypeScript compiles `.ts` → `.js`, the extension in the import statement must match the output)
- External packages: TypeScript resolves via `exports` + `typesVersions` fields

The MCP SDK uses a wildcard export `"./*": { "import": "./dist/esm/*" }` which makes every subpath importable:
- `@modelcontextprotocol/sdk/client/stdio` → `dist/esm/client/stdio.js`
- `@modelcontextprotocol/sdk/server/mcp` → `dist/esm/server/mcp.js`

---

## Fixture Server Design

Each fixture is a standalone Node.js process communicating over stdio using the MCP protocol. They use the high-level `McpServer` API:

```
McpServer (high-level)
  registerTool(name, { inputSchema: ZodShape }, callback)
    → Zod validates inputs before calling callback
    → callback errors are caught and returned as { isError: true }
    → TypeScript infers argument types from ZodShape

StdioServerTransport
  → reads JSON-RPC from stdin, writes to stdout
  → process.stdin / process.stdout
```

Fixture design principles:
- **echo-server**: the "golden path" — should always pass all tests. Has `echo` tool, `version://info` resource, and `greet` prompt.
- **buggy-server**: triggers error paths — `divide` throws on `b=0`, `slow-op` times out, `wrong-schema` returns mismatched types.
- **malicious-server**: triggers all three security scanner probes — `helpful-task` has hidden unicode + injection text in its description; `shape-shifter` returns malicious payload on call 3+; `injector` always returns prompt injection in its response content.

---

## Reporters (`packages/core/src/reporters/`)

All reporters implement the `Reporter` interface and produce different output formats from the same `RunSummary` data:

| Reporter | Output | Use case |
|----------|--------|----------|
| `ConsoleReporter` | Coloured terminal ✓/✗ | Interactive development |
| `JUnitReporter` | XML | GitHub Actions / Jenkins CI artifacts |
| `JSONReporter` | Pretty JSON | Machine-readable, API ingestion |
| `HTMLReporter` | Self-contained HTML | Shareable reports, CI artifacts |

`HTMLReporter` produces a single `.html` file with no external dependencies — dark theme, summary stats, expandable test rows, security findings panel. Use via `--report-html report.html` or `--output html`.

---

## Package Architecture

All test logic lives in `@checkspec/core`. The CLI and SDK are thin entry points that call core functions.

```
┌──────────────────────────────────────────────────────┐
│  Entry points                                          │
│                                                        │
│  CLI                 SDK                               │
│  (packages/cli)      (packages/sdk)                    │
└──────────┬───────────────────┬────────────────────────┘
           │                   │
           └───────────────────┘
                     │
                     ▼
           ┌───────────────────────────────┐
           │  @checkspec/core                │
           │  TestRunner, SecurityScanner, │
           │  AITestGenerator, Reporters…  │
           └───────────────────────────────┘
```

### `packages/cli` — Command-line tool
The CLI is intentionally thin: it parses arguments, calls core functions, and formats output. No test logic lives here.

### `packages/sdk` — Programmatic API
A clean, stable, high-level API for embedding CheckSpec in test frameworks, CI scripts, and third-party tools:
```typescript
import { scan, test, generate } from "@checkspec/sdk";

// Vitest integration example:
const { summary } = await scan("node dist/server.js");
expect(summary.failed).toBe(0);
```

### `packages/server` — HTTP API
An HTTP API server that exposes `@checkspec/core` over REST. Queues jobs and returns results; the actual test execution calls the same `TestRunner` the CLI uses.

### `packages/web` — Web dashboard (placeholder)
React/Next.js frontend. Talks to `packages/server` via REST.
