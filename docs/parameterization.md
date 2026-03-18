# Parametrized Tests

Parametrized tests let you write one test definition and expand it into multiple cases — each with its own inputs, expected outputs, and label. This is useful for data-driven testing where the same logic applies across many input/output pairs.

---

## Basic Example

```json
{
  "id": "add-cases",
  "name": "add › arithmetic cases",
  "type": "tool-call",
  "tool": "add",
  "input": { "a": 0, "b": 0 },
  "expect": { "success": true },
  "parametrize": [
    {
      "label": "positive numbers",
      "input": { "a": 3, "b": 4 },
      "expect": { "contains": "7" }
    },
    {
      "label": "negative numbers",
      "input": { "a": -5, "b": -3 },
      "expect": { "contains": "-8" }
    },
    {
      "label": "zero identity",
      "input": { "a": 42, "b": 0 },
      "expect": { "contains": "42" }
    }
  ]
}
```

This single definition expands into three independent test cases before any hooks run.

---

## How Expansion Works

Each row in the `parametrize` array produces one test case. The following fields are derived per row:

| Field | Expansion rule |
|-------|---------------|
| `id` | `"${original.id}[${index}]"` — e.g. `"add-cases[0]"`, `"add-cases[1]"` |
| `name` | `"${original.name} [case: ${row.label}]"` |
| `input` | `{ ...base.input, ...row.input }` — row wins on key conflict |
| `expect` | `{ ...base.expect, ...row.expect }` — shallow merge; only when row provides `expect` |
| `streamExpect` | `{ ...base.streamExpect, ...row.streamExpect }` — shallow merge; only when row provides it |
| All other fields | Inherited unchanged (`retry`, `retryDelayMs`, `tags`, `type`, `tool`, …) |

The `parametrize` key itself is not included in expanded tests.

### Input merge example

If the base test has `"input": { "a": 1, "b": 2 }` and a row has `"input": { "b": 99 }`, the expanded test gets `{ "a": 1, "b": 99 }`. The row value wins on the conflicting key `b`.

### Expect merge example

If the base test has `"expect": { "success": true }` and a row has `"expect": { "contains": "bar" }`, the expanded test gets `{ "success": true, "contains": "bar" }`. Fields not listed in the row are inherited from the base.

---

## Row Schema

Each entry in `parametrize` must be an object with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | string (non-empty) | **yes** | Appended to the test name as `[case: <label>]`. Must not be empty. |
| `input` | object | **yes** | Merged over the base `input` (row wins on conflict). |
| `expect` | partial expect object | no | Shallow-merged over base `expect`. Unknown keys are rejected. |
| `streamExpect` | partial streamExpect object | no | Shallow-merged over base `streamExpect`. Unknown keys are rejected. |

Unknown keys in `expect` and `streamExpect` rows are rejected at collection load time (same as the top-level blocks), catching typos like `"sucess"` before any server starts.

---

## Empty Arrays

A test with `"parametrize": []` is **dropped with a warning** and excluded from the suite:

```
warn: test "add › arithmetic cases" has empty parametrize array, skipping
```

This is useful during development — you can leave an empty `parametrize` array as a placeholder without breaking the suite.

---

## Reporter Output

### Test lines

Each expanded case appears as its own line in the output:

```
✓ add › arithmetic cases [case: positive numbers]  (4ms)
✓ add › arithmetic cases [case: negative numbers]  (3ms)
✗ add › arithmetic cases [case: zero identity]  (2ms)
    Expected result to contain "42"
```

### Summary line

When at least one parametrized test exists, the summary notes the expansion:

```
Tests: 2 passed, 1 failed (3 cases from 1 parametrized test)
```

With multiple parametrized source definitions:

```
Tests: 6 passed, 1 failed (7 cases from 2 parametrized tests)
```

---

## Combining with Other Features

### Retry

`retry` is inherited by all expanded cases unchanged:

```json
{
  "id": "flaky-cases",
  "type": "tool-call",
  "tool": "get_data",
  "retry": 2,
  "parametrize": [
    { "label": "case A", "input": { "id": "a" } },
    { "label": "case B", "input": { "id": "b" } }
  ]
}
```

Both expanded cases will retry up to 2 times on failure.

### Tags

`tags` are inherited by all expanded cases:

```json
{
  "id": "tagged-cases",
  "tags": ["smoke"],
  "parametrize": [...]
}
```

Run only the smoke cases: `checkspec test collection.json --filter smoke`

### Streaming tests

`parametrize` works on `streaming-tool-call` tests too. Use `streamExpect` rows to override streaming assertions per case:

```json
{
  "id": "stream-cases",
  "type": "streaming-tool-call",
  "tool": "stream_data",
  "input": {},
  "streamExpect": { "minChunks": 2 },
  "parametrize": [
    {
      "label": "simple query",
      "input": { "q": "hello" }
    },
    {
      "label": "complex query needs more chunks",
      "input": { "q": "explain everything" },
      "streamExpect": { "minChunks": 5 }
    }
  ]
}
```

---

## Full Working Example

See [`examples/parametrize-tests.json`](../examples/parametrize-tests.json) — runs against `demos/calculator-server`:

```bash
npm run build
node packages/cli/dist/index.js test examples/parametrize-tests.json
```

Expected output:

```
✓ add › arithmetic cases [case: positive numbers]  (4ms)
✓ add › arithmetic cases [case: negative numbers]  (3ms)
✓ add › arithmetic cases [case: zero identity]  (3ms)
✓ add › arithmetic cases [case: large numbers]  (2ms)
✓ divide › success and error cases [case: whole number result]  (3ms)
✓ divide › success and error cases [case: decimal result]  (3ms)
✓ divide › success and error cases [case: divide by zero returns error]  (2ms)

Tests: 7 passed, 0 failed (7 cases from 2 parametrized tests)
Total: 22ms
```

---

## Validation Errors

### Empty label

```
Validation error: label must not be empty at "tests[0].parametrize[1].label"
```

Fix: provide a non-empty string for every row's `label`.

### Unknown key in row expect

```
Validation error: Unrecognized key(s) in object: 'sucess' at "tests[0].parametrize[0].expect"
```

Fix: correct the typo (`sucess` → `success`).

### retry out of range

```
Validation error: Number must be less than or equal to 5 at "tests[0].retry"
```

This applies to the base test's `retry` field and is caught before expansion.
