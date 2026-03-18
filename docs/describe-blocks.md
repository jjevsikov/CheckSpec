# Describe Blocks

Describe blocks let you group related tests under a named section with optional per-group hooks. This is useful when different groups of tests need different setup and teardown — an "auth" group can seed its own users without affecting a "billing" group that seeds invoices.

---

## Overview

A collection file can include a `describe` array alongside the usual `tests` array. Each describe block has a `name`, an optional `hooks` object (scoped to that group), and a `tests` array. Top-level hooks still apply to every test in every group.

```
collection
 ├── hooks (top-level — apply to all tests everywhere)
 ├── describe
 │    ├── { name: "auth", hooks: { beforeAll, afterAll }, tests: [...] }
 │    └── { name: "billing", hooks: { beforeAll }, tests: [...] }
 └── tests (ungrouped — run after all describe blocks)
```

Only single-level nesting is supported. You cannot place a `describe` inside another `describe`.

---

## Collection Format

```json
{
  "version": "1.0",
  "name": "My Server Tests",
  "server": { "command": "node", "args": ["dist/index.js"] },
  "hooks": {
    "beforeEach": [
      { "name": "health check", "run": { "type": "tool-call", "tool": "ping", "input": {} } }
    ],
    "afterAll": [
      { "name": "wipe store", "run": { "type": "tool-call", "tool": "reset", "input": {} } }
    ]
  },
  "describe": [
    {
      "name": "user management",
      "hooks": {
        "beforeAll": [
          { "name": "seed alice", "run": { "type": "tool-call", "tool": "create_user", "input": { "id": "alice" } } }
        ],
        "afterAll": [
          { "name": "clean up users", "run": { "type": "tool-call", "tool": "reset", "input": {} } }
        ]
      },
      "tests": [
        {
          "id": "get-alice",
          "name": "get_user > returns alice",
          "type": "tool-call",
          "tool": "get_user",
          "input": { "id": "alice" },
          "expect": { "success": true, "contains": "Alice" }
        }
      ]
    },
    {
      "name": "store operations",
      "tests": [
        {
          "id": "list-empty",
          "name": "list_users > empty store",
          "type": "tool-call",
          "tool": "list_users",
          "input": {},
          "expect": { "success": true }
        }
      ]
    }
  ],
  "tests": [
    {
      "id": "final-check",
      "name": "store > final state",
      "type": "tool-call",
      "tool": "list_users",
      "input": {},
      "expect": { "success": true }
    }
  ]
}
```

### Backwards compatibility

The `describe` field is optional. A collection with no `describe` array works exactly as before — all tests live in the top-level `tests` array with top-level hooks.

---

## Hook Execution Order

Describe-level hooks nest inside top-level hooks. The full lifecycle for a single test inside a describe block is:

```
top-level beforeAll          ← once, before anything
│
├── describe beforeAll       ← once per group, before that group's tests
│   │
│   ├── top-level beforeEach
│   ├── describe beforeEach
│   ├── ── TEST ──
│   ├── describe afterEach
│   ├── top-level afterEach
│   │
│   ├── top-level beforeEach
│   ├── describe beforeEach
│   ├── ── TEST ──
│   ├── describe afterEach
│   ├── top-level afterEach
│   │
│   └── describe afterAll    ← once per group, after that group's tests
│
├── (next describe block…)
│
├── top-level beforeEach     ← ungrouped tests get top-level hooks only
├── ── TEST ──
├── top-level afterEach
│
└── top-level afterAll       ← once, after everything
```

**Key rules:**

- **beforeEach order:** top-level runs first, then describe-level.
- **afterEach order:** describe-level runs first, then top-level.
- **Describe blocks run in array order**, one after the other.
- **Top-level tests run after all describe blocks.**
- **Teardown guarantee:** `afterAll` and `afterEach` always run (even after failures), just like top-level teardown hooks.

---

## Console Output

The `ConsoleReporter` prints a section header when entering each describe block:

```
  [setup]    seed alice for user tests               ✓ (8ms)
  [setup]    seed bob for user tests                 ✓ (4ms)

  user management ─────────────────────────────────
  [each]     verify store is reachable               ✓ (2ms)
  ✓ get_user > returns seeded alice  (5ms)
  [each]     verify store is reachable               ✓ (2ms)
  ✓ get_user > returns seeded bob  (4ms)
  [teardown] clean up user test data                 ✓ (3ms)

  store operations ────────────────────────────────
  [each]     verify store is reachable               ✓ (2ms)
  ✓ list_users > empty after previous group cleanup  (3ms)

  ✓ store > has carol from previous group (top-level test)  (4ms)
  [teardown] final cleanup — wipe store              ✓ (3ms)

Tests: 4 passed, 0 failed
Total: 52ms
```

