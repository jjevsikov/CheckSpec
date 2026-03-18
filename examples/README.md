# Example Collections

This directory contains ready-to-run `.checkspec.json` collections that demonstrate CheckSpec features against the included demo and fixture servers. Each collection is self-contained: it declares the server command, the tests, and any hooks or assertions needed to run end-to-end.

To run any collection, build the project first, then pass the file to `checkspec test`:

```bash
npm run build
node packages/cli/dist/index.js test examples/<file>.json
```

**New to CheckSpec?** Start with `parametrize-tests.json` (calculator-server, no server state) or `hooks-tests.json` (stateful-server, full lifecycle) — both demonstrate the most common patterns in minimal code.

---

## Collection Index

### Basics

| File | Required server | What it demonstrates |
|------|----------------|----------------------|
| [`parametrize-tests.json`](parametrize-tests.json) | `demos/calculator-server` | `parametrize` — one test definition expanded into multiple cases |
| [`optional-ids-tests.json`](optional-ids-tests.json) | `demos/calculator-server` | Optional `id` field — auto-generated from test names, mixed with explicit IDs |
| [`timeout-tests.json`](timeout-tests.json) | `fixtures/buggy-server` | Per-test `timeoutMs` — slow-op times out at 500ms; fast divide passes within budget |
| [`broken-validation.json`](broken-validation.json) | _(none — intentionally invalid)_ | Zod validation errors: typos in `expect`/`streamExpect` blocks and missing required fields |

### Assertions

| File | Required server | What it demonstrates |
|------|----------------|----------------------|
| [`assertions-v2-tests.json`](assertions-v2-tests.json) | `demos/calculator-server` | `equals` (exact text), `notContains` (substring exclusion), `matches` (regex), `jsonPath` (structured field extraction) |
| [`jsonpath-tests.json`](jsonpath-tests.json) | `demos/stateful-server` | `jsonPath` in depth: dot-notation, multi-field assertions, array index access, regex matching on extracted values |
| [`streaming-tests.json`](streaming-tests.json) | `demos/streaming-server` | `streaming-tool-call` type with `streamExpect` assertions |

### Hooks

| File | Required server | What it demonstrates |
|------|----------------|----------------------|
| [`hooks-tests.json`](hooks-tests.json) | `demos/stateful-server` | `beforeAll`, `afterAll`, `beforeEach` hooks with tool-call type |
| [`hooks-shell-teardown.json`](hooks-shell-teardown.json) | `demos/stateful-server` | `afterAll` shell hook — runs a local command on teardown |
| [`context-tests.json`](context-tests.json) | `demos/stateful-server` | Hook context variables: `capture` extracts values, `{{varName}}` resolves them in later hooks and tests |
| [`capture-chain-tests.json`](capture-chain-tests.json) | `demos/stateful-server` | Test-level `capture` — extract values from one test result and use `{{varName}}` templates in subsequent tests |

### Advanced

| File | Required server | What it demonstrates |
|------|----------------|----------------------|
| [`describe-tests.json`](describe-tests.json) | `demos/stateful-server` | `describe` blocks with per-group hooks, top-level hooks, and ungrouped tests |
| [`concurrent-tests.json`](concurrent-tests.json) | `demos/calculator-server` | `concurrency` — run tests in parallel within describe blocks and top-level |
| [`retry-tests.json`](retry-tests.json) | `demos/stateful-server` | `retry` and `retryDelayMs` fields — automatic re-runs on failure |
| [`tier1-cross-feature.json`](tier1-cross-feature.json) | `demos/calculator-server` | Cross-feature: `parametrize` + `retry` together |

---

## Quick Start

```bash
# Build everything first
npm run build

# Parametrize example — 7 test cases expanded from 2 definitions
node packages/cli/dist/index.js test examples/parametrize-tests.json

# Hooks example (stateful server)
node packages/cli/dist/index.js test examples/hooks-tests.json

# Retry example
node packages/cli/dist/index.js test examples/retry-tests.json

# Streaming example
node packages/cli/dist/index.js test examples/streaming-tests.json

# Hook context variables — capture values from hooks, use in tests
node packages/cli/dist/index.js test examples/context-tests.json

# Describe blocks — group tests with per-group hooks
node packages/cli/dist/index.js test examples/describe-tests.json

# Optional IDs — auto-generated from test names
node packages/cli/dist/index.js test examples/optional-ids-tests.json

# Concurrency — run tests in parallel
node packages/cli/dist/index.js test examples/concurrent-tests.json
```

---

## Feature: Parametrized Tests

`parametrize-tests.json` shows how a single test definition expands into multiple independent cases:

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

Each row becomes its own test case with a unique id (`add-cases[0]`, `add-cases[1]`) and name (`add › arithmetic cases [case: positive numbers]`).

