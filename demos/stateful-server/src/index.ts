// @ts-nocheck
/**
 * Demo stateful MCP server with an in-memory user store.
 * Designed to showcase setup/teardown hooks in CheckSpec.
 *
 * All console output goes to stderr so stdout stays clean for JSON-RPC.
 *
 * Tools:
 *   create_user   — add a user to the store
 *   get_user      — retrieve a user by id
 *   delete_user   — remove a user by id
 *   list_users    — list all users
 *   reset_store   — wipe the entire store (teardown tool)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface User {
  id: string;
  name: string;
  email: string;
}

// In-memory store — shared across all tool calls (per process lifetime)
const store = new Map<string, User>();

const server = new McpServer(
  { name: "demo-stateful-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── create_user ───────────────────────────────────────────────────────────────

server.registerTool(
  "create_user",
  {
    description: "Add a user to the in-memory store",
    inputSchema: {
      id:    z.string().describe("Unique user ID"),
      name:  z.string().describe("Display name"),
      email: z.string().describe("Email address"),
    },
  },
  async ({ id, name, email }) => {
    if (store.has(id)) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "User already exists" }) }],
      };
    }
    const user: User = { id, name, email };
    store.set(id, user);
    process.stderr.write(`[stateful-server] created user ${id}\n`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: true, user }) }],
    };
  }
);

// ── get_user ──────────────────────────────────────────────────────────────────

server.registerTool(
  "get_user",
  {
    description: "Retrieve a user by ID",
    inputSchema: {
      id: z.string().describe("User ID to look up"),
    },
  },
  async ({ id }) => {
    const user = store.get(id);
    if (!user) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Not found" }) }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ user }) }],
    };
  }
);

// ── delete_user ───────────────────────────────────────────────────────────────

server.registerTool(
  "delete_user",
  {
    description: "Remove a user from the store by ID",
    inputSchema: {
      id: z.string().describe("User ID to delete"),
    },
  },
  async ({ id }) => {
    if (!store.has(id)) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Not found" }) }],
      };
    }
    store.delete(id);
    process.stderr.write(`[stateful-server] deleted user ${id}\n`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }],
    };
  }
);

// ── list_users ────────────────────────────────────────────────────────────────

server.registerTool(
  "list_users",
  {
    description: "List all users in the store",
    inputSchema: {},
  },
  async () => {
    const users = Array.from(store.values());
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ users, count: users.length }) }],
    };
  }
);

// ── reset_store ───────────────────────────────────────────────────────────────

server.registerTool(
  "reset_store",
  {
    description: "Wipe the entire user store. Only for testing teardown.",
    inputSchema: {},
  },
  async () => {
    const count = store.size;
    store.clear();
    process.stderr.write(`[stateful-server] store reset (cleared ${count} users)\n`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }],
    };
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
process.stderr.write("[demo-stateful-server] starting\n");
await server.connect(transport);
