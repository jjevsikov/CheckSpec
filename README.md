<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/checkspec-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/checkspec-logo-light.svg">
    <img alt="CheckSpec — Trust your MCP server." src="assets/checkspec-logo-light.svg" height="120">
  </picture>
</p>

<p align="center">
  <strong>The test framework for MCP servers.</strong><br>
  Automated scanning, custom test suites, and security analysis.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@checkspec/cli"><img alt="npm" src="https://img.shields.io/npm/v/@checkspec/cli.svg"></a>
  <a href="https://github.com/jjevsikov/CheckSpec/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jjevsikov/CheckSpec/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Tests" src="https://img.shields.io/badge/tests-482%20passed-brightgreen">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#what-checkspec-catches">What It Catches</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#demo-servers">Examples</a> ·
  <a href="#documentation">Docs</a>
</p>

---

MCP servers talk directly to LLMs — that's a new attack surface your unit tests don't cover. Think of CheckSpec as **pytest for [MCP](https://modelcontextprotocol.io/) servers**.

One command scans your server — discovers every tool, fuzzes them with adversarial inputs, and checks for security vulnerabilities. No config, no test files, just results.

When you need more control, write `.checkspec.json` test collections — assertions, hooks, parametrized cases, streaming checks — committed alongside your code and run in CI. Same workflow as unit testing, but for the protocol layer between your server and the LLM.

Works with any language (Node.js, Python, Go) over stdio or HTTP. No SDK lock-in. No API keys.

---

## Features

### Writing tests

CheckSpec has two modes. `checkspec scan` is fully automatic — it connects to your server, discovers every tool, resource, and prompt, generates inputs from their schemas, and runs fuzz and security checks without you writing a single test. Use it for a quick health check or a first look at a server you didn't write.

`checkspec test` is for when you need real assertions. You write a `.checkspec.json` file that lives alongside your code — call a tool, assert what comes back, fail the build if something is wrong. You can check whether the response contains certain text, matches an exact value, conforms to a JSON Schema, or whether a field deep inside a nested object has the right value. Commit it to git, run it in CI, exactly like unit tests.

**Hooks** let you manage server state around your tests. If your server is stateful — users, sessions, database rows — create the data you need in `beforeAll`, use it across all your tests, then clean it up in `afterAll`. Hook results feed forward into tests: if `beforeAll` creates a user and gets back an ID, capture that ID and reference it as `{{userId}}` in every test that follows.

**Parametrized tests** solve the repetition problem. Write one test case, supply a list of inputs, get a separate pass/fail for each. If you want to verify your `add` tool handles positive numbers, negative numbers, zero, and very large numbers — write it once.

**Describe blocks** let you group related tests with their own setup and teardown. Ten tests about user management and eight about billing can each have their own `beforeAll` without interfering with each other.

Other details: tests support `retry` for occasionally flaky tools, `timeoutMs` for per-test time budgets, and a `concurrency` setting for running tests in parallel on stateless servers.

### Security scanning

The security scanner runs automatically as part of `checkspec scan`. It can also be added to any custom test collection as a `"type": "security"` test case. You configure a `securityThreshold` — findings below your threshold are reported but don't fail the test, so you can acknowledge a known MEDIUM issue without blocking CI while you fix it.

What it detects is explained in detail in [What CheckSpec Catches](#what-checkspec-catches).

### CI integration

CheckSpec exits `0` when everything passes and `1` when something fails or a HIGH/CRITICAL security finding is detected. Fits any CI pipeline without configuration.

Output formats: `console` for local runs, `json` for scripting, `junit` for test reporting dashboards, and `html` for a self-contained shareable report you can attach as an artifact.

`checkspec diff` compares your server's current tools and schemas against a saved baseline. If a tool name changes, an argument is removed, or a description shifts significantly, it tells you. Useful for catching accidental API breakage in CI before it reaches users.

One small thing worth mentioning: typos in your `.checkspec.json` — like writing `"sucess": true` instead of `"success"` — are caught before your server even starts. You won't spend time wondering why a test never failed when the assertion was silently ignored.

### Works anywhere

CheckSpec connects to your server over stdio (spawn any process) or HTTP (StreamableHTTP or SSE). It doesn't care what language your server is written in — Node.js, Python, Go, anything that implements the MCP protocol works.

There's also a programmatic SDK (`@checkspec/sdk`) if you want to run scans inside an existing Vitest or Jest suite, and a `checkspec generate` command that uses Claude to write a starter collection from your live server's capabilities.

---

## What CheckSpec Catches

Your unit tests verify your internal logic. They don't cover what happens when an LLM actually talks to your server over MCP — and that's exactly where things break in production.

**Prompt injection passthrough** -- Your tool reads a database field containing `"Ignore all previous instructions"` and passes it straight back to the LLM, unescaped. The LLM follows the injected instruction. CheckSpec sends known injection payloads through every tool and flags any that surface verbatim in the response.

**Tool poisoning** -- Someone slips a hidden `SYSTEM:` directive or invisible unicode into a tool description. The LLM reads it before the user ever calls the tool, and its behavior changes. CheckSpec scans all metadata for bidi overrides, zero-width characters, and embedded instructions.

**Rug-pull attacks** -- A tool that works fine the first time, but returns different content on the second or third call with identical input. This tricks agents that assume tools are deterministic. CheckSpec calls each tool three times and flags any divergence over 20% edit distance.

**Crash-inducing inputs** -- Empty strings, path traversal, SQL injection, XSS payloads, control characters. If these crash your server or break the MCP protocol framing, CheckSpec finds it before your users do.

---

## How It Compares

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is great for interactive debugging -- you open a UI, browse your tools, call them by hand, and inspect responses. It's what you want while building.

CheckSpec is what you add once the server works. Same difference as browser DevTools vs. a test suite: one helps you explore, the other makes sure nothing breaks when you ship.

| | MCP Inspector | **CheckSpec** |
|--|:--:|:--:|
| Interactive UI / point-and-click | Yes | -- |
| Automated test execution | -- | Yes |
| Schema-driven fuzz testing | -- | Yes |
| Custom test collections | -- | Yes |
| Setup/teardown hooks | -- | Yes |
| Streaming progress assertions | -- | Yes |
| Token budget assertions | -- | Yes |
| Prompt injection detection | -- | Yes |
| Tool poisoning / rug-pull detection | -- | Yes |
| JUnit XML / HTML CI reports | -- | Yes |
| Programmatic SDK | -- | Yes |
| Python / any stdio server | Yes | Yes |

---

## Getting Started

### Install

```bash
npm install -g @checkspec/cli
```

Or run directly with npx — no install needed:

```bash
npx checkspec scan "node dist/my-server.js"
```

### Quick audit (zero config)

Point it at your server. That's it.

```bash
npx checkspec scan "node dist/my-server.js"
```

```
CheckSpec  node dist/my-server.js
══════════════════════════════════════════════════
Connected in 68ms  ·  Tools: 3  ·  Resources: 1 (+ 2 templates)  ·  Prompts: 1

Tool Tests ───────────────────────────────────────
  ✓ create_note › valid input (12ms)
  ✓ get_note › valid input (8ms)
  ✓ delete_note › valid input (9ms)

Fuzz Tests ───────────────────────────────────────
  ✓ create_note › edge: empty string (4ms)
  ✓ create_note › edge: prompt injection (3ms)
  ✓ create_note › edge: SQL injection (4ms)
  ✓ create_note › edge: long string (10000 chars) (5ms)
  ✓ get_note › edge: path traversal (3ms)

Security Scan ────────────────────────────────────
  ✓ No security issues detected

══════════════════════════════════════════════════
Results: 13 passed, 0 failed  |  Total: 60ms
```

CheckSpec discovered 3 tools, generated 13 tests (including fuzz and security), and ran them in 60ms. You didn't write anything.

### Custom test suite (for regression coverage)

When you need real assertions — not just "does it crash?" but "does it return the right data?" — write a test collection:

```bash
# Scaffold a collection from your live server
npx checkspec init "node dist/my-server.js" --out my-server.checkspec.json

# Edit the collection to add assertions, hooks, etc.

# Run your tests
npx checkspec test my-server.checkspec.json
```

Start with `scan` for a quick check, then build a `.checkspec.json` when you need specific assertions.

---

## Write a Test Collection

A `.checkspec.json` file describes your server, your tests, and what you expect. It's a JSON file you commit alongside your code -- your MCP server's test suite.

`my-server.checkspec.json`:

```json
{
  "version": "1.0",
  "name": "Notes Server",
  "server": { "command": "node", "args": ["dist/index.js"] },
  "tests": [
    {
      "name": "create_note returns note with id",
      "type": "tool-call",
      "tool": "create_note",
      "input": { "title": "Meeting notes", "content": "Action items from standup" },
      "expect": {
        "success": true,
        "contains": "Meeting notes",
        "schema": { "type": "object", "required": ["id", "title", "createdAt"] }
      }
    },
    {
      "name": "get_note with unknown ID returns error",
      "type": "tool-call",
      "tool": "get_note",
      "input": { "id": "does-not-exist" },
      "expect": { "success": false }
    },
    {
      "name": "create_note has no prompt injection passthrough",
      "type": "security",
      "tool": "create_note",
      "securityThreshold": "high"
    }
  ]
}
```

The three tests above show the basic pattern: call a tool, check the result. The first test checks that the response succeeded, contains the title, and matches a JSON schema. The second checks that calling with a bad ID returns an error. The third runs the security scanner against `create_note` specifically.

Beyond `tool-call`, you can also test resources (`resource-read`), prompts (`prompt-get`), streaming tools (`streaming-tool-call`), and run targeted fuzz or security passes. The full collection format -- hooks, parametrize, capture variables, describe blocks, retry, concurrency -- is documented in [docs/collection-format.md](docs/collection-format.md).

---

## Demo Servers

The `demos/` directory contains seven realistic MCP servers. Some have **intentional security vulnerabilities** so you can see exactly what CheckSpec catches:

```bash
npm run demo:build   # build all example servers
npm run demo         # run all seven test collections
```

| Server | What CheckSpec Finds |
|--------|---------------------|
| [`calculator-server`](demos/calculator-server/) | Clean -- all 20 tests pass |
| [`notes-server`](demos/notes-server/) | Clean -- all 19 tests pass |
| [`filesystem-server`](demos/filesystem-server/) | **HIGH**: rug-pull on `delete_file` (behavior changes on repeat calls) |
| [`sqlite-server`](demos/sqlite-server/) | Clean -- all 17 tests pass |
| [`stateful-server`](demos/stateful-server/) | Hooks demo (beforeAll / afterAll / beforeEach) |
| [`streaming-server`](demos/streaming-server/) | Streaming progress chunks demo |
| [`task-manager-server`](demos/task-manager-server/) | **CRITICAL**: tool poisoning + 1 bug |

See [`demos/README.md`](demos/README.md) for detailed explanations of each finding.

---

## Programmatic SDK

Use CheckSpec inside Vitest, Jest, or any test runner:

```bash
npm install @checkspec/sdk
```

```typescript
import { scan, test } from "@checkspec/sdk";

describe("MCP server", () => {
  it("passes all generated tests", async () => {
    const { summary } = await scan("node dist/index.js");
    expect(summary.failed).toBe(0);
  });

  it("has no high-severity security issues", async () => {
    const { findings } = await scan("node dist/index.js");
    const critical = findings.filter(f =>
      f.severity === "high" || f.severity === "critical"
    );
    expect(critical).toHaveLength(0);
  });
});
```

---

## CI/CD

### GitHub Actions

```yaml
- name: Build server
  run: npm run build

- name: Test MCP server
  run: npx checkspec test my-server.checkspec.json --output junit > test-results.xml

- name: Upload test results
  uses: actions/upload-artifact@v4
  with:
    name: checkspec-results
    path: test-results.xml
```

### HTML Report as Artifact

```bash
npx checkspec test my-server.checkspec.json --report-html report.html
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All tests passed, no HIGH or CRITICAL security findings |
| `1` | One or more tests failed, or a HIGH or CRITICAL security finding |

---

## Python Servers

CheckSpec is language-agnostic. Any server that speaks MCP over stdio works, regardless of implementation language.

```bash
# FastMCP with uv
npx checkspec scan "uv run server.py" --cwd /path/to/project

# Standard Python
npx checkspec scan "python server.py" --cwd /path/to/project
```

The `--cwd` flag is required when using `uv` so it can locate the project's virtual environment. In a collection file, set `"cwd"` on the server config object.

See [docs/python-servers.md](docs/python-servers.md) for virtualenv setup and CI examples.

---

## CLI Reference

### `checkspec scan <server-command>`

Auto-discover capabilities, generate tests, fuzz inputs, and run the security scanner.

```
Options:
  --url <url>              Connect to an HTTP server instead of spawning a process
  --transport <type>       streamable-http (default) | sse
  --header KEY=VALUE       HTTP headers (repeatable)
  --fuzz / --no-fuzz       Full fuzz depth or skip fuzz tests entirely
  --save <file>            Save generated collection to a .checkspec.json file
  --report-html <file>     Save an HTML report
  -o, --output <format>    console | json | junit | html
  --cwd <dir>              Working directory for the server process
  --env KEY=VALUE          Environment variable (repeatable)
  --verbose                Show server stderr
  --save-recording         Save request/response recording
```

### `checkspec test <collection.checkspec.json>`

Run a `.checkspec.json` test collection.

```
Options:
  --report-html <file>     Save an HTML report
  -f, --filter <tag>       Run only tests with this tag
  --bail                   Stop on first failure
  --watch                  Re-run on file change
  -o, --output <format>    console | json | junit | html
  --cwd <dir>              Override server working directory
  --env KEY=VALUE          Environment variable (repeatable)
  --verbose                Show server stderr
  --save-recording         Save request/response recording
```

### `checkspec init <server-command>`

Scaffold a starter `.checkspec.json` from a live server. No API key needed.

```
Options:
  --out <file>             Output path (default: <server-name>.checkspec.json)
  --name <name>            Collection name
  --url <url>              Connect to an HTTP server
  --header KEY=VALUE       HTTP headers (repeatable)
  --force                  Overwrite existing file
```

### `checkspec diff <server-command>`

Detect schema drift by comparing live capabilities against a saved baseline.

```
Options:
  --baseline <file>        Compare against a specific baseline
  --save <path>            Save snapshot to a custom path
  --update                 Update the baseline after comparison
  --url <url>              Connect to an HTTP server
```

### `checkspec inspect <server-command>`

Display all server capabilities: tools with input schemas, resources, and prompts.

### `checkspec generate <server-command>`

Use Claude to generate a `.checkspec.json` collection from live server capabilities. Requires an Anthropic API key.

### `checkspec report <results.json>`

Convert a saved JSON result file to another output format.

---

## Architecture

```
  npx checkspec          @checkspec/sdk
  (CLI)                (programmatic)
       |                     |
       +---------------------+
                  |
         @checkspec/core
       +-------------------------------+
       |  TestRunner                   |
       |  SecurityScanner              |
       |  SchemaInputGenerator         |
       |  HTMLReporter / JUnitReporter |
       +---------------+---------------+
                       | MCP stdio / HTTP
             +---------v---------+
             |   Your MCP server  |
             +--------------------+
```

The CLI and SDK both call the same test engine. Write tests locally, run them identically in CI.

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | Install, first scan, all CLI flags |
| [Collection Format](docs/collection-format.md) | Full `.checkspec.json` reference |
| [Architecture](docs/architecture.md) | How CheckSpec works under the hood |
| [Streaming Tests](docs/streaming.md) | Assert on progress chunks and intervals |
| [Parametrized Tests](docs/parameterization.md) | One definition, many cases |
| [Retry on Failure](docs/retry.md) | Automatic re-runs for flaky tests |
| [Describe Blocks](docs/describe-blocks.md) | Grouped tests with per-group hooks |
| [Hook Context](docs/hook-context.md) | Capture variables and `{{varName}}` templates |
| [Transports](docs/transports.md) | HTTP transport guide (StreamableHTTP + SSE) |
| [API Reference](docs/api-reference.md) | `@checkspec/core` and `@checkspec/sdk` |
| [Python Servers](docs/python-servers.md) | FastMCP, uv, virtualenv guide |

---

## Development

```bash
git clone https://github.com/jjevsikov/CheckSpec
cd CheckSpec
npm install
npm run build   # build all packages
npm test        # 482 tests
```

---

## License

MIT -- see [LICENSE](LICENSE).