The group name is followed by a `───` line that pads to a fixed width for visual consistency.

---

## Interaction with Other Features

### Parametrize

Parametrized tests inside describe blocks work exactly like top-level parametrized tests. Each row expands into an independent test case within that group. Expansion happens before any hooks run.

```json
{
  "name": "arithmetic",
  "tests": [
    {
      "id": "add-cases",
      "name": "add > cases",
      "type": "tool-call",
      "tool": "add",
      "input": { "a": 0, "b": 0 },
      "expect": { "success": true },
      "parametrize": [
        { "label": "positive", "input": { "a": 3, "b": 4 }, "expect": { "contains": "7" } },
        { "label": "negative", "input": { "a": -1, "b": -2 }, "expect": { "contains": "-3" } }
      ]
    }
  ]
}
```

Both expanded cases run inside the "arithmetic" group, with that group's hooks wrapping each one.

### Retry

`retry` and `retryDelayMs` work unchanged inside describe blocks. Hooks are not retried — only the test execution is wrapped by `executeWithRetry`.

### Tags

Tag filtering with `--filter` applies to tests inside describe blocks the same way it applies to top-level tests. A test that does not match the tag filter is skipped (its group hooks still run for other matching tests in the same group).

### Context variables

`HookContext` is shared across the entire collection run. Variables captured by a describe-level `beforeAll` hook are available to all tests in that group, to later groups, and to top-level tests. Variables captured by top-level hooks are available everywhere.

```json
{
  "name": "user setup",
  "hooks": {
    "beforeAll": [
      {
        "name": "create user",
        "run": { "type": "tool-call", "tool": "create_user", "input": { "name": "Alice" } },
        "capture": { "userId": "$.user.id" }
      }
    ]
  },
  "tests": [
    {
      "id": "get-user",
      "name": "get_user > returns created user",
      "type": "tool-call",
      "tool": "get_user",
      "input": { "id": "{{userId}}" },
      "expect": { "success": true }
    }
  ]
}
```

---

## Single-Level Nesting

Describe blocks do not support nesting. The `tests` array inside a describe block contains test cases only — not further describe blocks. This is enforced by the Zod schema: the `describeBlockSchema` accepts `tests` (an array of test cases) but has no `describe` field.

If you need deeper grouping, use separate describe blocks with descriptive names:

```json
"describe": [
  { "name": "auth > login", "tests": [...] },
  { "name": "auth > logout", "tests": [...] },
  { "name": "billing > invoices", "tests": [...] }
]
```

---

## Edge Cases

### Empty describe block

A describe block with `"tests": []` is valid but produces no test output. Its hooks still run (if any). This can be useful as a placeholder during development.

### Describe block with only hooks

A describe block can define `hooks` but have an empty `tests` array. The `beforeAll` and `afterAll` hooks will run (useful for side effects like seeding a shared database), but no tests execute within the group.

### Describe-level `beforeAll` failure

If a describe-level `beforeAll` hook fails (and `failFast` is true, which is the default for setup hooks), all tests in that group are skipped. The group's `afterAll` still runs (teardown guarantee). Other describe blocks and top-level tests continue to execute normally — a single group's setup failure does not abort the entire suite.

```
describe "auth" beforeAll → fails
  → all "auth" tests skipped
  → "auth" afterAll runs (teardown)
describe "billing" beforeAll → runs normally
  → "billing" tests execute
top-level tests → execute
top-level afterAll → runs
```

### Top-level `beforeAll` failure

If a top-level `beforeAll` hook fails, all tests everywhere are skipped — both describe block tests and top-level tests. The top-level `afterAll` still runs.

---

## Full Working Example

See [`examples/describe-tests.json`](../examples/describe-tests.json) — runs against the stateful-server demo:

```bash
npm run build
node packages/cli/dist/index.js test examples/describe-tests.json
```

The example demonstrates:
- Two describe blocks ("user management" and "store operations")
- Per-group `beforeAll`/`afterAll` hooks in the first group
- A group with no hooks (second group)
- Top-level `beforeEach` and `afterAll` hooks that apply to all tests
- A top-level test that runs after all describe blocks

---

## Schema Reference

The describe block schema validates the following structure:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **yes** | Group name displayed as a section header in reporters |
| `hooks` | TestHooks | no | Per-group hooks (`beforeAll`, `afterAll`, `beforeEach`, `afterEach`) |
| `tests` | TestCase[] | **yes** | Array of test cases (same schema as top-level tests) |

The `hooks` object inside a describe block uses the same schema as the top-level `hooks` — all hook features (tool-call, shell, capture, failFast, timeoutMs) work identically.
