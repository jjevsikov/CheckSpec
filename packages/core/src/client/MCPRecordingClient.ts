import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface RecordedMessage {
  direction: "request" | "response";
  method: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  timestamp: number;
  durationMs?: number;
}

/**
 * Wraps the official MCP Client to record all request/response pairs.
 * Use getRecording() to retrieve the full interaction history.
 */
export class MCPRecordingClient {
  private client: Client;
  private recording: RecordedMessage[] = [];

  constructor(private transport: Transport) {
    this.client = new Client(
      { name: "checkspec-recorder", version: "0.1.0" },
      { capabilities: {} }
    );
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async disconnect(): Promise<void> {
    try {
      // For StreamableHTTP transports with an active session, send DELETE
      // to clean up the server-side session before closing.
      const transport = this.transport as any;
      if (typeof transport.terminateSession === 'function') {
        try {
          await transport.terminateSession();
        } catch {
          // Session termination is best-effort; server may already be down
        }
      }
      await this.client.close();
    } catch {
      // Client may not have fully connected — safe to ignore
    }
  }

  async listTools(): Promise<Tool[]> {
    const start = Date.now();
    this.recording.push({
      direction: "request",
      method: "tools/list",
      timestamp: start,
    });
    const result = await this.client.listTools();
    const durationMs = Date.now() - start;
    this.recording.push({
      direction: "response",
      method: "tools/list",
      result,
      timestamp: Date.now(),
      durationMs,
    });
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const start = Date.now();
    const params = { name, arguments: args };
    this.recording.push({
      direction: "request",
      method: "tools/call",
      params,
      timestamp: start,
    });
    try {
      const result = await this.client.callTool(params);
      const durationMs = Date.now() - start;
      this.recording.push({
        direction: "response",
        method: "tools/call",
        result,
        timestamp: Date.now(),
        durationMs,
      });
      return result as CallToolResult;
    } catch (err) {
      const durationMs = Date.now() - start;
      const error =
        err instanceof Error
          ? { code: -1, message: err.message }
          : { code: -1, message: String(err) };
      this.recording.push({
        direction: "response",
        method: "tools/call",
        error,
        timestamp: Date.now(),
        durationMs,
      });
      throw err;
    }
  }

  /**
   * Calls a tool and collects streaming progress notifications.
   * Returns the final CallToolResult plus an ordered list of chunk messages.
   * Uses the SDK's built-in onprogress option which automatically injects
   * _meta.progressToken and routes notifications/progress to the callback.
   */
  async callToolStreaming(
    name: string,
    args: Record<string, unknown>,
    onChunk: (params: { progress: number; total?: number; message?: string; timestamp: number }) => void
  ): Promise<CallToolResult> {
    const start = Date.now();
    const params = { name, arguments: args };
    this.recording.push({
      direction: "request",
      method: "tools/call",
      params,
      timestamp: start,
    });
    try {
      const result = await this.client.callTool(
        params,
        undefined,
        {
          onprogress: (progress) => {
            onChunk({ ...progress, timestamp: Date.now() });
          },
        } as Parameters<typeof this.client.callTool>[2]
      );
      const durationMs = Date.now() - start;
      this.recording.push({
        direction: "response",
        method: "tools/call",
        result,
        timestamp: Date.now(),
        durationMs,
      });
      return result as CallToolResult;
    } catch (err) {
      const durationMs = Date.now() - start;
      const error =
        err instanceof Error
          ? { code: -1, message: err.message }
          : { code: -1, message: String(err) };
      this.recording.push({
        direction: "response",
        method: "tools/call",
        error,
        timestamp: Date.now(),
        durationMs,
      });
      throw err;
    }
  }

  async listResources(): Promise<Resource[]> {
    const start = Date.now();
    this.recording.push({
      direction: "request",
      method: "resources/list",
      timestamp: start,
    });
    const result = await this.client.listResources();
    this.recording.push({
      direction: "response",
      method: "resources/list",
      result,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
    });
    return result.resources;
  }

  async listResourceTemplates(): Promise<ResourceTemplate[]> {
    const start = Date.now();
    this.recording.push({
      direction: "request",
      method: "resources/templates/list",
      timestamp: start,
    });
    const result = await this.client.listResourceTemplates();
    this.recording.push({
      direction: "response",
      method: "resources/templates/list",
      result,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
    });
    return result.resourceTemplates;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const start = Date.now();
    const params = { uri };
    this.recording.push({
      direction: "request",
      method: "resources/read",
      params,
      timestamp: start,
    });
    const result = await this.client.readResource(params);
    const durationMs = Date.now() - start;
    this.recording.push({
      direction: "response",
      method: "resources/read",
      result,
      timestamp: Date.now(),
      durationMs,
    });
    return result;
  }

  async listPrompts(): Promise<Prompt[]> {
    const start = Date.now();
    this.recording.push({
      direction: "request",
      method: "prompts/list",
      timestamp: start,
    });
    const result = await this.client.listPrompts();
    this.recording.push({
      direction: "response",
      method: "prompts/list",
      result,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
    });
    return result.prompts;
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>
  ): Promise<GetPromptResult> {
    const start = Date.now();
    const params = { name, arguments: args };
    this.recording.push({
      direction: "request",
      method: "prompts/get",
      params,
      timestamp: start,
    });
    const result = await this.client.getPrompt(params);
    const durationMs = Date.now() - start;
    this.recording.push({
      direction: "response",
      method: "prompts/get",
      result,
      timestamp: Date.now(),
      durationMs,
    });
    return result;
  }

  getRecording(): RecordedMessage[] {
    return [...this.recording];
  }

  clearRecording(): void {
    this.recording = [];
  }
}
