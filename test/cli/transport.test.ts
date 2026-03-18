/**
 * Unit tests for buildTransportFromConfig in packages/cli/src/transport.ts
 *
 * These tests verify the transport factory function selects the correct
 * transport class based on the ServerConfig fields. No live servers are
 * required — we simply assert on the runtime instance type.
 */
import { describe, it, expect } from "vitest";
import { buildTransportFromConfig } from "../../packages/cli/src/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("buildTransportFromConfig — URL-based servers", () => {
  it("returns StreamableHTTPClientTransport when url is set (default transport)", () => {
    const transport = buildTransportFromConfig({
      url: "http://localhost:3001/mcp",
    });
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("returns StreamableHTTPClientTransport when transport: streamable-http is explicit", () => {
    const transport = buildTransportFromConfig({
      url: "http://localhost:3001/mcp",
      transport: "streamable-http",
    });
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("returns SSEClientTransport when transport: sse is specified", () => {
    const transport = buildTransportFromConfig({
      url: "http://localhost:3001/sse",
      transport: "sse",
    });
    expect(transport).toBeInstanceOf(SSEClientTransport);
  });

  it("does not throw when headers are provided for StreamableHTTP", () => {
    expect(() =>
      buildTransportFromConfig({
        url: "http://localhost:3001/mcp",
        headers: { Authorization: "Bearer tok" },
      })
    ).not.toThrow();
  });

  it("does not throw when headers are provided for SSE", () => {
    expect(() =>
      buildTransportFromConfig({
        url: "http://localhost:3001/sse",
        transport: "sse",
        headers: { "X-Api-Key": "secret" },
      })
    ).not.toThrow();
  });
});

describe("buildTransportFromConfig — stdio servers", () => {
  it("returns StdioClientTransport when command is set", () => {
    const transport = buildTransportFromConfig({
      command: "node",
      args: ["dist/index.js"],
    });
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });

  it("returns StdioClientTransport when command is set with no args", () => {
    const transport = buildTransportFromConfig({
      command: "node",
    });
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });
});
