# @checkspec/sdk

Programmatic API for [CheckSpec](https://github.com/jjevsikov/CheckSpec) — the test framework for MCP servers. Use this to embed CheckSpec inside Vitest, Jest, or any Node.js test runner.

## Install

```bash
npm install @checkspec/sdk
```

## Usage

```typescript
import { scan, test } from "@checkspec/sdk";

// Auto-scan: discover tools, fuzz inputs, run security checks
const { summary, findings } = await scan("node dist/server.js");
console.log(`${summary.passed}/${summary.total} passed`);

// Run a custom test collection
const result = await test("my-server.checkspec.json");
console.log(`${result.summary.failed} failures`);
```

### Inside a test framework

```typescript
import { scan } from "@checkspec/sdk";
import { describe, it, expect } from "vitest";

describe("MCP server", () => {
  it("passes all generated tests", async () => {
    const { summary } = await scan("node dist/index.js");
    expect(summary.failed).toBe(0);
  });

  it("has no critical security issues", async () => {
    const { findings } = await scan("node dist/index.js");
    const critical = findings.filter(f => f.severity === "critical");
    expect(critical).toHaveLength(0);
  });
});
```

## Documentation

Full docs, examples, and the collection format reference are in the [main repository](https://github.com/jjevsikov/CheckSpec).

## License

MIT
