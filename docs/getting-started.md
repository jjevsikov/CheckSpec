# Getting Started with CheckSpec

CheckSpec is **pytest for MCP** — a testing and QA platform for Model Context Protocol servers. It auto-generates tests from tool schemas, runs conformance and fuzz checks, performs security scans, and produces CI-friendly reports.

## Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0

## Installation

```bash
# Clone the repository
git clone https://github.com/jjevsikov/CheckSpec
cd CheckSpec

# Install all dependencies
npm install

# Build all packages
npm run build
```

## Make `checkspec` available on your PATH

After building, link the CLI globally so the `checkspec` command works anywhere in your terminal:

```bash
npm link --workspace=@checkspec/cli
```

This registers `checkspec` as a global command backed by your local build. You only need to do this once (or after reinstalling Node).

### Permission error? (common on macOS with system Node)

If you see `EACCES: permission denied`, your npm prefix is owned by root. Fix it permanently by redirecting npm to a user-writable directory:

```bash
# 1. Switch npm to a user-owned prefix
npm config set prefix ~/.npm-global

# 2. Add it to your PATH — append this line to ~/.zshrc (or ~/.bashrc)
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc

# 3. Reload your shell
source ~/.zshrc

# 4. Now link works without sudo
npm link --workspace=@checkspec/cli

# 5. Verify
checkspec --version
```

> **Alternative — no PATH changes:** use `node packages/cli/dist/index.js` in place of `checkspec` for all commands. All examples work either way.

---

## Testing Your Own MCP Server

### Quick start: scaffold a test collection

The fastest way to get started is `checkspec init` — it connects to your server, discovers all tools/resources/prompts, and writes a starter `.checkspec.json` with one test per capability. No API key needed.

```bash
# Scaffold a collection from a live server
checkspec init "node /path/to/your-server/dist/index.js"

# Customize the output path and name
checkspec init "node dist/index.js" --out my-tests.checkspec.json --name "My Server"

# Python servers
checkspec init "uv run server.py" --cwd /path/to/project

# Run the generated tests
checkspec test my-server.checkspec.json
```

The generated file includes basic `expect: { success: true }` assertions for most tests — though tools that take ID-like arguments may omit `success: true` since the generated ID won't match real data. For prompt args with enum constraints, `init` probes the server to discover valid values. Edit the collection to add `contains`, `schema`, and other assertions for your specific use case. The file also includes a `$schema` field for **editor autocomplete** — VS Code and JetBrains will provide IntelliSense, hover docs, and inline validation as you edit the file.

> **Want smarter tests?** Use `checkspec generate "node dist/index.js"` instead — it uses Claude AI to write semantically rich assertions (requires an Anthropic API key).

### TypeScript / Node.js servers

```bash
# Scan — auto-discovers tools, resources, and prompts, then runs tests
checkspec scan "node /path/to/your-server/dist/index.js"

# With security scan + full fuzz depth (all 17 edge cases per string field)
checkspec scan "node /path/to/your-server/dist/index.js" --fuzz

# Save the generated collection for CI re-use
checkspec scan "node /path/to/your-server/dist/index.js" --save my-server.checkspec.json

# Run the saved collection at any time
checkspec test my-server.checkspec.json
```

### Python / FastMCP servers

```bash
# Using uv (recommended) — --cwd ensures uv finds the right virtual environment
checkspec scan "uv run server.py" --cwd /path/to/project

# Using the inline uv --directory form (no --cwd needed)
checkspec scan "uv --directory /path/to/project run server.py"

# Run a saved collection against the Python server
checkspec test my-server.checkspec.json --cwd /path/to/project

# With security scan and full fuzz
checkspec scan "uv run server.py" --cwd /path/to/project --fuzz
```

See [python-servers.md](python-servers.md) for the full Python guide including environment variables, CI setup, and common errors.

### Inspect what a server advertises

Before writing tests, explore the server's full capability listing:

```bash
checkspec inspect "node dist/index.js"
# or
checkspec inspect "uv run server.py" --cwd /path/to/project
```

Output shows all tools (with their input schemas), resources, and prompts in a formatted table.

---

## Testing a Remote Server

CheckSpec can connect directly to a running MCP server over HTTP — no need to spawn a local process. This is useful for testing deployed servers (staging, production) or long-running local services.

### Scan a remote server

```bash
# Scan a server running on localhost
checkspec scan --url http://localhost:3001/mcp

# Scan a deployed server
checkspec scan --url https://my-mcp-server.example.com/mcp

# With an Authorization header (bearer token)
checkspec scan --url https://my-mcp-server.example.com/mcp \
  --header "Authorization: Bearer my-api-token"
```

