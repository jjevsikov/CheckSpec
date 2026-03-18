# CheckSpec Collection Format

A `.checkspec.json` file defines a collection of tests to run against an MCP server. This document describes the format in detail.

## Editor Autocomplete (`$schema`)

Add a `$schema` field to get **autocomplete, hover docs, and inline validation** in VS Code, JetBrains, and any JSON-aware editor:

```json
{
  "$schema": "https://raw.githubusercontent.com/jjevsikov/CheckSpec/main/packages/core/checkspec.schema.json",
  "version": "1.0",
  "name": "My Server Tests",
  ...
}
```

> **Automatic:** `checkspec init` and `checkspec generate` add this field automatically. If you're writing a collection by hand, copy the `$schema` line above.

The JSON Schema is generated from the same Zod schema used for runtime validation, so editor hints always match what CheckSpec actually accepts.

---

## JSON Schema Reference

```json
{
  "$schema": "http://json-schema.org/draft-07/schema",
  "type": "object",
  "required": ["version", "name", "server"],
  "properties": {
    "version": { "type": "string", "enum": ["1.0"] },
    "name": { "type": "string" },
    "description": { "type": "string" },
    "server": {
      "type": "object",
      "description": "Exactly one of command or url must be provided",
      "properties": {
        "command": { "type": "string", "description": "Command to spawn a stdio MCP server (e.g. 'node', 'uv')" },
        "args": { "type": "array", "items": { "type": "string" } },
        "cwd": { "type": "string", "description": "Working directory (required for Python uv projects)" },
        "env": { "type": "object", "additionalProperties": { "type": "string" } },
        "url": { "type": "string", "format": "uri", "description": "URL of a running HTTP-based MCP server (mutually exclusive with command)" },
        "transport": {
          "type": "string",
          "enum": ["streamable-http", "sse"],
          "description": "HTTP transport protocol. 'streamable-http' is the default; 'sse' for legacy servers"
        },
        "headers": { "type": "object", "additionalProperties": { "type": "string" }, "description": "HTTP headers sent with every request (e.g. Authorization)" }
      }
    },
    "hooks": {
      "type": "object",
      "description": "Setup and teardown hooks — run before/after the entire suite or each individual test",
      "properties": {
        "beforeAll":  { "type": "array", "items": { "$ref": "#/$defs/HookDefinition" } },
        "afterAll":   { "type": "array", "items": { "$ref": "#/$defs/HookDefinition" } },
        "beforeEach": { "type": "array", "items": { "$ref": "#/$defs/HookDefinition" } },
        "afterEach":  { "type": "array", "items": { "$ref": "#/$defs/HookDefinition" } }
      }
    },
    "describe": {
      "type": "array",
      "description": "Grouped test blocks with optional per-group hooks (single-level only)",
      "items": {
        "type": "object",
        "required": ["name", "tests"],
        "properties": {
          "name": { "type": "string", "description": "Group name displayed as a section header" },
          "hooks": { "$ref": "#/properties/hooks", "description": "Per-group hooks (scoped to this describe block)" },
          "tests": { "type": "array", "items": { "$ref": "#/$defs/TestCase" } }
        }
      }
    },
    "tests": { "type": "array", "items": { "$ref": "#/$defs/TestCase" } },
    "concurrency": { "type": "integer", "minimum": 1, "description": "Max tests to run in parallel (default: 1 = serial)" }
  },
  "$defs": {
    "HookDefinition": {
      "type": "object",
      "required": ["name", "run"],
      "properties": {
        "name": { "type": "string", "description": "Human-readable label shown in console output" },
        "run": {
          "oneOf": [
            {
              "type": "object",
              "required": ["type", "tool", "input"],
              "properties": {
                "type": { "const": "tool-call" },
                "tool": { "type": "string" },
                "input": { "type": "object" }
              }
            },
            {
              "type": "object",
              "required": ["type", "command"],
              "properties": {
                "type": { "const": "shell" },
                "command": { "type": "string" },
                "args": { "type": "array", "items": { "type": "string" } }
              }
            }
          ]
        },
        "capture": {
          "type": "object",
          "additionalProperties": { "type": "string" },
          "description": "Extract values from a tool-call response. Keys are variable names; values are JSONPath expressions (e.g. '$.user.id'). Captured values can be referenced as {{varName}} in later hooks and tests."
        },
        "failFast": {
          "type": "boolean",
          "description": "Abort the suite if this hook fails (default: true for beforeAll/beforeEach, false for afterAll/afterEach)"
        },
        "timeoutMs": { "type": "number", "description": "Hook-level timeout in ms (default: 10000)" }
      }
    },
    "TestCase": {
      "type": "object",
      "required": ["name", "type"],
      "properties": {
        "id": { "type": "string", "description": "Optional — auto-generated from name when omitted" },
        "name": { "type": "string" },
        "type": {
          "type": "string",
          "enum": ["tool-call", "streaming-tool-call", "resource-read", "prompt-get", "protocol", "fuzz", "security"]
        },
        "tool": { "type": "string", "description": "Tool name (tool-call, streaming-tool-call, fuzz, security)" },
        "input": { "type": "object", "description": "Tool input arguments" },
        "uri": { "type": "string", "description": "Resource URI (resource-read)" },
        "promptName": { "type": "string", "description": "Prompt name (prompt-get)" },
        "promptArgs": {
          "type": "object",
          "additionalProperties": { "type": "string" },
          "description": "Prompt template arguments — all values must be strings (MCP spec)"
        },
        "securityThreshold": {
          "type": "string",
          "enum": ["critical", "high", "medium", "low", "info"],
          "description": "Maximum tolerated severity (ceiling). Findings strictly ABOVE this level fail; at or below pass. Default: medium (HIGH and CRITICAL fail)"
        },
        "expect": {
          "type": "object",
          "properties": {
            "success": { "type": "boolean" },
            "schema": { "type": "object" },
            "contains": { "type": "string" },
            "notContains": { "type": "string", "description": "Response text must NOT include this substring" },
            "equals": { "type": "string", "description": "Response text must exactly equal this string" },
            "matches": { "type": "string", "description": "Response text must match this JavaScript regex pattern" },
            "jsonPath": {
              "type": "array",
              "description": "Extract a value from the JSON response and assert on it",
              "items": {
                "type": "object",
                "required": ["path"],
                "properties": {
                  "path": { "type": "string", "description": "JSONPath expression, e.g. '$.user.id' or '$.items[0].name'" },
                  "equals": { "type": "string" },
                  "contains": { "type": "string" },
                  "matches": { "type": "string" }
                }
              }
            },
            "executionTimeMs": { "type": "number" },
            "maxTokens": { "type": "number", "description": "Max response size in tokens (~4 chars/token)" }
          }
        },
        "streamExpect": {
          "type": "object",
          "description": "Assertions for streaming-tool-call tests",
          "properties": {
            "minChunks": { "type": "number" },
            "chunkContains": { "type": "string" },
            "maxChunkIntervalMs": { "type": "number" },
            "finalContains": { "type": "string" },
            "maxTotalMs": { "type": "number" }
          }
        },
        "tags": { "type": "array", "items": { "type": "string" } },
        "retry": {
          "type": "integer",
          "minimum": 0,
          "maximum": 5,
          "description": "Number of extra attempts on failure (0 = no retry, max 5)"
        },
        "retryDelayMs": {
          "type": "integer",
          "minimum": 0,
          "description": "Milliseconds to wait between retry attempts (default: 500)"
        },
        "capture": {
          "type": "object",
          "additionalProperties": { "type": "string" },
          "description": "Extract values from the test result into context for later tests. Keys are variable names ({{varName}}); values are JSONPath expressions. Only runs on passing tests."
        },
        "timeoutMs": {
          "type": "integer",
          "minimum": 100,
          "maximum": 300000,
          "description": "Per-test timeout in ms. Overrides RunnerOptions.timeout. Min 100ms, max 300000ms (5 min)."
        },
        "parametrize": {
          "type": "array",
          "description": "Expand this test into N independent cases. Each row overrides the base input/expect.",
          "items": {
            "type": "object",
            "required": ["label", "input"],
            "properties": {
              "label": { "type": "string", "description": "Appended to the test name as [case: <label>]" },
              "input": { "type": "object", "description": "Shallow-merged over the base input (row wins)" },
              "expect": { "type": "object", "description": "Shallow-merged over the base expect (row wins)" },
              "streamExpect": { "type": "object", "description": "Shallow-merged over base streamExpect (row wins)" }
            }
          }
        }
      }
    }
  }
}
```

