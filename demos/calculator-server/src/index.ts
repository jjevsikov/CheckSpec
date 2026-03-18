/**
 * CheckSpec Demo: Calculator Server
 *
 * A clean, well-behaved MCP server demonstrating what a passing CheckSpec scan
 * looks like. All tools are correctly implemented; security scan finds nothing.
 *
 * Tools: add, subtract, multiply, divide, power, percentage
 * Resources: calculator://history (last 10 operations)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "calculator-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

interface HistoryEntry {
  op: string;
  a: number;
  b: number;
  result: number;
  timestamp: string;
}

const history: HistoryEntry[] = [];

function record(op: string, a: number, b: number, result: number): void {
  history.push({ op, a, b, result, timestamp: new Date().toISOString() });
  if (history.length > 100) history.shift();
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool(
  "add",
  {
    description: "Add two numbers together",
    inputSchema: {
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    },
  },
  async ({ a, b }) => {
    const result = a + b;
    record("add", a, b, result);
    return { content: [{ type: "text" as const, text: JSON.stringify({ result }) }] };
  }
);

server.registerTool(
  "subtract",
  {
    description: "Subtract the second number from the first",
    inputSchema: {
      a: z.number().describe("Number to subtract from"),
      b: z.number().describe("Number to subtract"),
    },
  },
  async ({ a, b }) => {
    const result = a - b;
    record("subtract", a, b, result);
    return { content: [{ type: "text" as const, text: JSON.stringify({ result }) }] };
  }
);

server.registerTool(
  "multiply",
  {
    description: "Multiply two numbers together",
    inputSchema: {
      a: z.number().describe("First factor"),
      b: z.number().describe("Second factor"),
    },
  },
  async ({ a, b }) => {
    const result = a * b;
    record("multiply", a, b, result);
    return { content: [{ type: "text" as const, text: JSON.stringify({ result }) }] };
  }
);

server.registerTool(
  "divide",
  {
    description: "Divide the first number by the second. Returns an error if dividing by zero.",
    inputSchema: {
      a: z.number().describe("Dividend"),
      b: z.number().describe("Divisor (must not be zero)"),
    },
  },
  async ({ a, b }) => {
    if (b === 0) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "Division by zero is not allowed" }],
      };
    }
    const result = a / b;
    record("divide", a, b, result);
    return { content: [{ type: "text" as const, text: JSON.stringify({ result }) }] };
  }
);

server.registerTool(
  "power",
  {
    description: "Raise a base number to an exponent (base^exp)",
    inputSchema: {
      base: z.number().describe("The base number"),
      exp: z.number().describe("The exponent"),
    },
  },
  async ({ base, exp }) => {
    const result = Math.pow(base, exp);
    record("power", base, exp, result);
    return { content: [{ type: "text" as const, text: JSON.stringify({ result }) }] };
  }
);

server.registerTool(
  "percentage",
  {
    description:
      "Calculate what percentage 'value' is of 'total'. Returns an error if total is zero.",
    inputSchema: {
      value: z.number().describe("The part value"),
      total: z.number().describe("The whole value (must not be zero)"),
    },
  },
  async ({ value, total }) => {
    if (total === 0) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "Cannot calculate percentage of zero total" }],
      };
    }
    const result = (value / total) * 100;
    record("percentage", value, total, result);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ result, formatted: `${result.toFixed(2)}%` }) }],
    };
  }
);

// ── Resources ─────────────────────────────────────────────────────────────────

server.registerResource(
  "history",
  "calculator://history",
  {
    description: "The last 10 calculator operations performed in this session",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(history.slice(-10), null, 2),
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