See [docs/parameterization.md](../docs/parameterization.md) for the full guide.

---

## Feature: Hook Context Variables

`context-tests.json` shows how a `beforeAll` hook can capture a generated ID from its response and share it with later hooks and tests via `{{varName}}` placeholders.

```json
{
  "hooks": {
    "beforeAll": [
      {
        "name": "create test user",
        "run": {
          "type": "tool-call",
          "tool": "create_user",
          "input": { "id": "ctx-alice", "name": "Alice" }
        },
        "capture": { "userId": "$.user.id" }
      }
    ],
    "afterAll": [
      {
        "name": "delete test user",
        "run": {
          "type": "tool-call",
          "tool": "delete_user",
          "input": { "id": "{{userId}}" }
        }
      }
    ]
  },
  "tests": [
    {
      "id": "get-ctx-user",
      "name": "get_user › returns the captured user",
      "type": "tool-call",
      "tool": "get_user",
      "input": { "id": "{{userId}}" },
      "expect": { "success": true, "contains": "Alice" }
    }
  ]
}
```

The `$.user.id` JSONPath expression extracts the `id` field from the `user` object in the tool-call response. The resolved value replaces every `{{userId}}` occurrence in subsequent inputs.

See [docs/hook-context.md](../docs/hook-context.md) for the full guide.

---

## Feature: Describe Blocks

`describe-tests.json` shows how to group related tests under named sections with optional per-group hooks. Each describe block can have its own `beforeAll`, `afterAll`, `beforeEach`, and `afterEach` hooks that nest inside top-level hooks.

```json
{
  "describe": [
    {
      "name": "user management",
      "hooks": {
        "beforeAll": [
          { "name": "seed alice", "run": { "type": "tool-call", "tool": "create_user", "input": { "id": "alice", "name": "Alice" } } }
        ],
        "afterAll": [
          { "name": "clean up", "run": { "type": "tool-call", "tool": "reset_store", "input": {} } }
        ]
      },
      "tests": [
        { "id": "get-alice", "name": "get_user › returns alice", "type": "tool-call", "tool": "get_user", "input": { "id": "alice" }, "expect": { "success": true, "contains": "Alice" } }
      ]
    },
    {
      "name": "store operations",
      "tests": [
        { "id": "list-empty", "name": "list_users › empty store", "type": "tool-call", "tool": "list_users", "input": {}, "expect": { "success": true } }
      ]
    }
  ],
  "tests": [
    { "id": "final", "name": "top-level test", "type": "tool-call", "tool": "list_users", "input": {}, "expect": { "success": true } }
  ]
}
```

Describe blocks run in array order, then ungrouped top-level tests run. Only single-level nesting is supported.

See [docs/describe-blocks.md](../docs/describe-blocks.md) for the full guide.

---

## Feature: Optional Test IDs

`optional-ids-tests.json` shows that the `id` field is optional. When omitted, CheckSpec auto-generates a stable, human-readable ID from the test name:

```json
{
  "tests": [
    {
      "name": "add › positive numbers",
      "type": "tool-call",
      "tool": "add",
      "input": { "a": 3, "b": 4 },
      "expect": { "success": true, "contains": "7" }
    },
    {
      "id": "explicit-multiply",
      "name": "multiply › explicit ID",
      "type": "tool-call",
      "tool": "multiply",
      "input": { "a": 6, "b": 7 },
      "expect": { "success": true, "contains": "42" }
    }
  ]
}
```

The first test receives auto-generated ID `"add-positive-numbers"`. The second keeps its explicit `"explicit-multiply"`. Explicit and auto-generated IDs can be mixed freely within the same collection.

See [docs/collection-format.md](../docs/collection-format.md#optional-test-ids) for the full reference.

---

## Feature: Concurrent Test Execution

`concurrent-tests.json` shows how to run tests in parallel using the top-level `concurrency` field. Tests within each describe block and the top-level test list run concurrently up to the specified limit.

```json
{
  "version": "1.0",
  "name": "Concurrent Tests",
  "server": { "command": "node", "args": ["dist/server.js"] },
  "concurrency": 3,
  "tests": [
    { "name": "test A", "type": "tool-call", "tool": "add", "input": { "a": 1, "b": 2 }, "expect": { "success": true } },
    { "name": "test B", "type": "tool-call", "tool": "add", "input": { "a": 3, "b": 4 }, "expect": { "success": true } },
    { "name": "test C", "type": "tool-call", "tool": "add", "input": { "a": 5, "b": 6 }, "expect": { "success": true } }
  ]
}
```

With `concurrency: 3`, up to three tests within each group run at the same time. The default is `1` (serial execution). Use concurrency only with stateless tools — tests that mutate shared server state may produce flaky results.

See [docs/collection-format.md](../docs/collection-format.md#concurrency) for the full reference.