> **Note on Strict Validation:** CheckSpec uses `zod` to validate this schema at runtime before spinning up your server. The `expect` and `streamExpect` blocks are strictly typed — any unknown keys or typos (like `"sucess"` or `"finalContians"`) will immediately abort the run with a human-readable validation error, preventing tests from silently passing.

---

## Annotated Example

```json
{
  "version": "1.0",
  "name": "My Server Tests",
  "description": "Full test suite for my-api-server",

  "server": {
    "command": "node",
    "args": ["dist/server.js"],
    "env": { "NODE_ENV": "test" }
  },

  "hooks": {
    "beforeAll": [
      {
        "name": "seed fixture user alice",
        "run": { "type": "tool-call", "tool": "create_user", "input": { "name": "Alice" } },
        "capture": { "userId": "$.user.id" },
        "timeoutMs": 5000
      }
    ],
    "afterAll": [
      {
        "name": "reset store",
        "run": { "type": "tool-call", "tool": "reset_store", "input": {} }
      },
      {
        "name": "print teardown banner",
        "run": { "type": "shell", "command": "echo", "args": ["teardown complete"] }
      }
    ],
    "beforeEach": [
      {
        "name": "verify connectivity",
        "run": { "type": "tool-call", "tool": "list_users", "input": {} }
      }
    ]
  },

  "tests": [

    {
      "id": "proto-init",
      "name": "Protocol: Initialization handshake",
      "type": "protocol",
      "tags": ["smoke", "protocol"]
    },

    {
      "id": "tool-greet-basic",
      "name": "greet: returns greeting with name",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Alice" },
      "expect": { "success": true, "contains": "Alice", "notContains": "Error" },
      "tags": ["smoke", "greet"]
    },

    {
      "id": "tool-greet-exact",
      "name": "greet: exact response text",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Alice" },
      "expect": { "equals": "Hello, Alice!" },
      "tags": ["greet"]
    },

    {
      "id": "tool-greet-regex",
      "name": "greet: response matches pattern",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Alice" },
      "expect": { "matches": "^Hello,\\s+\\w+!$" },
      "tags": ["greet"]
    },

    {
      "id": "tool-greet-jsonpath",
      "name": "greet: JSON field assertions",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Alice" },
      "expect": {
        "jsonPath": [
          { "path": "$.greeting", "contains": "Alice" },
          { "path": "$.status", "equals": "ok" }
        ]
      },
      "capture": { "greeting": "$.greeting" },
      "tags": ["greet"]
    },

    {
      "id": "tool-greet-timeout",
      "name": "greet: completes within 2 seconds",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Alice" },
      "expect": { "success": true },
      "timeoutMs": 2000,
      "tags": ["greet", "performance"]
    },

    {
      "id": "tool-greet-fails-on-empty",
      "name": "greet: returns error for empty name",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "" },
      "expect": { "success": false },
      "tags": ["greet"]
    },

    {
      "id": "tool-greet-schema",
      "name": "greet: response matches JSON schema",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Bob" },
      "expect": {
        "schema": {
          "type": "object",
          "properties": { "greeting": { "type": "string" } },
          "required": ["greeting"]
        }
      },
      "tags": ["greet"]
    },

    {
      "id": "tool-greet-perf",
      "name": "greet: responds within 100ms",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Charlie" },
      "expect": { "success": true, "executionTimeMs": 100 },
      "tags": ["performance"]
    },

    {
      "id": "resource-version",
      "name": "version resource: returns JSON with version field",
      "type": "resource-read",
      "uri": "version://info",
      "expect": {
        "schema": {
          "type": "object",
          "properties": { "version": { "type": "string" } },
          "required": ["version"]
        },
        "executionTimeMs": 200
      },
      "tags": ["smoke", "resources"]
    },

    {
      "id": "prompt-summarize",
      "name": "summarize prompt: renders with topic argument",
      "type": "prompt-get",
      "promptName": "summarize",
      "promptArgs": { "topic": "TypeScript generics" },
      "expect": { "contains": "TypeScript", "executionTimeMs": 500 },
      "tags": ["prompts"]
    },

    {
      "id": "fuzz-greet",
      "name": "greet: handles SQL injection without crashing",
      "type": "fuzz",
      "tool": "greet",
      "input": { "name": "'; DROP TABLE users; --" },
      "tags": ["fuzz"]
    },

    {
      "id": "security-greet",
      "name": "greet: no high-severity security findings",
      "type": "security",
      "tool": "greet",
      "securityThreshold": "high",
      "tags": ["security"]
    },

    {
      "id": "greet-with-retry",
      "name": "greet: retries up to 2 times on transient failure",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Alice" },
      "expect": { "success": true, "contains": "Alice" },
      "retry": 2,
      "retryDelayMs": 500,
      "tags": ["smoke"]
    },

    {
      "id": "greet-parametrize",
      "name": "greet: greets different users",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "" },
      "expect": { "success": true },
      "parametrize": [
        { "label": "Alice", "input": { "name": "Alice" }, "expect": { "contains": "Alice" } },
        { "label": "Bob",   "input": { "name": "Bob" },   "expect": { "contains": "Bob" } },
        { "label": "Charlie", "input": { "name": "Charlie" }, "expect": { "contains": "Charlie" } }
      ],
      "tags": ["greet"]
    }

  ]
}
```