### Write a collection for a remote server

Instead of a `command` + `args`, use the `url` field in your server config:

```json
{
  "$schema": "https://raw.githubusercontent.com/jjevsikov/CheckSpec/main/packages/core/checkspec.schema.json",
  "version": "1.0",
  "name": "Production Server Tests",
  "server": {
    "url": "https://my-mcp-server.example.com/mcp",
    "headers": {
      "Authorization": "Bearer my-api-token"
    }
  },
  "tests": [
    {
      "name": "smoke test",
      "type": "protocol"
    },
    {
      "name": "list_items: returns results",
      "type": "tool-call",
      "tool": "list_items",
      "input": {},
      "expect": { "success": true }
    }
  ]
}
```

Run it with the same `checkspec test` command:

```bash
checkspec test production-tests.checkspec.json
```

### Transport options

| Config | Transport used |
|--------|---------------|
| `server.command` | Stdio (default) |
| `server.url` | StreamableHTTP (MCP 2025 spec, default) |
| `server.url` + `server.transport: "sse"` | Legacy SSE |

Use `"sse"` only for older servers that have not migrated to the current MCP HTTP spec.

See [transports.md](transports.md) for the complete guide including authentication, legacy SSE, and programmatic usage.

---

## What `scan` does

`checkspec scan` connects to your server, discovers everything it exposes, auto-generates tests for tools / resources / prompts, runs them all, then runs a security scan — all in one step.

### Example output

```
  ════════════════════════════════════════
    My Server  ·  tools: 2  resources: 1 (+ 2 templates)  prompts: 1
  ════════════════════════════════════════

  ── Protocol ────────────────────────────
  ✓ Protocol: Initialization handshake (11ms)

  ── Tools ───────────────────────────────
  ✓ Tool: read_file - valid input (8ms)
  ✓ Tool: search - valid input (12ms)

  ── Fuzz ────────────────────────────────
  ✓ Tool: read_file - "" (empty string) (5ms)
  ✓ Tool: read_file - " " (whitespace) (4ms)
  ✓ Tool: read_file - "\n\r\t" (control chars) (4ms)
  ✓ Tool: read_file - "null" (5ms)
  ✓ Tool: read_file - "undefined" (4ms)
  ✓ Tool: search - "" (empty string) (6ms)
  ...

  ── Resources ───────────────────────────
  ✓ Resource: version://info (7ms)

  ── Prompts ─────────────────────────────
  ✓ Prompt: summarize (6ms)

  ── Security Scan ───────────────────────
  No security findings.

  ════════════════════════════════════════
    ✓ Passed: 14/14  ·  0 security findings  ·  in 193ms
  ════════════════════════════════════════
```

### Scan options

| Flag | Description |
|------|-------------|
| `--fuzz` | Use all 19 edge-case inputs + invalid-type inputs per string property (default: 5 edge cases) |
| `--no-fuzz` | Skip fuzz tests entirely (conformance + security only) |
| `--save <file>` | Save the generated collection to a `.checkspec.json` file |
| `--save-recording [file]` | Save the full JSON-RPC interaction log (default: `checkspec-recording.json`) |
| `--output <format>` | Output format: `console` (default), `json`, `junit` |
| `--timeout <ms>` | Per-test timeout in milliseconds (default: 10000) |
| `--cwd <dir>` | Working directory for the server process (required for Python uv projects) |
| `--env KEY=VALUE` | Set an environment variable for the server process (repeatable) |
| `--verbose` | Show server stderr output (suppressed by default to hide Python INFO logs) |

---

## Writing Your Own Tests

Auto-generated tests verify basic conformance. For real correctness, write your own with concrete inputs and assertions.

### 1. Generate a skeleton collection

```bash
checkspec scan "node dist/index.js" --save my-server.checkspec.json
```

### 2. Open the file and add meaningful test cases

> **Tip:** The `id` field is optional — CheckSpec auto-generates stable IDs from the test name when omitted. You can add explicit IDs later for readability.

