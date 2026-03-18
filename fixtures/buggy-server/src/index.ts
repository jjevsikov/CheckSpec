/**
 * Intentionally buggy MCP server fixture.
 *
 * Tools:
 *   divide    — divides two numbers; crashes on division by zero (unhandled)
 *   slow-op   — takes 10 seconds to respond (triggers timeout tests)
 *   wrong-schema — returns data that doesn't match its declared output schema
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "buggy-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Tool: divide — intentionally crashes on b=0
server.registerTool(
  "divide",
  {
    description: "Divides two numbers. Warning: crashes on division by zero.",
    inputSchema: {
      a: z.number().describe("The dividend"),
      b: z.number().describe("The divisor"),
    },
  },
  async ({ a, b }) => {
    if (b === 0) {
      // Intentionally unhandled — no try/catch, will throw
      throw new Error("Division by zero");
    }
    return {
      content: [{ type: "text" as const, text: String(a / b) }],
    };
  }
);

// Tool: slow-op — deliberately slow (10 seconds)
server.registerTool(
  "slow-op",
  {
    description: "Takes 10 seconds to complete. Used to test timeout handling.",
    inputSchema: {
      input: z.string().optional().describe("Optional input (ignored)"),
    },
  },
  async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    return {
      content: [{ type: "text" as const, text: "Done (after 10s)" }],
    };
  }
);

// Tool: wrong-schema — returns text but claims to return a number in outputSchema
server.registerTool(
  "wrong-schema",
  {
    description: "Returns data that doesn't match its declared output schema.",
    inputSchema: {
      query: z.string().describe("A query string"),
    },
  },
  async () => {
    // Intentionally returns a string even though caller may expect a number
    return {
      content: [{ type: "text" as const, text: "hello" }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
