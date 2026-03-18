// @ts-nocheck

/**
 * Minimal valid MCP echo server fixture.
 *
 * Tools:
 *   echo — takes { message: string }, returns the message back
 *
 * Resources:
 *   version — returns { version: "1.0.0" }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "echo-server", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Tool: echo
server.registerTool(
  "echo",
  {
    description: "Echoes the input message back to the caller",
    inputSchema: {
      message: z.string().describe("The message to echo back"),
    },
  },
  async ({ message }) => ({
    content: [{ type: "text" as const, text: message }],
  })
);

// Resource: version
server.registerResource(
  "version",
  "version://info",
  {
    description: "Returns server version information",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ version: "1.0.0", name: "echo-server" }),
      },
    ],
  })
);

// Prompt: greet
server.registerPrompt(
  "greet",
  {
    description: "Generates a greeting message for the given name",
    argsSchema: { name: z.string().describe("The name to greet") },
  },
  async ({ name }) => ({
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: `Hello, ${name}!` },
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
