import { spawn } from "child_process";
import type { MCPRecordingClient } from "../client/MCPRecordingClient.js";
import type { HookDefinition } from "../runner/TestCollection.js";
import { HookContext } from "./HookContext.js";

export interface HookResult {
  name: string;
  phase: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Thrown by runHooks() when a failFast hook fails.
 * Use instanceof to distinguish it from unexpected errors.
 */
export class HookAbortError extends Error {
  constructor(hookName: string, phase: string) {
    super(`Hook "${hookName}" failed in phase "${phase}" — aborting suite`);
    this.name = "HookAbortError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HookRunner {
  constructor(private client: MCPRecordingClient) {}

  /**
   * Runs a list of hooks in order.
   *
   * - For each hook that completes, calls onResult immediately so the caller
   *   can stream output in real-time.
   * - If a hook fails and failFast is true (default: true for setup phases),
   *   throws HookAbortError after calling onResult for the failed hook.
   * - Teardown phases (afterAll/afterEach) default failFast to false —
   *   all hooks run regardless of individual failures.
   * - `context` is optional: when provided, tool-call hooks with `capture`
   *   will extract variables from their JSON response into the context.
   *   Hook inputs containing `{{varName}}` placeholders are also resolved
   *   before the hook runs.
   */
  async runHooks(
    hooks: HookDefinition[],
    phase: "beforeAll" | "afterAll" | "beforeEach" | "afterEach",
    onResult?: (result: HookResult) => void,
    context?: HookContext
  ): Promise<HookResult[]> {
    const isTeardown = phase === "afterAll" || phase === "afterEach";
    const results: HookResult[] = [];

    for (const hook of hooks) {
      const failFast = hook.failFast ?? !isTeardown;
      const result = await this.runSingleHook(hook, phase, context);
      results.push(result);
      onResult?.(result);

      if (!result.passed && failFast) {
        throw new HookAbortError(hook.name, phase);
      }
    }

    return results;
  }

  private async runSingleHook(
    hook: HookDefinition,
    phase: string,
    context?: HookContext
  ): Promise<HookResult> {
    const start = Date.now();
    const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      if (hook.run.type === "tool-call") {
        // Resolve {{varName}} placeholders in the hook input before calling the tool.
        const resolvedInput = context
          ? (context.resolve(hook.run.input) as Record<string, unknown>)
          : hook.run.input;
        const callResult = await this.runToolCallHook(hook.run.tool, resolvedInput, timeoutMs);
        // Apply capture only on success (we're in the try block)
        if (context && hook.capture) {
          applyCapture(callResult, hook.capture, context);
        }
      } else {
        await runShellHook(hook.run.command, hook.run.args ?? [], timeoutMs);
      }
      return { name: hook.name, phase, passed: true, durationMs: Date.now() - start };
    } catch (err) {
      return {
        name: hook.name,
        phase,
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async runToolCallHook(
    tool: string,
    input: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    // Returns the raw CallToolResult for capture extraction.
    // Tool hooks only check for transport-level errors, not business logic —
    // if the MCP call completed (even with isError:true), the hook passed.
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      handle = setTimeout(
        () => reject(new Error(`Hook timed out after ${timeoutMs}ms (${tool})`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([
        this.client.callTool(tool, input),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(handle);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts variables from a tool-call result and stores them in the context.
 * The result must have a text content item whose value is valid JSON.
 * Warns (but does not throw) when a path resolves to nothing.
 */
function applyCapture(
  result: unknown,
  capture: Record<string, string>,
  context: HookContext
): void {
  if (!result || typeof result !== "object") return;

  const { content } = result as { content?: unknown[] };
  if (!Array.isArray(content)) return;

  const textItem = content.find(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" && c !== null &&
      (c as { type?: string }).type === "text" &&
      typeof (c as { text?: string }).text === "string"
  );
  if (!textItem) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(textItem.text);
  } catch {
    console.warn("[HookContext] capture: tool response is not valid JSON — skipping capture");
    return;
  }

  for (const [varName, path] of Object.entries(capture)) {
    const value = HookContext.extractValue(parsed, path);
    if (value !== undefined) {
      context.set(varName, value);
    } else {
      console.warn(
        `[HookContext] capture: path "${path}" not found in response — "{{${varName}}}" not set`
      );
    }
  }
}

function runShellHook(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

    let sigkillHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      // Escalate to SIGKILL if SIGTERM doesn't work within 1s
      sigkillHandle = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 1_000);
      reject(new Error(`Hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (sigkillHandle) clearTimeout(sigkillHandle);
      if (code === 0) {
        resolve();
      } else {
        const snippet = output.slice(0, 500);
        reject(new Error(`Shell command exited with code ${code}${snippet ? `. Output: ${snippet}` : ""}`));
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      reject(err);
    });
  });
}
