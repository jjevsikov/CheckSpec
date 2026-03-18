# @checkspec/core

Core library for [CheckSpec](https://github.com/jjevsikov/CheckSpec) — the test framework for MCP servers.

This package contains the test runner, assertion engine, security scanner, schema-driven input generator, and reporters. It is used internally by `@checkspec/cli` and `@checkspec/sdk`. You probably want one of those instead unless you're building custom tooling on top of CheckSpec.

## Install

```bash
npm install @checkspec/core
```

## What's inside

- **MCPRecordingClient** — wraps the MCP SDK client, records all request/response pairs
- **TestRunner** — executes test collections with hooks, retry, parametrize, and concurrency
- **SecurityScanner** — detects tool poisoning, rug-pull attacks, and prompt injection
- **SchemaInputGenerator** — generates valid, invalid, edge-case, and fuzz inputs from JSON Schemas
- **MCPExpect** — chainable assertion API (contains, equals, matches, schema, jsonPath, timing)
- **Reporters** — Console, HTML, JUnit XML, and JSON output formats
- **HookRunner** — beforeAll/afterAll/beforeEach/afterEach with capture variables

## Subpath exports

```typescript
import { TestRunner, MCPRecordingClient, SecurityScanner } from "@checkspec/core";
import { collectionSchema, validateCollection } from "@checkspec/core/schema";
import { MCPRecordingClient } from "@checkspec/core/client";
import { TestRunner } from "@checkspec/core/runner";
import { SecurityScanner } from "@checkspec/core/security";
import { SchemaInputGenerator } from "@checkspec/core/generators";
import { HTMLReporter, JUnitReporter } from "@checkspec/core/reporters";
```

## Documentation

Full docs, examples, and the collection format reference are in the [main repository](https://github.com/jjevsikov/CheckSpec).

## License

MIT
