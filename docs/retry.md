# Retry Logic

CheckSpec can automatically re-run a failing test a configurable number of times before marking it as failed. This is useful for tests that exercise non-deterministic or occasionally-flaky tools — network-backed services, external APIs, or servers with cold-start latency.

---

## Fields

Both `TestCase` and `StreamingTestCase` accept two optional retry fields:

| Field | Type | Default | Constraint | Description |
|-------|------|---------|------------|-------------|
| `retry` | `integer` | `0` | `0–5` | How many extra attempts to make after the first failure. `0` means no retry (single attempt). |
| `retryDelayMs` | `integer` | `500` | `≥ 0` | Milliseconds to wait between attempts. Set to `0` for instant retries. |

> **Zod-guarded:** The collection schema rejects `retry` values above `5` with a human-readable error (`"Number must be less than or equal to 5 at tests[0].retry"`) before any server is spawned.

---

## How It Works

When `retry > 0`, `TestRunner.executeWithRetry()` wraps the single-test execution:

```
attempt 1           → pass?  → return result immediately (no retry annotations)
                    → fail?  → sleep(retryDelayMs) → attempt 2
attempt 2           → pass?  → return with retryCount: 1, retryExhausted: false
                    → fail?  → sleep(retryDelayMs) → attempt 3
...
attempt (1+retry)   → pass?  → return with retryCount: N, retryExhausted: false
                    → fail?  → return with retryCount: retry, retryExhausted: true
```

**Key semantics:**

- **Hooks are not retried.** `beforeEach`/`afterEach` run once per test, not once per attempt.
- **Only assertion failures trigger retry.** Transport-level exceptions (MCP protocol errors, disconnections) propagate immediately.
- **No delay after the final attempt.** `sleep()` is only called between attempts, never after the last one.
- **Annotations are only added when retries were actually consumed.** A first-attempt pass with `retry: 2` configured returns no `retryCount` field.

---

## Console Output

The `ConsoleReporter` annotates results when retry was configured:

| Outcome | Console output |
|---------|---------------|
| Pass on attempt 1 (retry configured) | `✓ my_tool › description (passed on attempt 1/3) 8ms` |
| Pass on attempt 2 of 3 | `✓ my_tool › description (passed on attempt 2/3) 203ms` |
| All attempts exhausted | `✗ my_tool › description (failed after 3 attempts) 1210ms` |
| No retry configured (default) | `✓ my_tool › description (8ms)` |

The `N/M` format uses attempt number / max attempts. `max attempts = 1 + retry`.

---

## Example

```json
{
  "version": "1.0",
  "name": "Retry Demo",
  "server": { "command": "node", "args": ["dist/index.js"] },
  "tests": [
    {
      "id": "flaky-tool",
      "name": "get_data › retries up to 3 times on transient failure",
      "type": "tool-call",
      "tool": "get_data",
      "input": { "id": "abc" },
      "expect": { "success": true, "contains": "result" },
      "retry": 2,
      "retryDelayMs": 500
    },
    {
      "id": "fast-retry",
      "name": "status › instant retry for speed",
      "type": "tool-call",
      "tool": "status",
      "input": {},
      "expect": { "contains": "ok" },
      "retry": 1,
      "retryDelayMs": 0
    }
  ]
}
```

A working copy of this is in `examples/retry-tests.json`.

---

## Interaction with `--bail`

When `--bail` is used, the suite stops after the first test that is ultimately marked as **failed**. A test with `retry: 2` exhausts all three attempts before bail triggers — it does not bail after the first attempt.

```
retry: 2, bail: true, all attempts fail:
  attempt 1 → fail → sleep
  attempt 2 → fail → sleep
  attempt 3 → fail → retryExhausted: true → suite bails
```

A test that passes on a retry attempt is treated as passed and bail does not trigger.

---

## `TestResult` Fields

When retry was configured, two additional fields appear on the result:

```typescript
interface TestResult {
  // ... standard fields ...
  retryCount?: number;      // number of retry attempts consumed (only when retry > 0 used)
  retryExhausted?: boolean; // true when all configured retries were consumed and test still failed
}
```

| Scenario | `retryCount` | `retryExhausted` |
|----------|-------------|-----------------|
| `retry: 0` (default) | `undefined` | `undefined` |
| `retry: 2`, passes on attempt 1 | `undefined` | `undefined` |
| `retry: 2`, passes on attempt 2 | `1` | `false` |
| `retry: 2`, passes on attempt 3 | `2` | `false` |
| `retry: 2`, fails all 3 attempts | `2` | `true` |

---

## Streaming Tests

Retry works identically for `streaming-tool-call` tests. Add `retry` and `retryDelayMs` directly to the streaming test case:

```json
{
  "id": "stream-retry",
  "name": "stream_data › retries if chunks are missing",
  "type": "streaming-tool-call",
  "tool": "stream_data",
  "input": { "query": "example" },
  "streamExpect": {
    "minChunks": 3,
    "finalContains": "done"
  },
  "retry": 1,
  "retryDelayMs": 1000
}
```

---

## When to Use Retry

| Use case | Recommended config |
|----------|--------------------|
| External HTTP API that occasionally times out | `retry: 2, retryDelayMs: 1000` |
| Server with cold-start latency on first call | `retry: 1, retryDelayMs: 2000` |
| Non-deterministic AI tool output | `retry: 3, retryDelayMs: 500` |
| Stable, deterministic server tools | `retry: 0` (default — no retry) |

> **Tip:** Keep `retry` small (1–2). High retry counts mask real bugs and slow down CI. If a tool fails consistently, it is a bug — not a flake — and retrying it obscures the failure.
