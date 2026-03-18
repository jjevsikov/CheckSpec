# Transports

CheckSpec supports three transport types for connecting to MCP servers. The transport determines how CheckSpec communicates with the server process.

---

## Stdio (default)

Stdio is the default transport. CheckSpec spawns the server as a child process and communicates over standard input/output using the MCP JSON-RPC protocol.

**Use stdio when:**
- Testing a server you build and run locally
- Running tests in CI where the server starts and stops per test run
- Testing Node.js, Python, or any other language server that accepts stdin/stdout

### Collection format

```json
{
  "server": {
    "command": "node",
    "args": ["dist/index.js"],
    "cwd": "/path/to/server",
    "env": { "NODE_ENV": "test" }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `command` | Yes | Executable to run (e.g. `"node"`, `"uv"`, `"python"`) |
| `args` | No | Arguments passed to the executable |
| `cwd` | No | Working directory for the server process. Required for Python `uv` projects so that `uv` can locate the virtual environment. |
| `env` | No | Extra environment variables merged into the server process environment |

### Python / uv servers

For Python servers managed by `uv`, the `cwd` field is required:

```json
{
  "server": {
    "command": "uv",
    "args": ["run", "server.py"],
    "cwd": "/path/to/project"
  }
}
```

```bash
# CLI equivalent
checkspec scan "uv run server.py" --cwd /path/to/project
```

See [python-servers.md](python-servers.md) for the complete Python guide.

---

## StreamableHTTP (remote servers)

`StreamableHTTP` is the current standard MCP HTTP transport (defined in the MCP 2025-03-26 specification). Use it to test a server that is already running — on `localhost` during development, or deployed to a remote host.

**Use StreamableHTTP when:**
- Testing a deployed server (staging, production)
- The server runs as a persistent HTTP service, not a child process
- You need authentication (API keys, bearer tokens)
- Testing multiple CheckSpec collections against the same long-running server instance

### Collection format

```json
{
  "server": {
    "url": "http://localhost:3001/mcp"
  }
}
```

With authentication:

```json
{
  "server": {
    "url": "https://my-mcp-server.example.com/mcp",
    "transport": "streamable-http",
    "headers": {
      "Authorization": "Bearer my-api-token"
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `url` | Yes | Full URL of the MCP endpoint (must be a valid HTTP or HTTPS URL) |
| `transport` | No | `"streamable-http"` (default) or `"sse"` |
| `headers` | No | HTTP headers sent with every request |

### CLI usage

```bash
# Scan a remote server by URL
checkspec scan --url http://localhost:3001/mcp

# With an auth header
checkspec scan --url https://api.example.com/mcp --header "Authorization: Bearer token"

# Run a collection against a remote server
checkspec test my-tests.checkspec.json
```

When `server.url` is set in the collection file, CheckSpec uses the StreamableHTTP transport automatically — no extra flags needed.

### Authentication

Pass authentication credentials via `headers`. Common patterns:

**Bearer token:**
```json
{
  "headers": {
    "Authorization": "Bearer eyJhbGciOi..."
  }
}
```

**API key:**
```json
{
  "headers": {
    "X-API-Key": "sk-prod-abc123"
  }
}
```

**Basic auth:**
```json
{
  "headers": {
    "Authorization": "Basic dXNlcjpwYXNz"
  }
}
```

> **Security note:** Do not commit tokens to version control. Use environment variables in CI and reference them through your CI system's secret injection. The `headers` field accepts string values only — variable substitution (`{{varName}}`) does not apply to the server config block.

---

## Legacy SSE

Server-Sent Events (SSE) is the original MCP HTTP transport. It is deprecated in favor of `StreamableHTTP` but remains supported for servers that have not yet migrated.

**Use SSE when:**
- The server was built against an older version of the MCP SDK
- The server explicitly uses `SSEServerTransport` (server-side)
- `StreamableHTTP` fails to connect (try SSE as a fallback)

### Collection format

```json
{
  "server": {
    "url": "http://localhost:3001/sse",
    "transport": "sse"
  }
}
```

With authentication:

```json
{
  "server": {
    "url": "https://legacy-server.example.com/sse",
    "transport": "sse",
    "headers": {
      "Authorization": "Bearer my-token"
    }
  }
}
```

The `headers` field works identically for SSE and StreamableHTTP.

---

## Choosing a Transport

| Situation | Transport |
|-----------|-----------|
| Local development, server started per test | `stdio` (no `url` field) |
| Server already running on localhost | `streamable-http` (omit `transport` field) |
| Deployed staging or production server | `streamable-http` with `headers` for auth |
| Older server using SSE transport | `sse` |

---

## Examples

### Local development server (stdio)

```json
{
  "version": "1.0",
  "name": "My Local Server Tests",
  "server": {
    "command": "node",
    "args": ["dist/index.js"],
    "env": { "NODE_ENV": "test" }
  },
  "tests": [
    {
      "name": "smoke test",
      "type": "protocol"
    }
  ]
}
```

### Deployed server with bearer token

```json
{
  "version": "1.0",
  "name": "Production Server Tests",
  "server": {
    "url": "https://api.example.com/mcp",
    "headers": {
      "Authorization": "Bearer prod-token-abc123"
    }
  },
  "tests": [
    {
      "name": "smoke test",
      "type": "protocol"
    },
    {
      "name": "list tools smoke test",
      "type": "tool-call",
      "tool": "list_items",
      "input": {},
      "expect": { "success": true }
    }
  ]
}
```

### Legacy SSE server

```json
{
  "version": "1.0",
  "name": "Legacy SSE Server Tests",
  "server": {
    "url": "http://localhost:8080/sse",
    "transport": "sse"
  },
  "tests": [
    {
      "name": "smoke test",
      "type": "protocol"
    }
  ]
}
```

---

## Programmatic Usage

When building a transport programmatically with `@checkspec/core`, use the MCP SDK directly:

```typescript
import { MCPRecordingClient } from "@checkspec/core";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// Stdio
const stdioTransport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

// StreamableHTTP
const httpTransport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3001/mcp"),
  {
    requestInit: {
      headers: { Authorization: "Bearer my-token" },
    },
  }
);

// Legacy SSE
const sseTransport = new SSEClientTransport(
  new URL("http://localhost:3001/sse"),
  {
    requestInit: {
      headers: { Authorization: "Bearer my-token" },
    },
  }
);

const client = new MCPRecordingClient(httpTransport);
await client.connect();
// ... run tests ...
await client.disconnect();
```

The CLI's `buildTransport()` helper in `packages/cli/src/transport.ts` handles transport selection automatically based on the collection's `server` config.