---

## Test Types

### `tool-call`

Calls a specific tool with given input arguments and validates the response.

**Required:** `tool`

| Field | Description |
|-------|-------------|
| `tool` | Name of the tool to call |
| `input` | Arguments passed to the tool (defaults to `{}` if omitted) |
| `expect.success` | `true` → `isError` must be falsy; `false` → `isError` must be `true` |
| `expect.contains` | Concatenated text content must include this substring |
| `expect.schema` | Text is parsed as JSON and validated against this JSON Schema (Ajv v8) |
| `expect.executionTimeMs` | Maximum allowed response time in ms |

**Key behaviour:** MCP tool errors are returned as `{ isError: true, content: [...] }` — they are NOT JavaScript exceptions. Use `expect.success: false` to assert a tool correctly rejects bad input.

> **`expect.schema` validates the tool's parsed text output, NOT the MCP JSON-RPC envelope.**
>
> MCP wraps every tool response in `{ content: [{ type: "text", text: "..." }] }`.
> The `schema` assertion does the following:
> 1. Concatenates all `text` fields from the response `content` array
> 2. Parses the concatenated string as JSON (`JSON.parse(...)`)
> 3. Validates *that parsed object* against your schema using Ajv v8
>
> Your schema should describe the tool's **actual payload** (e.g. `{ "greeting": "Hello" }`),
> not the MCP wrapper (`{ "content": [...] }`). If the tool's text output is not valid JSON,
> the assertion fails with a parse error.

