# Hook Context Variables

Hook context variables let hooks share data with later hooks and tests. A `beforeAll` hook can create a resource, capture its generated ID, and every subsequent hook and test can reference that ID via a `{{varName}}` placeholder — without hardcoding it in the collection file.

---

## Overview

The flow is two steps:

1. **Capture** — a hook extracts a value from its tool-call response using a JSONPath expression and stores it under a named key.
2. **Resolve** — later hooks and tests write `{{keyName}}` anywhere in their `input` or `expect.contains` fields and CheckSpec substitutes the stored value before executing.

```
beforeAll hook: create_user { name: "Alice" }
  └─ response: { "user": { "id": "u-9f3a", "name": "Alice" } }
  └─ capture:  userId = $.user.id   →  stores "u-9f3a"

test: get_user { id: "{{userId}}" }
  └─ resolved: get_user { id: "u-9f3a" }
```

---

## Two Sources of Captures

Context variables can be set from two places:

1. **Hook-level capture** — a `beforeAll`, `beforeEach`, or `afterAll` hook extracts a value after its tool call.
2. **Test-level capture** — a test case extracts a value from its own result after passing.

Both use the same `capture` field, the same JSONPath syntax, and the same `{{varName}}` reference syntax. Variables from either source flow into all subsequent hooks and tests in execution order.

---

## Fields

### `capture` on a hook definition

