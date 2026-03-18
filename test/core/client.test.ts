import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCPRecordingClient } from "@checkspec/core";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_SERVER = resolve(__dirname, "../../fixtures/echo-server/dist/index.js");

describe("MCPRecordingClient (disconnect resilience)", () => {
  it("disconnect() does not throw when called without connect()", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [ECHO_SERVER],
    });
    const client = new MCPRecordingClient(transport);
    // Must not throw — the guard in disconnect() swallows the SDK error
    await expect(client.disconnect()).resolves.toBeUndefined();
  });
});

describe("MCPRecordingClient (terminateSession on disconnect)", () => {
  it("calls terminateSession before close() when transport has terminateSession", async () => {
    const callOrder: string[] = [];
    const mockTransport: Transport & { terminateSession: () => Promise<void> } = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => { callOrder.push("close"); }),
      send: vi.fn(async () => {}),
      terminateSession: vi.fn(async () => { callOrder.push("terminateSession"); }),
    };

    const client = new MCPRecordingClient(mockTransport);
    await client.disconnect();

    // terminateSession must have been called
    expect(mockTransport.terminateSession).toHaveBeenCalledOnce();
    // terminateSession must have been called before the SDK's close attempt
    expect(callOrder[0]).toBe("terminateSession");
  });

  it("skips terminateSession when transport does not have it (stdio/SSE)", async () => {
    // StdioClientTransport has no terminateSession — disconnect() must not throw
    const transport = new StdioClientTransport({
      command: "node",
      args: ["--version"],
    });
    const client = new MCPRecordingClient(transport);
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it("succeeds even if terminateSession() throws", async () => {
    const mockTransport: Transport & { terminateSession: () => Promise<void> } = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      terminateSession: vi.fn(async () => { throw new Error("network error"); }),
    };

    const client = new MCPRecordingClient(mockTransport);
    // The inner catch must absorb the terminateSession error
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(mockTransport.terminateSession).toHaveBeenCalledOnce();
  });
});

describe("MCPRecordingClient (against echo-server)", () => {
  let client: MCPRecordingClient;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [ECHO_SERVER],
    });
    client = new MCPRecordingClient(transport);
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  it("listTools returns echo tool", async () => {
    const tools = await client.listTools();
    expect(tools).toBeInstanceOf(Array);
    const echoTool = tools.find((t) => t.name === "echo");
    expect(echoTool).toBeDefined();
    expect(echoTool?.inputSchema.properties).toHaveProperty("message");
  });

  it("callTool echo returns the message", async () => {
    const result = await client.callTool("echo", { message: "hello checkspec" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBeInstanceOf(Array);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    expect(text).toBe("hello checkspec");
  });

  it("callTool echo with empty string returns empty string", async () => {
    const result = await client.callTool("echo", { message: "" });
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    expect(text).toBe("");
  });

  it("listResources includes version resource", async () => {
    const resources = await client.listResources();
    expect(resources).toBeInstanceOf(Array);
    const versionResource = resources.find((r) => r.name === "version");
    expect(versionResource).toBeDefined();
    expect(versionResource?.uri).toBe("version://info");
  });

  it("getRecording captures request/response pairs", async () => {
    client.clearRecording();
    await client.callTool("echo", { message: "record-test" });
    const recording = client.getRecording();
    expect(recording.length).toBe(2); // request + response
    expect(recording[0].direction).toBe("request");
    expect(recording[0].method).toBe("tools/call");
    expect(recording[1].direction).toBe("response");
    expect(recording[1].durationMs).toBeDefined();
    expect(typeof recording[1].durationMs).toBe("number");
  });

  it("clearRecording empties the recording", async () => {
    await client.listTools();
    client.clearRecording();
    expect(client.getRecording()).toHaveLength(0);
  });

  it("getRecording returns a copy (mutations don't affect internal state)", async () => {
    client.clearRecording();
    await client.listTools();
    const rec1 = client.getRecording();
    rec1.push({ direction: "request", method: "fake", timestamp: 0 });
    const rec2 = client.getRecording();
    expect(rec2.length).toBeLessThan(rec1.length);
  });

  it("readResource returns contents for version://info", async () => {
    const result = await client.readResource("version://info");
    expect(result).toHaveProperty("contents");
    expect(Array.isArray(result.contents)).toBe(true);
    expect(result.contents.length).toBeGreaterThan(0);
    const textContents = result.contents.filter((c) => "text" in c);
    expect(textContents.length).toBeGreaterThan(0);
    const text = textContents.map((c) => (c as { text: string }).text).join("");
    expect(text).toContain("version");
  });

  it("readResource recording captures request and response with correct fields", async () => {
    client.clearRecording();
    await client.readResource("version://info");
    const recording = client.getRecording();
    expect(recording.length).toBe(2);
    // Request entry
    expect(recording[0].direction).toBe("request");
    expect(recording[0].method).toBe("resources/read");
    expect(recording[0].params).toMatchObject({ uri: "version://info" });
    // Response entry
    expect(recording[1].direction).toBe("response");
    expect(recording[1].method).toBe("resources/read");
    expect(typeof recording[1].durationMs).toBe("number");
    expect(recording[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("getPrompt returns messages for greet prompt", async () => {
    const result = await client.getPrompt("greet", { name: "tester" });
    expect(result).toHaveProperty("messages");
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    // Extract text from all message content
    const text = result.messages
      .filter((m) => m.content.type === "text")
      .map((m) => (m.content as { type: "text"; text: string }).text)
      .join("");
    expect(text).toContain("tester");
  });

  it("getPrompt recording captures request and response with correct fields", async () => {
    client.clearRecording();
    await client.getPrompt("greet", { name: "record-test" });
    const recording = client.getRecording();
    expect(recording.length).toBe(2);
    expect(recording[0].direction).toBe("request");
    expect(recording[0].method).toBe("prompts/get");
    expect(recording[0].params).toMatchObject({ name: "greet" });
    expect(recording[1].direction).toBe("response");
    expect(recording[1].method).toBe("prompts/get");
    expect(typeof recording[1].durationMs).toBe("number");
  });

  it("listResourceTemplates returns an array (echo-server has none)", async () => {
    // echo-server doesn't register any resource templates, but the method
    // should succeed and return an empty array.
    const templates = await client.listResourceTemplates();
    expect(Array.isArray(templates)).toBe(true);
  });

  it("listResourceTemplates recording captures request and response", async () => {
    client.clearRecording();
    await client.listResourceTemplates();
    const recording = client.getRecording();
    expect(recording.length).toBe(2);
    expect(recording[0].direction).toBe("request");
    expect(recording[0].method).toBe("resources/templates/list");
    expect(recording[1].direction).toBe("response");
    expect(recording[1].method).toBe("resources/templates/list");
    expect(typeof recording[1].durationMs).toBe("number");
  });
});