```json
{
  "version": "1.0",
  "name": "My Server Tests",
  "server": {
    "command": "node",
    "args": ["dist/index.js"]
  },
  "tests": [
    {
      "id": "read-hosts",
      "name": "read_file: /etc/hosts contains localhost",
      "type": "tool-call",
      "tool": "read_file",
      "input": { "file_path": "/etc/hosts" },
      "expect": {
        "success": true,
        "contains": "localhost",
        "executionTimeMs": 500
      },
      "tags": ["smoke", "read_file"]
    },
    {
      "id": "read-missing",
      "name": "read_file: returns error for missing file",
      "type": "tool-call",
      "tool": "read_file",
      "input": { "file_path": "/does/not/exist.txt" },
      "expect": { "success": false }
    },
    {
      "id": "version-resource",
      "name": "version resource returns JSON with version field",
      "type": "resource-read",
      "uri": "version://info",
      "expect": {
        "schema": {
          "type": "object",
          "properties": { "version": { "type": "string" } },
          "required": ["version"]
        },
        "executionTimeMs": 200
      }
    },
    {
      "id": "summarize-prompt",
      "name": "summarize prompt renders correctly",
      "type": "prompt-get",
      "promptName": "summarize",
      "promptArgs": { "topic": "TypeScript" },
      "expect": { "contains": "TypeScript" }
    },
    {
      "id": "security-read-file",
      "name": "read_file: no high-severity security issues",
      "type": "security",
      "tool": "read_file",
      "securityThreshold": "high"
    }
  ]
}
```

### 3. Re-run anytime

```bash
# Run all tests
checkspec test my-server.checkspec.json

# Run only smoke tests
checkspec test my-server.checkspec.json --filter smoke

# Stop on first failure
checkspec test my-server.checkspec.json --bail

# JUnit output for CI
checkspec test my-server.checkspec.json --output junit > results.xml
```

---

## Test Types

| Type | Required field | What it does |
|------|---------------|-------------|
| `tool-call` | `tool` | Calls a tool with given `input`, validates the response against `expect` |
| `streaming-tool-call` | `tool` | Calls a streaming tool and asserts on progress chunks via `streamExpect` |
| `resource-read` | `uri` | Reads a resource URI, validates content against `expect` |
| `prompt-get` | `promptName` | Fetches a prompt template (with optional `promptArgs`), validates messages |
| `protocol` | — | Verifies the MCP initialization handshake responds correctly |
| `fuzz` | `tool` | Calls a tool with an adversarial `input`; any MCP response = pass |
| `security` | `tool` | Runs SecurityScanner probes on that specific tool |

`expect` supports: `success` (boolean), `contains` (substring), `notContains`, `equals` (exact match), `matches` (regex), `jsonPath` (field extraction), `schema` (JSON Schema), `executionTimeMs` (max ms), `maxTokens` (response size limit).

See [collection-format.md](collection-format.md) for the complete field reference.

---

## Retry on Failure

Any test case can be configured to automatically re-run on failure — useful for flaky network calls, external APIs, or servers with cold-start latency:

```json
{
  "id": "flaky-lookup",
  "name": "get_data › retries on transient failure",
  "type": "tool-call",
  "tool": "get_data",
  "input": { "id": "abc" },
  "expect": { "success": true },
  "retry": 2,
  "retryDelayMs": 500
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `retry` | `0` | Extra attempts after the first failure (max 5) |
| `retryDelayMs` | `500` | Milliseconds to wait between attempts |

Console output shows attempt numbers when retry is configured:

```
✓ get_data › retries on transient failure (passed on attempt 2/3) 512ms
✗ get_data › retries on transient failure (failed after 3 attempts) 1030ms
```

See [retry.md](retry.md) for the full guide including `--bail` interaction and streaming test retry.

---

## Setup and Teardown Hooks

Hooks seed fixture data, reset server state, and verify connectivity — keeping tests isolated without repeating setup logic in every test.

### Hook phases

| Phase | When |
|-------|------|
| `beforeAll` | Once before the whole suite |
| `afterAll` | Once after all tests — always runs, even after failures |
| `beforeEach` | Before every individual test |
| `afterEach` | After every individual test — always runs |

### Example: stateful server collection

```json
{
  "version": "1.0",
  "name": "User API Tests",
  "server": { "command": "node", "args": ["dist/index.js"] },
  "hooks": {
    "beforeAll": [
      {
        "name": "seed fixture user alice",
        "run": { "type": "tool-call", "tool": "create_user", "input": { "id": "alice", "name": "Alice" } }
      }
    ],
    "afterAll": [
      {
        "name": "reset server state",
        "run": { "type": "tool-call", "tool": "reset_store", "input": {} }
      }
    ],
    "beforeEach": [
      {
        "name": "verify server is reachable",
        "run": { "type": "tool-call", "tool": "list_users", "input": {} }
      }
    ]
  },
  "tests": [
    {
      "id": "get-alice",
      "name": "get_user › returns seeded user alice",
      "type": "tool-call",
      "tool": "get_user",
      "input": { "id": "alice" },
      "expect": { "success": true, "contains": "Alice" }
    }
  ]
}
```

### Shell hooks

Hooks can also run local shell commands — useful for starting/stopping companion services or printing debug banners:

```json
{
  "name": "print teardown banner",
  "run": { "type": "shell", "command": "echo", "args": ["teardown complete"] }
}
```

### Console output

```
[setup]     seed fixture user alice   ✓ 2ms
[setup]     seed fixture user bob     ✓ 1ms
[each]      verify server is reachable ✓ 0ms
  ✓ get_user › returns seeded user alice  (1ms)