```json
{
  "name": "create test user",
  "run": {
    "type": "tool-call",
    "tool": "create_user",
    "input": { "name": "Alice" }
  },
  "capture": {
    "userId": "$.user.id",
    "userName": "$.user.name"
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `capture` | `Record<string, string>` | Optional. Map of variable name → JSONPath expression. Runs after the tool call completes. |

`capture` is only valid on `tool-call` hooks — it has no effect on `shell` hooks.

### JSONPath expressions

CheckSpec supports a dot-notation and bracket-notation subset:

| Expression | Extracts |
|------------|---------|
| `$.field` | Top-level field |
| `$.field.nested` | Nested field |
| `$.a.b.c` | Arbitrarily deep |
| `$.items[0]` | First element of an array |
| `$.items[-1]` | Last element (negative index counts from end) |
| `$.data.users[2].name` | Mixed dot and bracket notation |
| `$.matrix[0][1]` | Consecutive brackets (nested arrays) |

The path must start with `$.`. If the path is missing, the value is `null`, the index is out of bounds, or bracket notation is used on a non-array, the variable is not set (no error).

If the extracted value is a primitive (string, number, boolean), it is stored as a string. If it is an object or array, it is stored as a compact JSON string.

**Array indexing examples:**

```json
{
  "capture": {
    "firstUserId":  "$.users[0].id",
    "lastItem":     "$.items[-1]",
    "thirdName":    "$.data.users[2].name"
  }
}
```

Negative indices count from the end: `[-1]` is the last element, `[-2]` is second-to-last, and so on. An out-of-bounds index (positive or negative) leaves the variable unset.

### `capture` on a test case

Tests can also capture values from their result and pass them to later tests — without needing a hook in between:

```json
{
  "id": "create-order",
  "name": "create_order › returns new order",
  "type": "tool-call",
  "tool": "create_order",
  "input": { "item": "widget", "qty": 2 },
  "expect": { "success": true },
  "capture": { "orderId": "$.order.id", "createdAt": "$.order.created_at" }
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

**Behaviour rules:**
- Test-level capture only runs when the test **passes**. If the test fails, nothing is captured.
- Applies to `tool-call`, `resource-read`, and `prompt-get` test types.
- Variables captured by a test are available to all subsequent tests and hooks in the same collection run.
- The same JSONPath syntax applies, including array indexing.

### `{{varName}}` in inputs and expect

Use `{{keyName}}` anywhere in a hook's `run.input`, a test's `input`, or a test's `expect.contains` string:

```json
{
  "id": "get-user",
  "name": "get_user › fetches the created user",
  "type": "tool-call",
  "tool": "get_user",
  "input": { "id": "{{userId}}" },
  "expect": {
    "success": true,
    "contains": "{{userName}}"
  }
}
```

Placeholders are resolved recursively through nested objects and arrays. An unrecognised key (no matching variable set) is left as the literal `{{keyName}}` string.

---

## Execution Order

Context variables are populated in hook execution order. Variables set by earlier hooks are available to:

- All later hooks in the same phase (e.g., a second `beforeAll` hook)
- All hooks in subsequent phases (`beforeEach`, `afterEach`, `afterAll`)
- All test cases

```
beforeAll[0]:  capture → userId = "u-9f3a"
beforeAll[1]:  input can use {{userId}}       ← ✓ available
beforeEach[0]: input can use {{userId}}       ← ✓ available
test:          input can use {{userId}}       ← ✓ available
afterEach[0]:  input can use {{userId}}       ← ✓ available
afterAll[0]:   input can use {{userId}}       ← ✓ available
```

Variables captured in `beforeEach` are available within that test's `afterEach` but may be overwritten on the next iteration (since `beforeEach` runs fresh for each test).

---

## Full Example

```json
{
  "version": "1.0",
  "name": "User CRUD — context variable demo",
  "server": {
    "command": "node",
    "args": ["dist/index.js"],
    "cwd": "/path/to/my-server"
  },
  "hooks": {
    "beforeAll": [
      {
        "name": "create test user",
        "run": {
          "type": "tool-call",
          "tool": "create_user",
          "input": { "name": "Alice", "email": "alice@example.com" }
        },
        "capture": {
          "userId":    "$.user.id",
          "userEmail": "$.user.email"
        }
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
      "id": "get-user",
      "name": "get_user › returns the created user",
      "type": "tool-call",
      "tool": "get_user",
      "input": { "id": "{{userId}}" },
      "expect": {
        "success": true,
        "contains": "{{userEmail}}"
      }
    },
    {
      "id": "update-user",
      "name": "update_user › can update name",
      "type": "tool-call",
      "tool": "update_user",
      "input": { "id": "{{userId}}", "name": "Alice Updated" },
      "expect": { "success": true }
    }
  ]
}
```

A working example against the stateful-server demo is in [`examples/context-tests.json`](../examples/context-tests.json).

---

## Multi-Step Workflow Example

This example shows a full create → use → update → verify chain where each step captures a value used by the next step. Hook capture seeds the user; test-level capture chains the results.

```json
{
  "version": "1.0",
  "name": "Order workflow — multi-step context chain",
  "server": {
    "command": "node",
    "args": ["dist/index.js"],
    "cwd": "/path/to/my-server"
  },
  "hooks": {
    "beforeAll": [
      {
        "name": "create test customer",
        "run": {
          "type": "tool-call",
          "tool": "create_customer",
          "input": { "name": "Alice", "email": "alice@example.com" }
        },
        "capture": {
          "customerId": "$.customer.id",
          "customerEmail": "$.customer.email"
        }
      }
    ],
    "afterAll": [
      {
        "name": "delete test customer",
        "run": {
          "type": "tool-call",
          "tool": "delete_customer",
          "input": { "id": "{{customerId}}" }
        }
      }
    ]
  },
  "tests": [
    {
      "id": "create-order",
      "name": "create_order › places order for customer",
      "type": "tool-call",
      "tool": "create_order",
      "input": { "customerId": "{{customerId}}", "item": "widget", "qty": 3 },
      "expect": { "success": true },
      "capture": {
        "orderId": "$.order.id",
        "orderStatus": "$.order.status"
      }
    },
    {
      "id": "verify-order",
      "name": "get_order › new order is pending",
      "type": "tool-call",
      "tool": "get_order",
      "input": { "id": "{{orderId}}" },
      "expect": {
        "success": true,
        "contains": "{{customerId}}",
        "jsonPath": [
          { "path": "$.status", "equals": "pending" },
          { "path": "$.items[0].name", "equals": "widget" }
        ]
      },
      "capture": {
        "firstItemId": "$.items[0].id"
      }
    },
    {
      "id": "ship-item",
      "name": "ship_item › marks first item as shipped",
      "type": "tool-call",
      "tool": "ship_item",
      "input": { "orderId": "{{orderId}}", "itemId": "{{firstItemId}}" },
      "expect": { "success": true }
    },
    {
      "id": "verify-shipped",
      "name": "get_order › order now has a shipped item",
      "type": "tool-call",
      "tool": "get_order",
      "input": { "id": "{{orderId}}" },
      "expect": {
        "success": true,
        "jsonPath": [
          { "path": "$.items[0].status", "equals": "shipped" }
        ]
      }
    }
  ]
}
```

**Execution order and variable availability:**

```
beforeAll[0]:  create_customer  →  captures customerId, customerEmail
test[0]:       create_order (uses {{customerId}})  →  captures orderId, orderStatus
test[1]:       get_order (uses {{orderId}}, {{customerId}})  →  captures firstItemId
test[2]:       ship_item (uses {{orderId}}, {{firstItemId}})
test[3]:       get_order (uses {{orderId}})
afterAll[0]:   delete_customer (uses {{customerId}})
```

---

## Running the Example

```bash
# Build everything first
npm run build

# Run the context variable demo
node packages/cli/dist/index.js test examples/context-tests.json
```

---

## Behaviour Details

### Unset variables

If a `{{varName}}` placeholder references a key that was never captured (e.g., due to a failed hook or a bad JSONPath), the placeholder is left in the string as-is. The test will still run — with the literal text `{{varName}}` as the input value — and will likely fail on its own assertions.

### Variables are strings only

All captured values are stored as strings. Numbers, booleans, and objects are coerced:

| JSON value | Stored as |
|-----------|-----------|
| `"alice-123"` | `"alice-123"` |
| `42` | `"42"` |
| `true` | `"true"` |
| `{ "a": 1 }` | `"{\"a\":1}"` |

### Circular reference guard

The resolver detects object cycles and leaves circular references unresolved rather than throwing or looping forever.

### Only `tool-call` hooks can capture

`shell` hooks do not produce structured output that can be parsed. The `capture` field is silently ignored on shell hooks.

---

## When to Use Context Variables

| Scenario | Pattern |
|----------|---------|
| Create a resource in `beforeAll`, reference its ID in tests | Hook `capture: { id: "$.id" }` → test `input: { id: "{{id}}" }` |
| Create a resource in `beforeAll`, clean it up in `afterAll` | Capture in `beforeAll`, use `{{id}}` in `afterAll` delete hook |
| Seed data per-test in `beforeEach` | Capture in `beforeEach`, use `{{id}}` in test and `afterEach` |
| Assert the created resource's field in `contains` | `expect: { contains: "{{email}}" }` |
| Chain test outputs (test A creates, test B uses) | Test-level `capture: { id: "$.id" }` on test A → `input: { id: "{{id}}" }` on test B |
| Multi-step workflow (create → verify → update → verify) | Test-level capture at each step, array indexing for list results |

---

## Programmatic API

`HookContext` is exported from `@checkspec/core` for use in custom runners:

```typescript
import { HookContext } from "@checkspec/core";

const ctx = new HookContext();

// Store a value
ctx.set("userId", "alice-123");

// Check if a key exists
ctx.has("userId"); // true

// Resolve {{varName}} placeholders in any value (recursive)
ctx.resolve({ id: "{{userId}}", nested: { name: "{{missing}}" } });
// → { id: "alice-123", nested: { name: "{{missing}}" } }

// Extract a value from a JSON response using JSONPath dot notation
HookContext.extractValue({ user: { id: "alice-123" } }, "$.user.id");
// → "alice-123"

// Array indexing: zero-based positive indices
HookContext.extractValue({ users: [{ id: "a" }, { id: "b" }] }, "$.users[0].id");
// → "a"

// Negative indices count from the end
HookContext.extractValue({ items: ["x", "y", "z"] }, "$.items[-1]");
// → "z"
```

See [api-reference.md](api-reference.md) for the full `HookContext` API.
