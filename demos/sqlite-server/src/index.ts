/**
 * CheckSpec Demo: SQLite Server  (intentionally vulnerable — educational)
 *
 * Uses real SQLite via sql.js (WebAssembly) — authentic SQL semantics with
 * full support for JOINs, ORDER BY, GROUP BY, aggregates, and subqueries.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  SECURITY FINDINGS EXPECTED                                             │
 * │  query tool — HIGH: prompt injection passthrough                        │
 * │    The error handler echoes the full SQL string verbatim.               │
 * │    When CheckSpec's scanner sends an injection payload as the `sql`        │
 * │    argument, the server reflects it in the error response, triggering   │
 * │    the finding. This is realistic: many DB-proxy servers do this.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  SECURE PATTERNS (demonstrated by the other tools)                     │
 * │  create_table — validates identifiers, no user data in errors           │
 * │  insert_row   — :named parameterized queries (true SQL binding)         │
 * │  update_rows  — SET values are parameterized; identifier validated      │
 * │  delete_rows  — identifier validated; no SQL echo in errors             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * DATABASE
 *   In-memory SQLite loaded at startup from seed.sql.
 *   Tables: users (4 rows), products (5 rows), orders (4 rows).
 *
 * TOOLS
 *   list_tables   — enumerate tables with column info and row counts
 *   query         — raw SQL execution (VULNERABLE: echoes SQL in errors)
 *   create_table  — structured DDL (safe)
 *   insert_row    — parameterized insert (safe)
 *   update_rows   — parameterized SET with user-supplied WHERE (safe values)
 *   delete_rows   — safe delete with identifier validation
 *
 * RESOURCES
 *   db://schema   — full schema as JSON (PRAGMA table_info for each table)
 *
 * WHY THIS IS A USEFUL DEMO
 *   Shows a realistic MCP server that wraps a database. The `query` tool is
 *   intentionally dangerous to illustrate what CheckSpec's security scanner
 *   catches. The other tools show the safer pattern: structured inputs,
 *   parameterized queries, and generic error messages.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// ── sql.js bootstrap ──────────────────────────────────────────────────────────
//
// sql.js is a CommonJS (CJS) module built from Emscripten-compiled SQLite.
// In an ESM package ("type": "module") we load it via createRequire — the
// standard Node.js pattern for ESM→CJS interop.
//
// We resolve the WASM binary path explicitly so that Node.js never has to
// guess where sql-wasm.wasm lives relative to the loaded module.

const _require = createRequire(import.meta.url);

// Inline types for the subset of the sql.js API we use.
// (The full @types/sql.js types reference @types/emscripten which pulls in
// the EmscriptenModule interface — using inline types avoids that complexity
// while keeping the code fully type-safe for our usage.)
type SqlValue   = number | string | null;
type BindParams = SqlValue[] | Record<string, SqlValue> | null;
type QueryExecResult = { columns: string[]; values: SqlValue[][] };

interface Database {
  exec(sql: string): QueryExecResult[];
  run(sql: string, params?: BindParams): Database;
  getRowsModified(): number;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Buffer | null) => Database;
}

type InitFn = (cfg: { wasmBinary: Buffer }) => Promise<SqlJsStatic>;

// Locate the WASM binary that pairs with the Node.js entry point.
// sql.js exports do NOT include "./package.json", so we resolve the main
// entry (sql.js/dist/sql-wasm.js) and then load sql-wasm.wasm from the
// same directory — guaranteed to be co-located by the package layout.
const sqlJsEntry = _require.resolve("sql.js");           // → .../sql.js/dist/sql-wasm.js
const sqlJsDir   = path.dirname(sqlJsEntry);             // → .../sql.js/dist/
const wasmBinary  = readFileSync(path.join(sqlJsDir, "sql-wasm.wasm"));

const initSqlJs = _require("sql.js") as InitFn;
const SQL = await initSqlJs({ wasmBinary });
const db: Database = new SQL.Database();

// ── Seed database ─────────────────────────────────────────────────────────────
// Seed from the bundled seed.sql file. The compiled dist/index.js sits one
// directory below the project root, so seed.sql is one level up.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedSql   = readFileSync(path.join(__dirname, "..", "seed.sql"), "utf-8");
db.exec(seedSql);

// ── Helper: convert QueryExecResult rows to plain objects ─────────────────────
type RowObject = Record<string, SqlValue>;

function resultToObjects(results: QueryExecResult[]): RowObject[] {
  if (results.length === 0) return [];
  const { columns, values } = results[0];
  return values.map((row) => {
    const obj: RowObject = {};
    columns.forEach((col, i) => { obj[col] = row[i] ?? null; });
    return obj;
  });
}

// ── Identifier validation (prevent SQL injection via DDL identifiers) ──────────
const VALID_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateIdent(value: string, kind: string): string | null {
  return VALID_IDENT.test(value) ? null : `Invalid ${kind}: "${value}"`;
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer(
  { name: "sqlite-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// ── Tool: list_tables ─────────────────────────────────────────────────────────
// Lists all user tables with their column schema (from PRAGMA table_info) and
// current row counts. This tool is safe: it never echoes user input.
server.registerTool(
  "list_tables",
  {
    description:
      "List all tables in the database with column definitions and row counts.",
    inputSchema: {},
  },
  async () => {
    const tableRows = db.exec(`
      SELECT name
      FROM   sqlite_master
      WHERE  type = 'table'
      AND    name NOT LIKE 'sqlite_%'
      ORDER  BY name
    `);

    const tableNames = resultToObjects(tableRows).map((r) => r["name"] as string);

    const tables = tableNames.map((name) => {
      const countResult = db.exec(`SELECT COUNT(*) AS n FROM "${name}"`);
      const rowCount    = (countResult[0]?.values[0]?.[0] ?? 0) as number;

      const infoResult = db.exec(`PRAGMA table_info("${name}")`);
      const columns    = resultToObjects(infoResult).map((r) => ({
        name:       r["name"] as string,
        type:       r["type"] as string,
        primaryKey: r["pk"]     === 1,
        nullable:   r["notnull"] === 0,
      }));

      return { table: name, rowCount, columns };
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(tables, null, 2) }],
    };
  }
);

// ── Tool: query ───────────────────────────────────────────────────────────────
// Executes arbitrary SQL and returns results as JSON.
//
// ⚠ INTENTIONAL VULNERABILITY: the error handler reflects the full SQL string
// back to the caller. When CheckSpec's security scanner submits an injection
// payload (e.g. "Ignore all previous instructions…"), the server echoes it in
// the error message, which the scanner recognises as a HIGH finding.
//
// In a production server you would return a generic error such as:
//   "SQL execution failed — check your query syntax"
// Never reflect user-supplied strings in error messages.
server.registerTool(
  "query",
  {
    description:
      "Execute a raw SQL query against the database and return the results as " +
      "a JSON array. Supports SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, " +
      "and any other valid SQLite statement.",
    inputSchema: {
      sql: z.string().describe("The SQL statement to execute"),
    },
  },
  async ({ sql }) => {
    try {
      const results = db.exec(sql);

      // For DML statements exec() returns an empty array; report rows modified.
      if (results.length === 0) {
        const rowsModified = db.getRowsModified();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ rowsModified }),
          }],
        };
      }

      const rows = resultToObjects(results);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
      };
    } catch (err) {
      // ⚠ SECURITY ISSUE: `sql` (user input) echoed verbatim in the error.
      // This is the pattern CheckSpec's prompt-injection check detects.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `SQL error while executing "${sql}": ${msg}`,
        }],
      };
    }
  }
);

// ── Tool: create_table ────────────────────────────────────────────────────────
// Accepts a structured column definition and generates a CREATE TABLE statement.
// Safe: table and column names are validated against an identifier allowlist,
// and error messages never echo user data.
server.registerTool(
  "create_table",
  {
    description:
      "Create a new table in the database. Accepts structured column definitions " +
      "instead of raw SQL to prevent injection.",
    inputSchema: {
      name: z.string().describe("Table name (alphanumeric + underscore)"),
      columns: z
        .array(
          z.object({
            name:       z.string().describe("Column name"),
            type:       z.enum(["TEXT", "INTEGER", "REAL", "BLOB"]).describe("SQLite column type"),
            primaryKey: z.boolean().default(false).describe("Whether this is the primary key"),
            nullable:   z.boolean().default(true).describe("Whether NULLs are allowed"),
          })
        )
        .min(1)
        .describe("Column definitions"),
    },
  },
  async ({ name, columns }) => {
    // Validate table identifier
    const tableErr = validateIdent(name, "table name");
    if (tableErr) {
      return { isError: true, content: [{ type: "text" as const, text: tableErr }] };
    }

    // Validate each column identifier
    for (const col of columns) {
      const colErr = validateIdent(col.name, "column name");
      if (colErr) {
        return { isError: true, content: [{ type: "text" as const, text: colErr }] };
      }
    }

    const colDefs = columns
      .map((c) => {
        let def = `${c.name} ${c.type}`;
        if (c.primaryKey)             def += " PRIMARY KEY";
        if (!c.nullable && !c.primaryKey) def += " NOT NULL";
        return def;
      })
      .join(", ");

    try {
      db.run(`CREATE TABLE IF NOT EXISTS ${name} (${colDefs})`);
      return {
        content: [{
          type: "text" as const,
          text: `Table "${name}" created successfully`,
        }],
      };
    } catch (err) {
      // Generic error — does NOT echo user-supplied data
      const msg = err instanceof Error ? err.message : "unknown error";
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to create table: ${msg}` }],
      };
    }
  }
);

// ── Tool: insert_row ──────────────────────────────────────────────────────────
// Inserts a row using :named parameterized queries — data values are never
// interpolated into the SQL string. This is the correct, safe pattern.
server.registerTool(
  "insert_row",
  {
    description:
      "Insert a single row into a table. Uses parameterized queries — " +
      "data values are bound separately and never interpolated into SQL.",
    inputSchema: {
      table: z.string().describe("Target table name"),
      data:  z
        .record(z.union([z.string(), z.number(), z.null()]))
        .describe("Column → value map for the new row"),
    },
  },
  async ({ table, data }) => {
    const tableErr = validateIdent(table, "table name");
    if (tableErr) {
      return { isError: true, content: [{ type: "text" as const, text: tableErr }] };
    }

    const columns = Object.keys(data);
    if (columns.length === 0) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "No columns provided" }],
      };
    }

    // Validate column identifiers
    for (const col of columns) {
      const colErr = validateIdent(col, "column name");
      if (colErr) {
        return { isError: true, content: [{ type: "text" as const, text: colErr }] };
      }
    }

    // Build parameterized INSERT: INSERT INTO t (a, b) VALUES (:a, :b)
    const colList   = columns.join(", ");
    const paramList = columns.map((c) => `:${c}`).join(", ");
    const sql       = `INSERT INTO ${table} (${colList}) VALUES (${paramList})`;

    // Build named parameter object: { ":a": val_a, ":b": val_b }
    const params: Record<string, SqlValue> = {};
    for (const [col, val] of Object.entries(data)) {
      params[`:${col}`] = val as SqlValue;
    }

    try {
      db.run(sql, params);
      const rowsModified = db.getRowsModified();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ inserted: rowsModified === 1, rowsModified }),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Insert failed: ${msg}` }],
      };
    }
  }
);

// ── Tool: update_rows ─────────────────────────────────────────────────────────
// Updates rows using parameterized SET values. The table name and column names
// are validated against an identifier allowlist. The WHERE clause is user-
// supplied text, which is a secondary limitation of this structured API.
server.registerTool(
  "update_rows",
  {
    description:
      "Update rows in a table. SET values are parameterized for safety. " +
      "The WHERE clause is a raw SQL expression (use column = value syntax).",
    inputSchema: {
      table: z.string().describe("Table name"),
      set:   z
        .record(z.union([z.string(), z.number(), z.null()]))
        .describe("Columns and their new values"),
      where: z.string().describe("SQL WHERE condition, e.g. \"id = 1\""),
    },
  },
  async ({ table, set, where }) => {
    const tableErr = validateIdent(table, "table name");
    if (tableErr) {
      return { isError: true, content: [{ type: "text" as const, text: tableErr }] };
    }

    const params: Record<string, SqlValue> = {};
    const setClauses: string[] = [];

    for (const [col, val] of Object.entries(set)) {
      const colErr = validateIdent(col, "column name");
      if (colErr) {
        return { isError: true, content: [{ type: "text" as const, text: colErr }] };
      }
      const paramName = `:set_${col}`;
      params[paramName] = val as SqlValue;
      setClauses.push(`${col} = ${paramName}`);
    }

    if (setClauses.length === 0) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "No columns to update" }],
      };
    }

    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} WHERE ${where}`;

    try {
      db.run(sql, params);
      const rowsModified = db.getRowsModified();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ updated: true, rowsModified }),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Update failed: ${msg}` }],
      };
    }
  }
);

// ── Tool: delete_rows ─────────────────────────────────────────────────────────
// Deletes rows matching a WHERE condition. Table name is validated.
// Error messages are generic — no user data reflected.
server.registerTool(
  "delete_rows",
  {
    description:
      "Delete rows from a table matching a WHERE condition. " +
      "Table name is validated; error messages do not echo user input.",
    inputSchema: {
      table: z.string().describe("Table name"),
      where: z.string().describe("SQL WHERE condition, e.g. \"id = 1\""),
    },
  },
  async ({ table, where }) => {
    const tableErr = validateIdent(table, "table name");
    if (tableErr) {
      return { isError: true, content: [{ type: "text" as const, text: tableErr }] };
    }

    const sql = `DELETE FROM ${table} WHERE ${where}`;

    try {
      db.run(sql);
      const rowsModified = db.getRowsModified();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ deleted: true, rowsModified }),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Delete failed: ${msg}` }],
      };
    }
  }
);

// ── Resource: db://schema ─────────────────────────────────────────────────────
// Returns the complete database schema: for each table the original CREATE
// TABLE DDL plus detailed column info from PRAGMA table_info.
server.registerResource(
  "schema",
  "db://schema",
  {
    description:
      "Full schema of all user tables — DDL and column details (type, " +
      "nullability, primary key) as returned by PRAGMA table_info.",
    mimeType: "application/json",
  },
  async (uri) => {
    const masterRows = db.exec(`
      SELECT name, sql
      FROM   sqlite_master
      WHERE  type = 'table'
      AND    name NOT LIKE 'sqlite_%'
      ORDER  BY name
    `);

    const schema = resultToObjects(masterRows).map(({ name, sql }) => {
      const tableName = name as string;
      const infoResult = db.exec(`PRAGMA table_info("${tableName}")`);
      const columns = resultToObjects(infoResult).map((r) => ({
        cid:       r["cid"],
        name:      r["name"],
        type:      r["type"],
        notNull:   r["notnull"] === 1,
        dfltValue: r["dflt_value"],
        pk:        r["pk"] === 1,
      }));
      return { table: tableName, ddl: sql, columns };
    });

    return {
      contents: [{
        uri:      uri.href,
        mimeType: "application/json",
        text:     JSON.stringify(schema, null, 2),
      }],
    };
  }
);

// ── Start server ──────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
