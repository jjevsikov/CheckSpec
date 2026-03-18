# Changelog

## [0.2.0] - 2026-03-18

### Added
- **Richer assertions**: `equals`, `notContains`, `matches`, and `jsonPath` in the `expect` block
- **Test-level capture**: `capture` field on tests — chain outputs between tests via `{{varName}}`
- **Enhanced JSONPath**: array indexing (`$.users[0].id`, `$.items[-1]`) in all capture expressions
- **jsonPath object shorthand**: `"jsonPath": { "$.id": "abc" }` as an alternative to the array form
- **Per-test timeout**: `timeoutMs` field cancels hanging tool calls automatically
- **StreamableHTTP transport**: test remote MCP servers with `server.url`
- **Legacy SSE transport**: `server.transport: "sse"` for servers not yet on StreamableHTTP
- **Watch mode**: `checkspec test --watch` re-runs on file changes
- **Capture-aware concurrency**: TestRunner schedules parallel tests respecting capture dependencies between them
- **`expect.success` on security tests**: security test type now supports `expect.success` and scan-all mode
- **Capture on streaming tests**: `capture` field now works on `streaming-tool-call` tests
- **Optional `tests` array**: top-level `tests` can be omitted (defaults to empty) when using only `describe` blocks
- New example collections: assertions-v2, capture-chain, timeout, jsonpath
- HTTP fixture server for transport integration testing

### Fixed
- `expect.success` now correctly enforced for `resource-read` and `prompt-get` tests
- **StreamableHTTP disconnect**: call `terminateSession` on HTTP transport disconnect to avoid dangling sessions
- **Lorem Ipsum in generated collections**: `checkspec init` no longer produces placeholder text from json-schema-faker — post-processing strips it from arrays and nested objects
- **Security false positives**: structured JSON echo responses no longer flagged as prompt-injection passthrough
- **Rug-pull digit normalization**: tightened numeric normalization so trivially different numbers don't trigger false rug-pull findings
- **Buried injection detection**: security scanner now detects hidden directives buried deep in long tool descriptions
- **Diamond capture dependencies**: correct layer assignment when multiple tests depend on overlapping captured variables

### Changed
- Server config accepts `url`, `transport`, and `headers` fields alongside existing stdio config
- CLI commands (scan, init, diff, inspect) accept `--url`, `--transport`, `--header` flags