[teardown]  reset server state        ✓ 0ms

Tests: 1 passed, 0 failed
Hooks: 4 passed, 0 failed
```

Failed setup hooks abort the suite by default (`failFast: true`). Teardown hooks continue even when individual hooks fail (`failFast: false` by default). See [collection-format.md](collection-format.md#hooks) for the full field reference.

### Hook context variables

Hooks can capture values from their tool-call response and pass them to later hooks and tests via `{{varName}}` placeholders — no more hardcoding generated IDs:

```json
{
  "hooks": {
    "beforeAll": [
      {
        "name": "create test user",
        "run": { "type": "tool-call", "tool": "create_user", "input": { "name": "Alice" } },
        "capture": { "userId": "$.user.id" }
      }
    ]
  },
  "tests": [
    {
      "id": "get-user",
      "type": "tool-call",
      "tool": "get_user",
      "input": { "id": "{{userId}}" },
      "expect": { "success": true }
    }
  ]
}
```

The `$.user.id` expression extracts the value from the hook's JSON response. See [hook-context.md](hook-context.md) for the full guide.

---

## Parametrized Tests

A single test definition can expand into multiple cases using the `parametrize` field — great for testing the same tool with many inputs:

```json
{
  "id": "add-cases",
  "name": "add › arithmetic",
  "type": "tool-call",
  "tool": "add",
  "input": { "a": 0, "b": 0 },
  "expect": { "success": true },
  "parametrize": [
    { "label": "3 + 4 = 7", "input": { "a": 3, "b": 4 }, "expect": { "contains": "7" } },
    { "label": "-5 + -3 = -8", "input": { "a": -5, "b": -3 }, "expect": { "contains": "-8" } }
  ]
}
```

Each row expands into its own test case. Rows can override `input` and `expect` fields (shallow merge, row wins). See [parameterization.md](parameterization.md) for the full guide.

---

## Describe Blocks (Grouping Tests)

Group related tests into named sections with optional per-group setup/teardown:

```json
{
  "describe": [
    {
      "name": "user management",
      "hooks": {
        "beforeAll": [{ "name": "seed users", "run": { "type": "tool-call", "tool": "seed", "input": {} } }]
      },
      "tests": [
        { "id": "get-user", "name": "get_user works", "type": "tool-call", "tool": "get_user", "input": { "id": "alice" }, "expect": { "success": true } }
      ]
    }
  ],
  "tests": []
}
```

Console output shows group headers:

```
  user management ─────────────────────────────
[setup]     seed users                          ✓ 2ms
  ✓ get_user works (1ms)
