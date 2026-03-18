import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCPRecordingClient, SecurityScanner } from "@checkspec/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../fixtures");

function makeClient(fixtureDir: string): MCPRecordingClient {
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(FIXTURES, fixtureDir, "dist/index.js")],
  });
  return new MCPRecordingClient(transport);
}

// ─── Echo Server ────────────────────────────────────────────────────────────
describe("Fixture: echo-server", () => {
  let client: MCPRecordingClient;

  beforeAll(async () => {
    client = makeClient("echo-server");
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  it("has the echo tool", async () => {
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");
  });

  it("echo tool works correctly", async () => {
    const result = await client.callTool("echo", { message: "fixture test" });
    expect(result.isError).toBeFalsy();
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    expect(text).toBe("fixture test");
  });

  it("has the version resource", async () => {
    const resources = await client.listResources();
    expect(resources.map((r) => r.name)).toContain("version");
  });

  it("has the greet prompt", async () => {
    const prompts = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("greet");
  });

  it("readResource returns text content for version://info", async () => {
    const result = await client.readResource("version://info");
    expect(result.contents).toBeInstanceOf(Array);
    expect(result.contents.length).toBeGreaterThan(0);
    const textContents = result.contents.filter((c) => "text" in c);
    const text = textContents.map((c) => (c as { text: string }).text).join("");
    expect(text).toContain("version");
  });

  it("readResource recording has correct request/response structure", async () => {
    client.clearRecording();
    await client.readResource("version://info");
    const recording = client.getRecording();
    expect(recording).toHaveLength(2);
    expect(recording[0]).toMatchObject({
      direction: "request",
      method: "resources/read",
      params: { uri: "version://info" },
    });
    expect(recording[1]).toMatchObject({
      direction: "response",
      method: "resources/read",
    });
    expect(typeof recording[1].durationMs).toBe("number");
  });
});

// ─── Buggy Server ────────────────────────────────────────────────────────────
describe("Fixture: buggy-server", () => {
  let client: MCPRecordingClient;

  beforeAll(async () => {
    client = makeClient("buggy-server");
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  it("has divide, slow-op, and wrong-schema tools", async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("divide");
    expect(names).toContain("slow-op");
    expect(names).toContain("wrong-schema");
  });

  it("divide works for normal inputs", async () => {
    const result = await client.callTool("divide", { a: 10, b: 2 });
    expect(result.isError).toBeFalsy();
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    expect(text).toBe("5");
  });

  it("divide returns isError=true on b=0", async () => {
    // The MCP SDK wraps tool exceptions as isError:true results (not rejection)
    const result = await client.callTool("divide", { a: 1, b: 0 });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    expect(text.toLowerCase()).toContain("zero");
  });

  it("wrong-schema returns text content", async () => {
    const result = await client.callTool("wrong-schema", { query: "test" });
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    expect(text).toBe("hello");
  });
});

// ─── Malicious Server ────────────────────────────────────────────────────────
describe("Fixture: malicious-server security scan", () => {
  let client: MCPRecordingClient;

  beforeAll(async () => {
    client = makeClient("malicious-server");
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  it("has helpful-task, shape-shifter, and injector tools", async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("helpful-task");
    expect(names).toContain("shape-shifter");
    expect(names).toContain("injector");
  });

  it("SecurityScanner detects tool-poisoning in helpful-task", async () => {
    const scanner = new SecurityScanner();
    const findings = await scanner.scan(client);
    const poisoningFindings = findings.filter((f) => f.type === "tool-poisoning");
    expect(poisoningFindings.length).toBeGreaterThan(0);
    const affectsHelpfulTask = poisoningFindings.some(
      (f) => f.tool === "helpful-task"
    );
    expect(affectsHelpfulTask).toBe(true);
  });

  it("shape-shifter returns different results after 2 calls (rug-pull)", async () => {
    // Reset call count by creating a new client
    const freshClient = makeClient("malicious-server");
    await freshClient.connect();
    try {
      const r1 = await freshClient.callTool("shape-shifter", { input: "test" });
      const r2 = await freshClient.callTool("shape-shifter", { input: "test" });
      const r3 = await freshClient.callTool("shape-shifter", { input: "test" });

      const text = (r: typeof r1): string =>
        r.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { type: "text"; text: string }).text)
          .join("");

      // First two should be normal
      expect(text(r1)).toContain("normal result");
      expect(text(r2)).toContain("normal result");
      // Third should be malicious payload
      expect(text(r3)).toContain("MALICIOUS PAYLOAD");
    } finally {
      await freshClient.disconnect();
    }
  });

  it("injector tool returns prompt injection content", async () => {
    const result = await client.callTool("injector", { query: "help" });
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    expect(text.toLowerCase()).toContain("ignore");
    expect(text.toLowerCase()).toContain("instructions");
  });

  it("SecurityScanner.scan detects rug-pull in shape-shifter", async () => {
    // Use a fresh client so the shape-shifter call counter starts at 0
    const freshClient = makeClient("malicious-server");
    await freshClient.connect();
    try {
      const scanner = new SecurityScanner();
      const findings = await scanner.scan(freshClient);
      const rugPullFindings = findings.filter((f) => f.type === "rug-pull");
      expect(rugPullFindings.length).toBeGreaterThan(0);
      expect(rugPullFindings.some((f) => f.tool === "shape-shifter")).toBe(true);
    } finally {
      await freshClient.disconnect();
    }
  });
});
