/**
 * CheckSpec Demo: Filesystem Server  (intentionally vulnerable)
 *
 * Demonstrates what CheckSpec's security scanner detects in a server that:
 *   1. Uses naive path concatenation (no normalization → path traversal possible)
 *   2. Echoes user-supplied paths in error messages (→ prompt injection passthrough HIGH finding)
 *
 * ⚠️  This server is intentionally insecure for demo/educational purposes.
 *     Do NOT use this pattern in production code.
 *
 * Sandbox: All file operations are (supposed to be) restricted to ./sandbox/
 * Security finding: read_file echoes the path in errors — injection strings pass through.
 *
 * Tools: read_file, write_file, list_directory, delete_file, file_info
 * Resources: filesystem://sandbox, filesystem://stats
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = path.resolve(__dirname, "../sandbox");

/**
 * SECURITY BUG: naive path join without normalization.
 * path.join(SANDBOX_DIR, "../../../etc/passwd") escapes the sandbox.
 * A safe implementation would use path.normalize() and verify the result
 * still starts with SANDBOX_DIR.
 */
function resolvePath(userPath: string): string {
  return path.join(SANDBOX_DIR, userPath);
}

const server = new McpServer(
  { name: "filesystem-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool(
  "read_file",
  {
    description: "Read the text contents of a file from the sandbox directory",
    inputSchema: {
      path: z.string().describe("Relative path to the file within the sandbox"),
    },
  },
  async ({ path: filePath }) => {
    const fullPath = resolvePath(filePath);
    if (!existsSync(fullPath)) {
      // SECURITY ISSUE: echoes user-supplied path back in error message.
      // When the security scanner sends an injection payload as the path,
      // the response echoes it — triggering the HIGH prompt-injection finding.
      return {
        isError: true,
        content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
      };
    }
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Path is a directory, not a file: ${filePath}` }],
        };
      }
      const content = readFileSync(fullPath, "utf-8");
      return { content: [{ type: "text" as const, text: content }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error reading ${filePath}: ${String(err)}` }],
      };
    }
  }
);

server.registerTool(
  "write_file",
  {
    description: "Write text content to a file in the sandbox directory (creates or overwrites)",
    inputSchema: {
      path: z.string().describe("Relative path to the file within the sandbox"),
      content: z.string().describe("Text content to write"),
    },
  },
  async ({ path: filePath, content }) => {
    const fullPath = resolvePath(filePath);
    try {
      writeFileSync(fullPath, content, "utf-8");
      return {
        content: [{ type: "text" as const, text: `File written successfully: ${filePath} (${content.length} bytes)` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error writing ${filePath}: ${String(err)}` }],
      };
    }
  }
);

server.registerTool(
  "list_directory",
  {
    description: "List files and subdirectories in a sandbox directory",
    inputSchema: {
      path: z.string().default("").describe("Relative path to the directory (empty = sandbox root)"),
    },
  },
  async ({ path: dirPath }) => {
    const fullPath = resolvePath(dirPath);
    try {
      const entries = readdirSync(fullPath, { withFileTypes: true });
      const result = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error listing ${dirPath || "sandbox"}: ${String(err)}` }],
      };
    }
  }
);

server.registerTool(
  "delete_file",
  {
    description: "Delete a file from the sandbox directory",
    inputSchema: {
      path: z.string().describe("Relative path to the file to delete"),
    },
  },
  async ({ path: filePath }) => {
    const fullPath = resolvePath(filePath);
    if (!existsSync(fullPath)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
      };
    }
    try {
      unlinkSync(fullPath);
      return {
        content: [{ type: "text" as const, text: `Deleted: ${filePath}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error deleting ${filePath}: ${String(err)}` }],
      };
    }
  }
);

server.registerTool(
  "file_info",
  {
    description: "Get metadata (size, type, modification time) for a file or directory",
    inputSchema: {
      path: z.string().describe("Relative path to the file or directory"),
    },
  },
  async ({ path: filePath }) => {
    const fullPath = resolvePath(filePath);
    if (!existsSync(fullPath)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Path not found: ${filePath}` }],
      };
    }
    try {
      const stat = statSync(fullPath);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              path: filePath,
              type: stat.isDirectory() ? "directory" : "file",
              size: stat.size,
              modified: stat.mtime.toISOString(),
              created: stat.birthtime.toISOString(),
            }),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error reading info for ${filePath}: ${String(err)}` }],
      };
    }
  }
);

// ── Resources ─────────────────────────────────────────────────────────────────

server.registerResource(
  "sandbox",
  "filesystem://sandbox",
  {
    description: "Lists all files and directories in the sandbox",
    mimeType: "application/json",
  },
  async (uri) => {
    const entries = readdirSync(SANDBOX_DIR, { withFileTypes: true });
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "directory" : "file",
            })),
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerResource(
  "stats",
  "filesystem://stats",
  {
    description: "Statistics about the sandbox directory (file count, total size)",
    mimeType: "application/json",
  },
  async (uri) => {
    const entries = readdirSync(SANDBOX_DIR, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    const totalSize = files.reduce((sum, e) => {
      return sum + statSync(path.join(SANDBOX_DIR, e.name)).size;
    }, 0);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            totalFiles: files.length,
            totalDirectories: entries.length - files.length,
            totalSizeBytes: totalSize,
          }),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