---

### `resource-read`

Reads a resource by URI and validates the content.

**Required:** `uri`

| Field | Description |
|-------|-------------|
| `uri` | The MCP resource URI to read (e.g. `"version://info"`, `"config://settings"`) |
| `expect.success` | `true` → resource must be readable without error; `false` → resource read must throw |
| `expect.contains` | Resource text content must include this substring |
| `expect.schema` | Text parsed as JSON and validated against this schema |
| `expect.executionTimeMs` | Maximum allowed response time in ms |

> **`expect.schema` validates the parsed text content, not the MCP `ReadResourceResult` envelope.**
> The assertion joins all text fields in the resource contents array, parses the result as JSON,
> and validates that object — not the outer `{ contents: [...] }` wrapper.

---

### `prompt-get`

Fetches a prompt template (with optional template arguments) and validates the resulting messages.

**Required:** `promptName`

| Field | Description |
|-------|-------------|
| `promptName` | Name of the prompt to fetch |
| `promptArgs` | Template arguments — must be `Record<string, string>` (MCP requires string values) |
| `expect.success` | `true` → prompt must resolve without error; `false` → prompt get must throw |
| `expect.contains` | Concatenated text of all message content must include this substring |
| `expect.executionTimeMs` | Maximum allowed response time in ms |

---

### `protocol`

Verifies basic MCP protocol compliance. Passes as long as the server is reachable and responds to `tools/list` without error.

No additional fields required.

---

### `fuzz`

Calls a tool with an adversarial `input`. Passes as long as the server returns **any** MCP response — even `isError: true` counts as a pass. A disconnection, timeout, or protocol error is a failure.

**Required:** `tool`

Use this to confirm the server handles unexpected inputs without crashing.

---

### `security`

Runs `SecurityScanner.scanTool()` against a specific tool. Fails if any finding's severity is strictly above `securityThreshold`.

**Required:** `tool`

| Field | Default | Description |
|-------|---------|-------------|
| `securityThreshold` | `"medium"` | Maximum **tolerated** severity — the highest severity that is still allowed to pass. Findings **strictly above** this level fail the test; findings at or below it are reported but pass. Values: `"critical"`, `"high"`, `"medium"`, `"low"`, `"info"` |

**How `securityThreshold` works — direction matters:**

| Threshold | Passes | Fails |
|-----------|--------|-------|
| `"medium"` (default) | INFO, LOW, MEDIUM | HIGH, CRITICAL |
| `"high"` | INFO, LOW, MEDIUM, HIGH | CRITICAL |
| `"critical"` | INFO, LOW, MEDIUM, HIGH, CRITICAL | *(nothing — all findings pass)* |
| `"low"` | INFO, LOW | MEDIUM, HIGH, CRITICAL |
| `"info"` | INFO | LOW, MEDIUM, HIGH, CRITICAL |