```

Describe blocks run before top-level tests, each with their own `beforeAll`/`afterAll` lifecycle. Top-level hooks still apply to all tests. See [describe-blocks.md](describe-blocks.md) for the full guide.

---

## Concurrent Test Execution

Speed up large suites by running tests in parallel:

```json
{
  "version": "1.0",
  "name": "Fast Suite",
  "server": { "command": "node", "args": ["dist/server.js"] },
  "concurrency": 4,
  "tests": [...]
}
```

Tests are processed in chunks of `concurrency` size. Each test's full lifecycle (`beforeEach` → test → `afterEach`) runs as one unit, so hooks are never interleaved. `beforeAll`/`afterAll` always run serially.

**Warning:** Only use concurrency with stateless tools. Tests that mutate shared server state (e.g., database writes) may produce flaky results when run in parallel. The default `concurrency: 1` is the safe choice.

See [collection-format.md](collection-format.md#concurrency) for the full reference and `examples/concurrent-tests.json` for a working example.

---

## Security Scanning

`checkspec scan` automatically runs a security scan after the conformance tests. You can also add `type: "security"` cases to your collection to scan specific tools as part of every test run.

The scanner checks for:

- **Tool poisoning** — hidden instructions or invisible unicode in tool names / descriptions; suspiciously long descriptions (> 1000 chars)
- **Rug-pull behaviour** — tool returns significantly different content on the 3rd identical call compared to the 1st (edit-distance ratio > 20%)
- **Prompt injection passthrough** — tool echoes an injection payload verbatim, or its response contains AI system-prompt leakage markers

Findings are printed with `CRITICAL / HIGH / MEDIUM / LOW / INFO` severity. The `securityThreshold` field on a `security` test case sets the maximum tolerated severity — findings at that level and below pass, only findings strictly above it fail the test. For example, a threshold of `"high"` means HIGH findings are tolerated; only CRITICAL fails. Default: `"medium"`.

The `scan` command exits with code `1` if any `critical` security findings are detected.

---

## Fuzz Testing vs. Security Scanning

These are two distinct mechanisms that complement each other. Understanding the difference helps you use both correctly.

### Fuzz tests — resilience / stability

**Question they answer:** "Does this input *crash* the server?"

A fuzz test passes if the server returns **any** valid MCP response — even `{ isError: true }` counts as a pass. It fails only if the server:

- **Disconnects** (process crash or hard error)
- **Times out** (hangs, never responds)
- **Breaks the MCP protocol** (malformed JSON-RPC)

```
SQL injection input sent → server returns "Unable to fetch: '; DROP TABLE..." → ✓ PASS
XSS input sent           → server returns any error message                   → ✓ PASS
Path traversal sent      → server hangs for 30 seconds                        → ✗ FAIL (timeout)
Null byte in path        → server process crashes and disconnects              → ✗ FAIL (crash)
```

Fuzz tests do **not** inspect the response content. They only care that the server stayed alive.

### Security scan — vulnerability / malicious-behavior detection

**Question it answers:** "Does this tool *behave suspiciously*?"

The security scanner runs three active probes:

| Probe | What it looks for |
|-------|------------------|
| **Tool poisoning** | Hidden instructions, invisible unicode, or unusually long descriptions in the tool metadata — signs a malicious server is trying to manipulate the AI calling it |
| **Rug-pull** | Calls the tool 3× with the same input and compares responses. A > 20% edit-distance change on the 3rd call flags the tool as possibly non-deterministic or deceptive |
| **Prompt injection passthrough** | Sends payloads like `"Ignore all previous instructions"` and `"{{system_prompt}}"` as input values, then checks whether the *response* echoes them back or contains AI system-prompt leak markers |

The security scanner is looking for **malicious intent or exploitable vulnerabilities** — not just stability.

### How they work together

| Goal | Use |
|------|-----|
| Confirm server handles unexpected inputs without crashing | Fuzz tests (`type: "fuzz"`) |
| Confirm server doesn't have hidden malicious instructions | Security scan (`type: "security"`) |
| Full coverage | Run both: `checkspec scan --fuzz` |

> **Practical example:** A file_reader tool that echoes the file path in its error message will *pass* all fuzz tests (it didn't crash). The security scanner now recognizes error-path echoes and will not flag them as prompt-injection findings. Only tools that echo injection payloads in *success* responses are flagged.

---

## Recording Interactions

Save a full JSON-RPC interaction log for debugging or future replay:

```bash
# Save recording alongside JSON results (auto-triggered)
checkspec scan "node dist/index.js" --output json > results.json
# → also writes checkspec-recording.json

# Save recording to a specific file
checkspec scan "node dist/index.js" --save-recording ./recordings/run1.json

# Save recording from a collection test run
checkspec test my-server.checkspec.json --save-recording ./recordings/test-run.json
```

The recording contains every MCP request and response with timestamps and per-call timing.

---

## CI Integration

### Minimal GitHub Actions workflow (Node.js server)

```yaml
- name: Build server
  run: npm run build

- name: Run MCP tests
  run: |
    checkspec test my-server.checkspec.json \
      --output junit > junit-results.xml

- name: Upload results
  uses: actions/upload-artifact@v4
  with:
    name: checkspec-results
    path: junit-results.xml
```

### Python server in CI

```yaml
- uses: astral-sh/setup-uv@v4

- name: Install Python deps
  run: uv sync
  working-directory: my-python-server/

- name: Run MCP tests
  run: |
    checkspec test my-python-server/server.checkspec.json \
      --output junit > test-results.xml
```

---

## CLI Quick Reference

```
checkspec scan <server-command>     Auto-generate and run tests + security scan
checkspec test <collection-file>    Run a .checkspec.json collection
checkspec diff <server-command>     Detect schema drift against a saved baseline
checkspec inspect <server-command>  Show server capabilities (tools/resources/prompts)
checkspec report <results-json>     Convert a saved JSON results file to another format
```

Use `checkspec <command> --help` for the full option list.
