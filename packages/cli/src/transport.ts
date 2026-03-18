/**
 * Shared transport factory used by scan, test, and inspect commands.
 *
 * Handles:
 *  - Parsing a shell-style command string into [command, ...args]
 *  - Applying --cwd / --env overrides
 *  - Silencing server stderr by default (prevents Python FastMCP log noise)
 *  - Restoring stderr when --verbose is requested
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerConfig } from "@checkspec/core";

export interface TransportOptions {
  /** Working directory for the server process. */
  cwd?: string;
  /** Extra environment variables to merge into the server process env. */
  env?: Record<string, string>;
  /**
   * When true, pass server stderr through to the terminal (inherit).
   * When false (default), suppress server stderr so Python INFO logs don't pollute output.
   */
  verbose?: boolean;
}

/**
 * Split a shell-style command string into [command, ...args].
 * Handles quoted tokens (single or double quotes) and escaped spaces.
 * Simple paths with spaces should be quoted: "uv run 'my server.py'"
 */
export function parseServerCommand(raw: string): [string, string[]] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length && !inSingle) {
      current += raw[++i];
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);

  if (tokens.length === 0) throw new Error("Empty server command");
  const [command, ...args] = tokens;
  return [command, args];
}

/**
 * Build a StdioClientTransport from a command string (parsed via parseServerCommand)
 * or from an already-split command + args pair.
 */
export function buildTransport(
  serverCommand: string,
  opts?: TransportOptions
): StdioClientTransport;
export function buildTransport(
  command: string,
  args: string[],
  opts?: TransportOptions
): StdioClientTransport;
export function buildTransport(
  commandOrServerCommand: string,
  argsOrOpts?: string[] | TransportOptions,
  maybeOpts?: TransportOptions
): StdioClientTransport {
  let command: string;
  let args: string[];
  let opts: TransportOptions;

  if (Array.isArray(argsOrOpts)) {
    command = commandOrServerCommand;
    args = argsOrOpts;
    opts = maybeOpts ?? {};
  } else {
    [command, args] = parseServerCommand(commandOrServerCommand);
    opts = argsOrOpts ?? {};
  }

  const env = opts.env
    ? { ...process.env, ...opts.env } as Record<string, string>
    : undefined;

  return new StdioClientTransport({
    command,
    args,
    cwd: opts.cwd,
    env,
    // Suppress server stderr by default. Python FastMCP and other servers
    // emit verbose INFO logs to stderr that pollute test output. Use --verbose
    // to restore them for debugging.
    stderr: opts.verbose ? "inherit" : "ignore",
  });
}

/**
 * Check whether an error is an MCP connection-closed error (code -32000).
 * This happens when the server process exits before completing the handshake.
 */
export function isConnectionError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: number }).code === -32000;
  }
  return false;
}

/**
 * Print a user-friendly connection failure message and exit with code 1.
 *
 * @param serverCommand  The command string that was used to start the server.
 * @param verbose        Whether --verbose was passed (affects the hint shown).
 */
export function dieWithConnectionError(
  serverCommand: string,
  verbose: boolean
): never {
  console.error(`\nError: Could not connect to MCP server.`);
  console.error(`Command: ${serverCommand}`);
  console.error(
    `\nThe server process exited before completing the MCP handshake. Common causes:`
  );
  console.error(`  • Wrong path — check the command resolves to a real file`);
  console.error(`  • Missing --cwd — uv/python can't find the virtual environment`);
  console.error(`  • Server crashed on startup — run with --verbose to see its output`);
  if (!verbose) {
    console.error(`\nTip: rerun with --verbose to see the server's stderr output.`);
  }
  process.exit(1);
}

/**
 * Build a Transport from a `ServerConfig` object (from a collection file).
 *
 * - When `server.url` is set: returns a StreamableHTTPClientTransport (default)
 *   or SSEClientTransport (when `server.transport === "sse"`).
 * - When `server.command` is set: returns a StdioClientTransport.
 *
 * The `verboseOpts` argument is only applied for stdio transports.
 */
export function buildTransportFromConfig(
  server: ServerConfig,
  verboseOpts?: TransportOptions
): Transport {
  if (server.url) {
    const url = new URL(server.url);
    const requestInit = server.headers
      ? { headers: server.headers as Record<string, string> }
      : undefined;
    const transportType = server.transport ?? "streamable-http";
    if (transportType === "sse") {
      return new SSEClientTransport(url, {
        requestInit,
      });
    }
    return new StreamableHTTPClientTransport(url, {
      requestInit,
    });
  }

  // stdio transport
  return buildTransport(server.command!, server.args ?? [], {
    cwd: server.cwd,
    env: server.env,
    ...verboseOpts,
  });
}

/**
 * Parse KEY=VALUE pairs from an array of --env option strings.
 */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) {
      throw new Error(`Invalid --env value "${pair}". Expected KEY=VALUE format.`);
    }
    result[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return result;
}