Think of it as a **ceiling**: the threshold is the highest severity you are willing to accept. Anything above the ceiling fails.

The scanner runs three probes:
1. **Tool poisoning** — checks for suspicious patterns, hidden unicode, and description length > 1000 chars
2. **Rug-pull** — calls the tool 3× with identical input; flags if call-1 and call-3 differ by > 20% edit distance
3. **Prompt injection** — sends injection payloads and checks if the response echoes them or contains AI-marker text

---

## Optional Test IDs

The `id` field on tests is **optional**. When omitted, CheckSpec auto-generates a stable, human-readable identifier from the test name:

```json
{
  "tests": [
    {
      "name": "echo › hello world",
      "type": "tool-call",
      "tool": "echo",
      "input": { "message": "hello" },
      "expect": { "success": true }
    }
  ]
}
```

This test receives the auto-generated ID `"echo-hello-world"`.

**Algorithm:**
1. Slugify the name: lowercase, replace non-alphanumeric runs with hyphens, trim
2. Truncate to 40 characters
3. Deduplicate: if the slug is already taken (by another test or an explicit ID), append a numeric suffix

**Rules:**
- Explicit `id` values are never modified and always take priority
- Auto-generated IDs are deterministic — the same collection always produces the same IDs
- Top-level tests and `describe` block tests share a single dedup namespace
- `--output json` includes the resolved IDs, which can be used with `--filter`
- Parametrize expansion appends `[0]`, `[1]` to the (auto or explicit) ID

You can mix explicit and auto-generated IDs freely:

```json
{
  "tests": [
    { "id": "smoke-test", "name": "smoke", "type": "protocol" },
    { "name": "echo works", "type": "tool-call", "tool": "echo", "input": { "message": "hi" }, "expect": { "success": true } }
  ]
}
```

---

## Concurrency

Run tests in parallel by setting the top-level `concurrency` field:

```json
{
  "version": "1.0",
  "name": "Parallel Tests",
  "server": { "command": "node", "args": ["dist/server.js"] },
  "concurrency": 4,
  "tests": [...]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `concurrency` | `integer ≥ 1` | `1` | Maximum tests to run in parallel within each describe block and the top-level test list |

**How it works:**
- Tests are processed in chunks of `concurrency` size. Tests within a chunk run in parallel; the next chunk waits for the previous one to finish.
- `beforeAll` / `afterAll` always run serially (once).
- Each test's full lifecycle (`beforeEach` → test → `afterEach`) runs as one concurrent unit — hooks are never interleaved with their own test.
- Describe blocks run sequentially; tests *within* each block run concurrently.
- `--bail` stops launching new chunks but lets in-flight tests in the current chunk complete.

**When to use:**
- Stateless tools (math, formatting, parsing) — safe to parallelize.
- Independent tests that don't share server-side state.

**When NOT to use (keep `concurrency: 1`):**
- Tests that mutate shared state (e.g., create/delete users, modify databases).
- Tests whose hooks depend on a specific execution order.
- Tests with `beforeEach`/`afterEach` hooks that conflict when run concurrently.

See `examples/concurrent-tests.json` for a working example.

---

## Hooks

Hooks let you seed fixtures, reset state, or verify connectivity before and after tests. They run outside the test count — hook results appear in a separate "Hooks: N passed, N failed" footer.

### Hook phases

| Phase | When it runs |
|-------|-------------|
| `beforeAll` | Once before any test in the collection runs |
| `afterAll` | Once after all tests finish — **always runs** even if tests failed |
| `beforeEach` | Before every individual test |
| `afterEach` | After every individual test — **always runs** even if the test failed |

### Hook types

**`tool-call`** — calls a tool on the connected MCP server:
```json
{
  "name": "seed fixture user",
  "run": { "type": "tool-call", "tool": "create_user", "input": { "id": "alice" } }
}
```

**`shell`** — runs a local shell command:
```json
{
  "name": "print banner",
  "run": { "type": "shell", "command": "echo", "args": ["setup complete"] }
}
```

### Hook fields

| Field | Default | Description |
|-------|---------|-------------|
| `name` | (required) | Label shown in console output as `[setup]`, `[teardown]`, or `[each]` |
| `run` | (required) | The command to run — see hook types above |
| `failFast` | `true` for setup phases, `false` for teardown phases | If `true` and the hook fails, abort the suite immediately. Teardown hooks default to `false` so all cleanup runs regardless |
| `timeoutMs` | `10000` | Maximum ms to wait for the hook before failing it |

### Teardown guarantee

`afterAll` and `afterEach` hooks **always run**, even when earlier tests or hooks fail. This guarantees state is cleaned up regardless of test outcome. A `beforeAll` failure skips all tests but still triggers `afterAll`.

### Console output

Hooks appear inline with tests using phase labels:

```
[setup]     seed fixture user alice      ✓ 2ms
[setup]     seed fixture user bob        ✓ 1ms
[each]      verify connectivity          ✓ 0ms
  ✓ get_user › returns seeded user alice  (1ms)
