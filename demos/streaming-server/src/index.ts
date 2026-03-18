// @ts-nocheck
/**
 * Demo MCP server that showcases streaming progress notifications.
 * All console output goes to stderr so stdout stays clean for JSON-RPC.
 *
 * Tools:
 *   stream_countdown    — counts down from N to 0, one chunk per 200ms
 *   stream_text_chunks  — splits text into fixed-size chunks, 100ms apart
 *   stream_slow_query   — simulates a slow DB query, one row-fetch per 300ms
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "demo-streaming-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Send a progress notification if the caller passed a progressToken.
 * The token is injected automatically by the MCP SDK client when `onprogress`
 * is set — we just echo it back in the notification.
 */
async function sendProgress(
  extra: { sendNotification: (n: unknown) => Promise<void>; _meta?: { progressToken?: string | number } },
  progress: number,
  total: number,
  message: string
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return; // client didn't ask for progress
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress, total, message },
  });
}

// ── Tool: stream_countdown ────────────────────────────────────────────────────

server.registerTool(
  "stream_countdown",
  {
    description:
      "Counts down from the given number to 0, emitting one progress notification per 200ms, then returns 'done'.",
    inputSchema: {
      from: z.number().int().min(1).max(100).describe("Starting number for the countdown"),
    },
  },
  async ({ from }, extra) => {
    for (let i = from; i > 0; i--) {
      await sendProgress(extra, from - i + 1, from, String(i));
      await sleep(200);
    }
    return {
      content: [{ type: "text" as const, text: "done" }],
    };
  }
);

// ── Tool: stream_text_chunks ──────────────────────────────────────────────────

server.registerTool(
  "stream_text_chunks",
  {
    description:
      "Splits the input text into fixed-size chunks and emits each as a progress notification (100ms apart), then returns the full text.",
    inputSchema: {
      text: z.string().min(1).describe("Text to split and stream"),
      chunkSize: z.number().int().min(1).describe("Characters per chunk"),
    },
  },
  async ({ text, chunkSize }, extra) => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    for (let i = 0; i < chunks.length; i++) {
      await sendProgress(extra, i + 1, chunks.length, chunks[i]);
      await sleep(100);
    }
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// ── Tool: stream_slow_query ───────────────────────────────────────────────────

server.registerTool(
  "stream_slow_query",
  {
    description:
      "Simulates a slow database query by emitting one progress notification per row every 300ms, then returns a JSON array of fake records.",
    inputSchema: {
      rows: z.number().int().min(1).max(20).describe("Number of rows to fetch"),
    },
  },
  async ({ rows }, extra) => {
    const records: Array<{ id: number; name: string; value: number }> = [];
    for (let i = 1; i <= rows; i++) {
      await sendProgress(extra, i, rows, `fetching row ${i} of ${rows}`);
      await sleep(300);
      records.push({ id: i, name: `record_${i}`, value: i * 10 });
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(records) }],
    };
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
process.stderr.write("[demo-streaming-server] starting\n");
await server.connect(transport);
