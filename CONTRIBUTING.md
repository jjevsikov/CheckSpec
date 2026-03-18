# Contributing to CheckSpec

CheckSpec is an open-source testing platform for MCP (Model Context Protocol) servers. Contributions of all kinds are welcome — bug reports, bug fixes, new test types, new reporters, security probes, documentation improvements, and example collections. This guide covers everything you need to get started effectively.

---

## Table of Contents

- [Good First Issues](#good-first-issues)
- [Development Setup](#development-setup)
- [Monorepo Structure](#monorepo-structure)
- [Types of Contributions](#types-of-contributions)
- [Code Style](#code-style)
- [Testing Guidelines](#testing-guidelines)
- [Pull Request Checklist](#pull-request-checklist)
- [Publishing a Release](#publishing-a-release)

---

## Good First Issues

If you are new to the codebase, these areas are well-scoped and require minimal context:

- **Add a new example collection** — Pick any demo server in `demos/` and write a `.checkspec.json` that exercises an interesting scenario (edge case inputs, hook chaining, parametrized tests). No code changes required.
- **Add a missing test case** — Browse `test/core/runner.test.ts` or `test/fixtures.test.ts` and look for an untested code path. Add an `it()` block.
- **Improve a CLI error message** — Run `node packages/cli/dist/index.js test` with a malformed collection and see if the error message is clear. If not, improve it in `packages/cli/src/commands/test.ts`.
- **Add a documentation example** — Many doc pages in `docs/` benefit from more concrete `checkspec.json` snippets. Look for sections with prose but no example.
- **Fix a typo or formatting issue** — Docs are plain Markdown. Small improvements are always appreciated.

When in doubt, open an issue first to discuss what you plan to work on. This avoids duplicate effort and ensures the change aligns with the project's direction.

---

## Development Setup

### Prerequisites

- Node.js >= 20.0.0 (`node --version`)
- npm >= 10.0.0 (`npm --version`)
- Git

### First-time Setup

```bash
git clone https://github.com/jjevsikov/CheckSpec
cd CheckSpec
npm install    # installs all workspace dependencies
npm run build  # compiles all packages and fixtures
npm test       # should show 429 tests passing
```

### Daily Workflow

```bash
# Watch mode — rebuilds on changes
npm run dev

# Full build
npm run build

# All tests
npm test

# Tests for a single file (fast feedback loop)
npx vitest run test/core/assertions.test.ts

# Type-check without emitting
cd packages/core && npx tsc --noEmit
```

> **Important:** Always use `./node_modules/.bin/vitest run` and `./node_modules/.bin/turbo build` rather than `npx vitest` or `npx turbo`. The `npx` versions may resolve to incompatible global installations.

---

## Monorepo Structure

CheckSpec is a **Turborepo monorepo** with npm workspaces. All packages live under `packages/`. When you run `npm run build`, Turborepo resolves the dependency graph and builds packages in the correct order — you do not need to build individual packages manually unless you are iterating quickly on one.

| Directory | Purpose |
|-----------|---------|
| `packages/core/` | Library — all testing logic (assertions, runner, hooks, reporters, security scanner) |
| `packages/cli/` | CLI — thin Commander.js wrapper around `@checkspec/core` |
| `packages/sdk/` | Programmatic API for embedding CheckSpec in other tools |
| `packages/server/` | Express HTTP API (placeholder for future cloud features) |
| `packages/web/` | Placeholder for future web dashboard |
| `fixtures/` | Minimal MCP servers used as test targets |
| `demos/` | Seven full-featured demo servers with example collections |
| `examples/` | Example `.checkspec.json` collection files |
| `test/` | Vitest tests (unit and integration) |
| `docs/` | User-facing documentation |

The key architectural principle is that `packages/cli` contains **no business logic** — all execution lives in `packages/core` and is reusable via `packages/sdk`. When adding features, almost all code goes into `packages/core`.

---

## Types of Contributions

### Bug Fixes

1. Open an issue or comment on an existing one to signal your intent
2. Create a branch: `git checkout -b fix/your-description`
3. Make the fix and add a test that would have caught the bug
4. Run `npm test` to confirm everything passes
5. Submit a pull request

### Adding a New Test Type

The `TestCase.type` union currently supports `"tool-call" | "resource-read" | "prompt-get" | "protocol" | "fuzz" | "security"`. To add a new type:

1. **Add to the type union** — `packages/core/src/runner/TestCollection.ts`:
   ```typescript
   type: "tool-call" | "resource-read" | "prompt-get" | "protocol" | "fuzz" | "security" | "your-type";
   ```

2. **Add a handler** — `packages/core/src/runner/TestRunner.ts`:
   ```typescript
   private async runYourTypeTest(test: TestCase, start: number): Promise<TestResult> {
     // ...implementation...
   }
   ```

3. **Wire it up** in the `switch` in `runTest()`.

4. **Add tests** — `test/core/runner.test.ts`:
   ```typescript
   it("runs your-type test", async () => { ... });
   ```

5. **Document it** — add a section in `docs/collection-format.md`.

### Adding a Conformance Test Case

A "conformance test" is a `type: "tool-call"` (or `resource-read` / `prompt-get`) case that verifies specific protocol behaviour against a fixture server.

1. **Choose the right fixture server:**
   - `fixtures/echo-server` — clean, always-passing tests
   - `fixtures/buggy-server` — error paths, timeouts, schema violations
   - `fixtures/malicious-server` — security scanner probes

2. **If you need new server behaviour**, add it to the fixture's `src/index.ts`. Use `McpServer.registerTool()` with a Zod inputSchema:
   ```typescript
   server.registerTool("new-tool", {
     description: "...",
     inputSchema: { value: z.string() },
   }, async ({ value }) => ({
     content: [{ type: "text" as const, text: value }],
   }));
   ```

3. **Write the conformance test** in `test/fixtures.test.ts`:
   ```typescript
   it("new-tool returns the value", async () => {
     const result = await client.callTool("new-tool", { value: "hello" });
     expect(result.isError).toBeFalsy();
     const text = result.content
       .filter((c) => c.type === "text")
       .map((c) => (c as { text: string }).text)
       .join("");
     expect(text).toContain("hello");
   });
   ```

4. Run `npm test` — the fixture build is included in `turbo build`.

### Adding a New Security Probe

The `SecurityScanner` in `packages/core/src/security/SecurityScanner.ts` runs three classes of probes (tool poisoning, rug-pull, prompt injection). To add a fourth:

1. **Understand `SecurityFinding`:**
   ```typescript
   interface SecurityFinding {
     severity: "critical" | "high" | "medium" | "low" | "info";
     type: "tool-poisoning" | "prompt-injection" | "rug-pull" | "data-exfiltration" | "resource-exhaustion";
     tool?: string;
     description: string;
     evidence?: string;
   }
   ```

2. **Add a private method** to `SecurityScanner`:
   ```typescript
   private async checkMyProbe(
     client: MCPRecordingClient,
     tool: Tool
   ): Promise<SecurityFinding[]> {
     const findings: SecurityFinding[] = [];
     // ... your detection logic ...
     if (suspiciousCondition) {
       findings.push({
         severity: "high",
         type: "tool-poisoning",  // use the closest existing type
         tool: tool.name,
         description: "Human-readable explanation",
         evidence: "The suspicious text or response",
       });
     }
     return findings;
   }
   ```

3. **Call it** from `scanTool()`, pushing results into `findings`.

4. **Add a fixture** that triggers the probe in `fixtures/malicious-server/src/index.ts`.

5. **Add a test** in `test/fixtures.test.ts` that asserts `SecurityScanner.scan()` detects the finding.

### New Reporter

Reporters implement the `Reporter` interface:

```typescript
interface Reporter {
  onTestStart(test: TestCase): void;
  onTestEnd(result: TestResult): void;
  onRunEnd(summary: RunSummary): void;
  flush(): string;
}
```

1. Create `packages/core/src/reporters/MyReporter.ts`
2. Export from `packages/core/src/reporters/index.ts` and `packages/core/src/index.ts`
3. Wire into `packages/cli/src/commands/scan.ts` and `test.ts` in `createReporter()`

### New Fixture Server

For a **stdio** fixture (local child process):

1. **Copy the echo-server structure:**
   ```bash
   cp -r fixtures/echo-server fixtures/my-server
   ```

2. **Update `fixtures/my-server/package.json`** — change `name` and `description`.

3. **Edit `fixtures/my-server/src/index.ts`** using `McpServer` + `StdioServerTransport` + `zod`:
   ```typescript
   server.registerTool("my-tool", {
     description: "Does something",
     inputSchema: { input: z.string() },
   }, async ({ input }) => ({
     content: [{ type: "text" as const, text: `result: ${input}` }],
   }));
   ```

4. **Add integration tests** in `test/fixtures.test.ts`.

5. `npm run build && npm test`

For an **HTTP** fixture (StreamableHTTP or SSE transport), follow the `fixtures/http-server` pattern — it uses `StreamableHTTPServerTransport` with Express. HTTP fixtures require starting the server before the test suite and stopping it after.

---

## Code Style

### Language and Tooling

- **TypeScript strict mode** — no `any`, no implicit types
- **ESM throughout** — all packages use `"type": "module"`
- **`.js` extensions** on all relative imports in source files (required for NodeNext):
  ```typescript
  import { foo } from "./foo.js";  // not "./foo" or "./foo.ts"
  ```

### Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Classes | PascalCase | `MCPRecordingClient`, `TestRunner` |
| Interfaces | PascalCase | `RecordedMessage`, `TestCase` |
| Functions | camelCase | `runCollection`, `createScanCommand` |
| Constants | UPPER_SNAKE | `INJECTION_PAYLOADS` |
| Files | PascalCase for classes, camelCase for utils | `MCPRecordingClient.ts`, `expect.ts` |

### Error Handling

- In library code (core), throw descriptive `Error` instances. Do not swallow errors silently.
- In CLI commands, catch errors at the top level and `process.exit(1)` with a message.
- Remember: **MCP tool errors return `{ isError: true }`** — they do not throw. Check `result.isError` rather than wrapping in try/catch.

---

## Testing Guidelines

### What to Test

- **Every new function** should have at least one passing and one failing case
- **Integration tests** that spawn fixture servers should use `beforeAll`/`afterAll` to connect/disconnect once per `describe` block (not per `it`)
- **Avoid real network calls** — all MCP servers are spawned locally via stdio transport

### Test Location

| Test type | Location |
|-----------|---------|
| Pure unit (no I/O) | `test/core/*.test.ts` |
| Integration with echo-server | `test/core/client.test.ts`, `test/core/runner.test.ts` |
| Fixture-specific | `test/fixtures.test.ts` |

### Timeout Defaults

The vitest config sets `testTimeout: 30_000` and `hookTimeout: 15_000`. Individual slow tests can extend this with `{ timeout: 60_000 }` as the third argument to `it()`.

---

## Pull Request Checklist

Before submitting a pull request, verify each of the following:

- [ ] `npm test` passes (429 tests)
- [ ] `cd packages/core && npx tsc --noEmit` passes with no type errors
- [ ] New features have corresponding tests
- [ ] Public API changes are reflected in `docs/api-reference.md`
- [ ] New test types are documented in `docs/collection-format.md`
- [ ] `CLAUDE.md` is updated if new conventions, gotchas, or patterns were introduced

Pull requests that fail the test suite or introduce type errors will not be merged. If you are unsure whether a change is in scope, open an issue first.

---

## Publishing a Release

1. Bump version in both `packages/core/package.json` and `packages/cli/package.json`
2. Run `npm run build && npm test` from root — must be clean
3. Publish core first, then CLI:
   ```bash
   cd packages/core && npm publish --access public
   cd ../cli && npm publish --access public
   ```
4. Tag the release:
   ```bash
   git tag v0.1.0 && git push --tags
   ```
5. Create a GitHub Release from the tag with the changelog

> **Note:** Verify that `homepage` and `repository.url` in both `package.json` files point to the correct GitHub repository before the first publish.

---

## Questions

If something is unclear or you are unsure how to approach a change, open a GitHub Discussion or file an issue. We are happy to help orient new contributors.