[each]      verify connectivity          ✓ 0ms
  ✗ deliberately failing test            (0ms)
[teardown]  reset store                  ✓ 0ms

Tests: 1 passed, 1 failed
Hooks: 4 passed, 0 failed
```

Failed hooks in JUnit output appear as `<testcase classname="hooks">` elements so CI dashboards track them.

### Hook context variables (`capture` + `{{varName}}`)

`tool-call` hooks can extract values from their response and store them as named variables. Later hooks and tests can reference those values with `{{varName}}` placeholders.

```json
{
  "hooks": {
    "beforeAll": [
      {
        "name": "create test user",
        "run": { "type": "tool-call", "tool": "create_user", "input": { "name": "Alice" } },
        "capture": { "userId": "$.user.id" }
      }
    ],
    "afterAll": [
      {
        "name": "delete test user",
        "run": { "type": "tool-call", "tool": "delete_user", "input": { "id": "{{userId}}" } }
      }
    ]
  },
  "tests": [
    {
      "id": "get-user",
      "name": "get_user › fetches the created user",
      "type": "tool-call",
      "tool": "get_user",
      "input": { "id": "{{userId}}" },
      "expect": { "success": true }
    }
  ]
}
```

| Field | Where | Description |
|-------|-------|-------------|
| `capture` | Hook definition | `{ "varName": "$.path.to.value" }` — JSONPath dot-notation, extracts from the tool-call response |
| `{{varName}}` | Hook `run.input`, test `input`, test `expect.contains` | Replaced with the captured value before execution |

Variables captured by earlier hooks are available to all later hooks and all tests. Unresolved placeholders are left as-is (the literal `{{varName}}` string).

See [hook-context.md](hook-context.md) for the complete guide including JSONPath syntax, execution order, and programmatic API.

---

## Describe Blocks (Hierarchical Grouping)

Group tests into named sections with optional per-group hooks. Top-level hooks still apply; describe-level hooks scope to their group.

```json
{
  "describe": [
    {
      "name": "user management",
      "hooks": {
        "beforeAll": [{ "name": "seed users", "run": { "type": "tool-call", "tool": "seed", "input": {} } }],
        "afterAll":  [{ "name": "cleanup",    "run": { "type": "tool-call", "tool": "reset", "input": {} } }]
      },
      "tests": [
        { "id": "get-user", "name": "get_user works", "type": "tool-call", "tool": "get_user", "input": { "id": "alice" }, "expect": { "success": true } }
      ]
    }
  ],
  "tests": [
    { "id": "final", "name": "top-level test", "type": "protocol" }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Group name — displayed as a section header in console output |
| `hooks` | No | Per-group hooks (`beforeAll`, `afterAll`, `beforeEach`, `afterEach`) |
| `tests` | Yes | Tests scoped to this group |

**Rules:**
- Describe blocks run before top-level tests.
- Only single-level nesting is supported (no `describe` within `describe`).
- `tests: []` without any `describe` blocks still works (full backwards compatibility).
- Parametrize, retry, tags, and context variables all work inside describe blocks.
- If a describe-level `beforeAll` fails, tests in that group are skipped but other groups still run.

See [describe-blocks.md](describe-blocks.md) for the complete guide including hook execution order and interaction with other features.

---

## Retry

Any test case can be configured to automatically re-run on failure:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `retry` | `integer 0–5` | `0` | Extra attempts after the first failure. `0` = single attempt (no retry). |
| `retryDelayMs` | `integer ≥ 0` | `500` | Milliseconds to wait between attempts. |

```json
{
  "id": "flaky-lookup",
  "name": "get_data › retries on transient failure",
  "type": "tool-call",
  "tool": "get_data",
  "input": { "id": "abc" },
  "expect": { "success": true, "contains": "result" },
  "retry": 2,
  "retryDelayMs": 500
}
```

**Console output** shows the attempt number when retry was configured:

```
✓ get_data › retries on transient failure (passed on attempt 2/3) 512ms
✗ get_data › retries on transient failure (failed after 3 attempts) 1030ms
```

**Rules:**
- Hooks (`beforeEach`/`afterEach`) run once per test, not once per attempt.
- No delay is added after the final failed attempt.
- `retry: 6` (or higher) is rejected by the Zod schema with a clear error message before your server is started.
- Works for all test types including `streaming-tool-call`.

See [retry.md](retry.md) for the complete guide, interaction with `--bail`, and when to use retries.

---

## Parametrized Tests

A single test definition can expand into multiple independent test cases using the `parametrize` field:

```json
{
  "id": "add-cases",
  "name": "add › arithmetic cases",
  "type": "tool-call",
  "tool": "add",
  "input": { "a": 0, "b": 0 },
  "expect": { "success": true },
  "parametrize": [
    { "label": "positive numbers", "input": { "a": 3, "b": 4 }, "expect": { "contains": "7" } },
    { "label": "negative numbers", "input": { "a": -5, "b": -3 }, "expect": { "contains": "-8" } }
  ]
}
```

This expands into two tests at runtime:
- `add-cases[0]` — "add › arithmetic cases [case: positive numbers]"
- `add-cases[1]` — "add › arithmetic cases [case: negative numbers]"

### Row schema

| Field | Required | Description |
|-------|----------|-------------|
| `label` | Yes | Appended to the test name as `[case: <label>]` |
| `input` | Yes | Shallow-merged over the base `input` (row values win) |
| `expect` | No | Shallow-merged over the base `expect` (row values win) |
| `streamExpect` | No | Shallow-merged over the base `streamExpect` (row values win) |

**Rules:**
- An empty `parametrize: []` array is ignored — the original test runs once as-is (with a console warning).
- Expansion happens before any hooks run. The runner never sees parametrize fields.
- Each expanded case inherits `retry`, `retryDelayMs`, and `tags` from the parent.
- Console output includes `(N cases from M parametrized tests)` in the summary.
- `expect` and `streamExpect` blocks in rows are validated with `z.strictObject()` — typos are caught immediately.

See [parameterization.md](parameterization.md) for the complete guide including combining with retry, streaming tests, and tags.

---

### Fuzz vs. Security: which to use?

| Goal | Use |
|------|-----|
| Confirm server survives unexpected inputs without crashing | `type: "fuzz"` |
| Confirm server has no hidden malicious instructions or behaviors | `type: "security"` |
| Full coverage | Both — `checkspec scan --fuzz` runs both automatically |

> **Key difference:** A fuzz test passes as long as the server returns *any* MCP response — even `{ isError: true }` counts as pass. A security test actively probes for malicious intent and fails on suspicious findings.

See [getting-started.md](getting-started.md#fuzz-testing-vs-security-scanning) for the full explanation with examples.

---

## `expect` assertions reference

| Assertion | Types | Description |
|-----------|-------|-------------|
| `success: true` | `tool-call`, `resource-read`, `prompt-get` | Call must succeed without error |
| `success: false` | `tool-call`, `resource-read`, `prompt-get` | Call must fail (tool: `isError: true`; resource/prompt: must throw) |
| `contains: "str"` | all except `protocol`, `security` | Result text must include this substring |
| `notContains: "str"` | all except `protocol`, `security` | Result text must NOT include this substring |
| `equals: "str"` | all except `protocol`, `security` | Full result text must exactly equal this string |
| `matches: "pattern"` | all except `protocol`, `security` | Result text must match this JavaScript regex pattern |
| `jsonPath: [...]` | `tool-call`, `resource-read` | Extract a value from the JSON response and assert on it (see below) |
| `schema: {...}` | `tool-call`, `resource-read` | Text parsed as JSON and validated with Ajv |
| `executionTimeMs: N` | all except `protocol`, `security` | Response within N milliseconds |
| `maxTokens: N` | `tool-call`, `resource-read`, `prompt-get` | Response size ≤ N tokens (estimated at ~4 chars/token) |

### `jsonPath` assertions

Use `jsonPath` to extract a specific field from the tool's JSON response and assert on its value:

```json
{
  "expect": {
    "jsonPath": [
      { "path": "$.user.id", "equals": "alice-123" },
      { "path": "$.user.name", "contains": "Alice" },
      { "path": "$.user.email", "matches": "@example\\.com$" },
      { "path": "$.items[0].status", "equals": "active" }
    ]
  }
}
```

Each entry in the array is evaluated independently. All must pass for the test to pass.

| Field | Description |
|-------|-------------|
| `path` | JSONPath expression (required). Must start with `$.`. Supports dot-notation, bracket notation, and array indexing. |
| `equals` | Extracted value must exactly equal this string |
| `contains` | Extracted value must include this substring |
| `matches` | Extracted value must match this JavaScript regex pattern |

At least one of `equals`, `contains`, or `matches` must be provided.

### Test-level `capture`

Tests can capture values from their result into the context for use in later tests — just like hooks:

```json
{
  "id": "create-order",
  "name": "create_order › returns new order",
  "type": "tool-call",
  "tool": "create_order",
  "input": { "item": "widget", "qty": 2 },
  "expect": { "success": true },
  "capture": { "orderId": "$.order.id" }
},
{
  "id": "get-order",
  "name": "get_order › returns the created order",
  "type": "tool-call",
  "tool": "get_order",
  "input": { "id": "{{orderId}}" },
  "expect": { "success": true, "contains": "widget" }
}
```

`capture` runs only on passing tests. If the test fails, nothing is captured. Supports the same JSONPath syntax as hook capture, including array indexing.

### `timeoutMs` (per-test timeout)

Override the runner-level timeout for a specific test:

```json
{
  "id": "slow-export",
  "name": "export_report › completes within 30 seconds",
  "type": "tool-call",
  "tool": "export_report",
  "input": { "format": "pdf" },
  "expect": { "success": true },
  "timeoutMs": 30000
}
```

| Field | Type | Range | Default |
|-------|------|-------|---------|
| `timeoutMs` | `integer` | 100–300000 | Runner-level `timeout` option, or 30000 |

When the timeout expires, the test fails immediately with a clear message: `"Test timed out after 30000ms"`. The server process is not killed — only that specific test is cancelled.

---

## Running Collections

```bash
# Run all tests
checkspec test my-collection.checkspec.json

# Run only smoke-tagged tests
checkspec test my-collection.checkspec.json --filter smoke

# JUnit XML for CI
checkspec test my-collection.checkspec.json --output junit > results.xml

# JSON for archiving / checkspec report
checkspec test my-collection.checkspec.json --output json > results.json

# Stop on first failure
checkspec test my-collection.checkspec.json --bail

# Save JSON-RPC interaction recording
checkspec test my-collection.checkspec.json --save-recording recording.json

# Override working directory (Python uv servers)
checkspec test my-collection.checkspec.json --cwd /path/to/project
```

---

## Server Configuration Reference

The `server` block tells CheckSpec how to connect to your MCP server. Exactly one of `command` (stdio) or `url` (HTTP) must be provided.

### Stdio server (local process)

```json
{
  "server": {
    "command": "node",
    "args": ["dist/index.js"],
    "cwd": "/path/to/server",
    "env": { "NODE_ENV": "test" }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `command` | Yes (stdio) | Command to spawn the server (e.g. `"node"`, `"uv"`) |
| `args` | No | Arguments passed to the command |
| `cwd` | No | Working directory for the server process (required for Python uv projects) |
| `env` | No | Extra environment variables for the server process |

### HTTP server (remote)

```json
{
  "server": {
    "url": "https://my-mcp-server.example.com/mcp",
    "transport": "streamable-http",
    "headers": {
      "Authorization": "Bearer my-token"
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `url` | Yes (HTTP) | Full URL of the running MCP server endpoint |
| `transport` | No | `"streamable-http"` (default) or `"sse"` (legacy) |
| `headers` | No | HTTP headers sent with every request (e.g. auth tokens) |

`"streamable-http"` implements the MCP 2025-03-26 specification and is preferred. Use `"sse"` for older servers that only support Server-Sent Events. See [transports.md](transports.md) for the full guide.

---

## Python Server Collection Example

```json
{
  "version": "1.0",
  "name": "My Python MCP Server",
  "server": {
    "command": "uv",
    "args": ["run", "server.py"],
    "cwd": "/path/to/project",
    "env": { "LOG_LEVEL": "WARNING" }
  },
  "tests": [
    {
      "id": "greet-smoke",
      "name": "greet: basic smoke test",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Alice" },
      "expect": { "success": true, "contains": "Alice" },
      "tags": ["smoke"]
    },
    {
      "id": "security-greet",
      "name": "greet: no high-severity security issues",
      "type": "security",
      "tool": "greet",
      "securityThreshold": "high",
      "tags": ["security"]
    }
  ]
}
```
