/**
 * CheckSpec Demo: Notes Server  (clean implementation, all tests pass)
 *
 * A well-implemented notes CRUD server. Demonstrates what a fully-passing
 * CheckSpec run looks like: all assertions succeed, no security findings.
 *
 * Seeded data (stable IDs for collection tests):
 *   note_demo_0001 — "Getting Started" note
 *   note_demo_0002 — "Meeting Notes" note
 *
 * Tools: create_note, get_note, list_notes, update_note, delete_note
 * Resources: notes://count, notes://tags
 * Prompts: summarize_notes, new_note_from_topic
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Data type ─────────────────────────────────────────────────────────────────

interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// ── In-memory store with seed data ───────────────────────────────────────────

const notes = new Map<string, Note>([
  [
    "note_demo_0001",
    {
      id: "note_demo_0001",
      title: "Getting Started",
      content:
        "Welcome to the notes server! Use create_note to add new notes, " +
        "list_notes to see everything, and get_note to read a specific note.",
      tags: ["intro", "welcome"],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ],
  [
    "note_demo_0002",
    {
      id: "note_demo_0002",
      title: "Meeting Notes",
      content:
        "Discussed project roadmap for Q1. Key action items:\n" +
        "- Complete authentication refactor\n" +
        "- Write unit tests for API layer\n" +
        "- Schedule user research sessions",
      tags: ["meeting", "action-items", "q1"],
      createdAt: "2024-01-15T09:30:00.000Z",
      updatedAt: "2024-01-15T09:30:00.000Z",
    },
  ],
]);

let noteCounter = 100;

function generateId(): string {
  return `note_${Date.now()}_${(++noteCounter).toString().padStart(3, "0")}`;
}

// ── Server ─────────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "notes-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool(
  "create_note",
  {
    description: "Create a new note with a title, content, and optional tags",
    inputSchema: {
      title: z.string().min(1).describe("Note title"),
      content: z.string().describe("Note body text"),
      tags: z.array(z.string()).default([]).describe("Optional list of tags"),
    },
  },
  async ({ title, content, tags }) => {
    const id = generateId();
    const now = new Date().toISOString();
    const note: Note = { id, title, content, tags, createdAt: now, updatedAt: now };
    notes.set(id, note);
    return { content: [{ type: "text" as const, text: JSON.stringify(note, null, 2) }] };
  }
);

server.registerTool(
  "get_note",
  {
    description: "Retrieve a note by its ID",
    inputSchema: {
      id: z.string().describe("Note ID"),
    },
  },
  async ({ id }) => {
    const note = notes.get(id);
    if (!note) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Note not found` }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(note, null, 2) }] };
  }
);

server.registerTool(
  "list_notes",
  {
    description: "List all notes, optionally filtered by tag",
    inputSchema: {
      tag: z.string().optional().describe("Filter notes by this tag (optional)"),
    },
  },
  async ({ tag }) => {
    let result = Array.from(notes.values());
    if (tag) {
      result = result.filter((n) => n.tags.includes(tag));
    }
    // Return summary (id, title, tags) — not full content — for efficiency
    const summary = result.map((n) => ({
      id: n.id,
      title: n.title,
      tags: n.tags,
      updatedAt: n.updatedAt,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  }
);

server.registerTool(
  "update_note",
  {
    description: "Update a note's title, content, or tags (all fields optional)",
    inputSchema: {
      id: z.string().describe("Note ID to update"),
      title: z.string().optional().describe("New title (optional)"),
      content: z.string().optional().describe("New content (optional)"),
      tags: z.array(z.string()).optional().describe("New tag list (replaces existing tags)"),
    },
  },
  async ({ id, title, content, tags }) => {
    const note = notes.get(id);
    if (!note) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Note not found` }],
      };
    }
    if (title !== undefined) note.title = title;
    if (content !== undefined) note.content = content;
    if (tags !== undefined) note.tags = tags;
    note.updatedAt = new Date().toISOString();
    return { content: [{ type: "text" as const, text: JSON.stringify(note, null, 2) }] };
  }
);

server.registerTool(
  "delete_note",
  {
    description: "Delete a note by ID",
    inputSchema: {
      id: z.string().describe("Note ID to delete"),
    },
  },
  async ({ id }) => {
    if (!notes.has(id)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Note not found` }],
      };
    }
    notes.delete(id);
    return { content: [{ type: "text" as const, text: JSON.stringify({ deleted: id }) }] };
  }
);

// ── Resources ─────────────────────────────────────────────────────────────────

server.registerResource(
  "count",
  "notes://count",
  {
    description: "Total number of notes currently stored",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ count: notes.size }),
      },
    ],
  })
);

server.registerResource(
  "tags",
  "notes://tags",
  {
    description: "All unique tags used across notes, with counts",
    mimeType: "application/json",
  },
  async (uri) => {
    const tagCounts = new Map<string, number>();
    for (const note of notes.values()) {
      for (const tag of note.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const result = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ── Prompts ───────────────────────────────────────────────────────────────────

server.registerPrompt(
  "summarize_notes",
  {
    description: "Generate a prompt asking for a summary of all notes matching a tag",
    argsSchema: {
      tag: z.string().optional().describe("Only summarize notes with this tag (optional)"),
    },
  },
  async ({ tag }) => {
    const allNotes = Array.from(notes.values());
    const filtered = tag ? allNotes.filter((n) => n.tags.includes(tag)) : allNotes;
    const noteList = filtered
      .map((n) => `## ${n.title}\n${n.content}`)
      .join("\n\n---\n\n");
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Please summarize the following ${filtered.length} note(s)` +
              (tag ? ` tagged "${tag}"` : "") +
              `:\n\n${noteList || "(no notes found)"}`,
          },
        },
      ],
    };
  }
);

server.registerPrompt(
  "new_note_from_topic",
  {
    description: "Generate a prompt to help create a structured note on a given topic",
    argsSchema: {
      topic: z.string().describe("The topic to write a note about"),
      style: z
        .enum(["bullet-points", "prose", "outline"])
        .describe("Preferred writing style for the note"),
    },
  },
  async ({ topic, style }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Please write a well-structured note about "${topic}". ` +
            `Use ${style} format. Include key points, context, and any relevant details. ` +
            `The note should be concise but complete.`,
        },
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
