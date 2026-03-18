/**
 * Minimal HTTP-based MCP server fixture using StreamableHTTP transport.
 *
 * Mirrors echo-server capabilities over HTTP on port 3001:
 *
 * Tools:
 *   echo — takes { message: string }, returns the message back
 *
 * Resources:
 *   version — returns { version: "1.0.0", name: "http-server" }
 *
 * Prompts:
 *   greet — takes { name: string }, returns a greeting message
 *
 * Endpoint: POST/GET/DELETE http://localhost:3001/mcp
 * Stateless mode (no session management).
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = 3001;

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "http-server", version: "1.0.0" },
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
          text: JSON.stringify({ version: "1.0.0", name: "http-server" }),
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

  return server;
}

const app = express();
app.use(express.json());

// Single endpoint handles GET (SSE upgrade), POST (requests), and DELETE (session end).
// Stateless mode: a new McpServer + transport pair is created per request.
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  process.stderr.write(`http-server listening on http://localhost:${PORT}/mcp\n`);
});
