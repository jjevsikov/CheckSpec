# Streaming Tests

## What streaming tests are for

Many real MCP tools don't return a single instant result — they stream progress while working: a slow database query emitting row counts, an LLM-backed tool streaming generated text, a file processor reporting chunks as they're encoded. Standard `tool-call` tests only assert on the final result; they can't tell you whether progress notifications arrived at all, what they contained, or whether the server stalled mid-stream.

Streaming tests (`type: "streaming-tool-call"`) run the tool, collect every `notifications/progress` notification, and let you assert on the stream itself alongside the final result.

---

## The `streamExpect` fields

```json
"streamExpect": {
  "minChunks": 5,
  "chunkContains": "row",
  "maxChunkIntervalMs": 500,
  "finalContains": "done",
  "maxTotalMs": 3000
}
```

| Field | What it asserts |
|---|---|
| `minChunks` | At least N progress notifications must arrive before the final result |
| `chunkContains` | Every chunk's `message` field must contain this substring |
| `maxChunkIntervalMs` | Maximum allowed gap between consecutive chunks — catches stalls and backpressure failures |
| `finalContains` | The final tool result (assembled text content) must contain this substring |
| `maxTotalMs` | Total stream duration (first call → final result) must be under this many milliseconds |

All fields are optional. Omit any you don't need.

---

## How to run streaming tests

```bash
# Build the demo server first
cd demos/streaming-server && npm run build && cd ../..

# Run the example collection
checkspec test examples/streaming-tests.json

# Or run the demo collection directly (same tests, located alongside the server)
checkspec test demos/streaming-server/streaming.checkspec.json
```

Expected output (approximate):
```
✓ stream_countdown › counts from 5 to 0              (chunks: 5,  1247ms)
✓ stream_countdown › chunk messages are numeric strings (chunks: 3,  752ms)
✓ stream_countdown › chunks arrive within 500ms of each other (chunks: 4, 1004ms)
✓ stream_text_chunks › chunks "hello world"          (chunks: 3,  412ms)
✓ stream_text_chunks › each chunk contains expected text fragments (chunks: 3, 412ms)
✓ stream_slow_query › fetches 3 rows                 (chunks: 3,  1105ms)
✓ stream_slow_query › progress messages mention 'fetching row' (chunks: 2, 706ms)
✓ stream_slow_query › row fetches arrive within 600ms of each other (chunks: 3, 1105ms)
✗ stream_countdown › deliberately failing (minChunks not met: got 5, expected 999)
     Expected at least 999 chunk(s) but got 5

Tests: 8 passed, 1 failed
```

---

## Which MCP servers produce streaming output

Streaming is most useful for tools that perform long-running work:

- **LLM-backed tools** — tools that call an AI model and stream generated tokens back to the client
- **Database query tools** — slow queries that emit row-fetched progress
- **File processing tools** — tools that encode, compress, or transform files chunk by chunk
- **Search tools** — tools that emit results as they arrive rather than buffering everything
- **Aggregation tools** — tools that fan out to multiple APIs and stream each sub-result

If a tool takes more than ~500ms and has meaningful intermediate state, streaming progress notifications dramatically improve the user experience for any LLM agent consuming that tool.

---

## Writing a streaming test

```json
{
  "id": "my-stream-test",
  "name": "my_tool › streams at least 3 chunks",
  "type": "streaming-tool-call",
  "tool": "my_tool",
  "input": { "query": "example" },
  "streamExpect": {
    "minChunks": 3,
    "chunkContains": "progress",
    "maxChunkIntervalMs": 1000,
    "finalContains": "complete",
    "maxTotalMs": 5000
  },
  "tags": ["streaming", "my_tool"]
}
```

The test passes only if **all** specified `streamExpect` assertions hold. Assertions are evaluated in order: `minChunks` first, then `chunkContains`, then `maxChunkIntervalMs`, then `finalContains`, then `maxTotalMs`. The first failure stops evaluation and reports the specific assertion that failed.
