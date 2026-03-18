import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRunner, HookAbortError, HookContext } from "@checkspec/core";
import type { HookDefinition } from "@checkspec/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ── Mock MCPRecordingClient ────────────────────────────────────────────────────

function makeOkResult(text = "ok"): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function makeMockClient(callToolImpl?: (tool: string, input: unknown) => Promise<CallToolResult>) {
  return {
    callTool: vi.fn(callToolImpl ?? (async () => makeOkResult())),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    listTools: vi.fn(async () => []),
    listResources: vi.fn(async () => []),
    listPrompts: vi.fn(async () => []),
    getRecording: vi.fn(() => []),
    clearRecording: vi.fn(),
    readResource: vi.fn(async () => ({ contents: [] })),
    getPrompt: vi.fn(async () => ({ messages: [] })),
  } as unknown as import("@checkspec/core").MCPRecordingClient;
}

// ── Test helpers ───────────────────────────────────────────────────────────────

function toolHook(name: string, tool = "ping", opts: Partial<HookDefinition> = {}): HookDefinition {
  return {
    name,
    run: { type: "tool-call", tool, input: {} },
    ...opts,
  };
}

function shellHook(name: string, args: string[] = ["hello"], opts: Partial<HookDefinition> = {}): HookDefinition {
  return {
    name,
    run: { type: "shell", command: "echo", args },
    ...opts,
  };
}

// ── Suite: all passing ─────────────────────────────────────────────────────────

describe("HookRunner — all hooks passing", () => {
  it("returns an array of passing HookResults for tool-call hooks", async () => {
    const client = makeMockClient();
    const runner = new HookRunner(client);

    const hooks: HookDefinition[] = [
      toolHook("hook one"),
      toolHook("hook two"),
    ];

    const results = await runner.runHooks(hooks, "beforeAll");

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("hook one");
    expect(results[0].passed).toBe(true);
    expect(results[0].phase).toBe("beforeAll");
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(results[0].error).toBeUndefined();

    expect(results[1].name).toBe("hook two");
    expect(results[1].passed).toBe(true);
  });

  it("calls callTool with the correct tool name and input", async () => {
    const client = makeMockClient();
    const runner = new HookRunner(client);

    const hooks: HookDefinition[] = [
      {
        name: "create fixture",
        run: { type: "tool-call", tool: "create_user", input: { id: "alice", name: "Alice" } },
      },
    ];

    await runner.runHooks(hooks, "beforeAll");

    expect(client.callTool).toHaveBeenCalledWith("create_user", { id: "alice", name: "Alice" });
  });

  it("calls onResult callback for each hook in order", async () => {
    const client = makeMockClient();
    const runner = new HookRunner(client);

    const hooks = [toolHook("a"), toolHook("b"), toolHook("c")];
    const seen: string[] = [];

    await runner.runHooks(hooks, "beforeEach", (r) => seen.push(r.name));

    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("passes for shell hooks that exit with code 0", async () => {
    const client = makeMockClient();
    const runner = new HookRunner(client);

    const results = await runner.runHooks([shellHook("echo hook")], "afterAll");

    expect(results[0].passed).toBe(true);
    expect(results[0].error).toBeUndefined();
  });
});

// ── Suite: failFast abort ──────────────────────────────────────────────────────

describe("HookRunner — failFast abort", () => {
  it("throws HookAbortError when a failing hook has failFast (setup phase default)", async () => {
    const client = makeMockClient(async () => { throw new Error("DB unreachable"); });
    const runner = new HookRunner(client);

    const hooks = [toolHook("failing setup hook")];

    await expect(runner.runHooks(hooks, "beforeAll")).rejects.toBeInstanceOf(HookAbortError);
  });

  it("HookAbortError message includes hook name and phase", async () => {
    const client = makeMockClient(async () => { throw new Error("boom"); });
    const runner = new HookRunner(client);

    const hooks = [toolHook("my seed hook")];

    await expect(runner.runHooks(hooks, "beforeEach")).rejects.toMatchObject({
      name: "HookAbortError",
      message: expect.stringContaining("my seed hook"),
    });
  });

  it("still calls onResult for the failing hook before throwing", async () => {
    const client = makeMockClient(async () => { throw new Error("oops"); });
    const runner = new HookRunner(client);

    const hooks = [toolHook("bad hook")];
    const seen: Array<{ name: string; passed: boolean }> = [];

    await expect(
      runner.runHooks(hooks, "beforeAll", (r) => seen.push({ name: r.name, passed: r.passed }))
    ).rejects.toBeInstanceOf(HookAbortError);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: "bad hook", passed: false });
  });

  it("stops after the first failFast failure — subsequent hooks are not called", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) throw new Error("first hook fails");
      return makeOkResult();
    });
    const runner = new HookRunner(client);

    const hooks = [toolHook("hook 1"), toolHook("hook 2"), toolHook("hook 3")];

    await expect(runner.runHooks(hooks, "beforeAll")).rejects.toBeInstanceOf(HookAbortError);
    expect(callCount).toBe(1);
  });

  it("does NOT throw when failFast is explicitly false even in setup phase", async () => {
    const client = makeMockClient(async () => { throw new Error("soft fail"); });
    const runner = new HookRunner(client);

    const hooks = [toolHook("optional check", "ping", { failFast: false })];

    const results = await runner.runHooks(hooks, "beforeAll");
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toBe("soft fail");
  });
});

// ── Suite: teardown never throws ───────────────────────────────────────────────

describe("HookRunner — teardown phases never throw", () => {
  it("does NOT throw HookAbortError in afterAll even when a hook fails", async () => {
    const client = makeMockClient(async () => { throw new Error("teardown fail"); });
    const runner = new HookRunner(client);

    const hooks = [toolHook("cleanup hook")];

    const results = await runner.runHooks(hooks, "afterAll");
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toBe("teardown fail");
  });

  it("does NOT throw HookAbortError in afterEach even when a hook fails", async () => {
    const client = makeMockClient(async () => { throw new Error("after-each fail"); });
    const runner = new HookRunner(client);

    const hooks = [toolHook("per-test cleanup")];

    const results = await runner.runHooks(hooks, "afterEach");
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toBeDefined();
  });

  it("runs all teardown hooks even when an earlier one fails", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount === 1) throw new Error("first cleanup fails");
      return makeOkResult();
    });
    const runner = new HookRunner(client);

    const hooks = [
      toolHook("cleanup 1"),
      toolHook("cleanup 2"),
      toolHook("cleanup 3"),
    ];

    const results = await runner.runHooks(hooks, "afterAll");
    expect(callCount).toBe(3);
    expect(results[0].passed).toBe(false);
    expect(results[1].passed).toBe(true);
    expect(results[2].passed).toBe(true);
  });

  it("explicit failFast:true on a teardown hook DOES throw", async () => {
    const client = makeMockClient(async () => { throw new Error("hard fail"); });
    const runner = new HookRunner(client);

    const hooks = [toolHook("hard teardown", "ping", { failFast: true })];

    await expect(runner.runHooks(hooks, "afterAll")).rejects.toBeInstanceOf(HookAbortError);
  });
});

// ── Suite: timeout ─────────────────────────────────────────────────────────────

describe("HookRunner — hook timeout", () => {
  it("fails a tool-call hook that never resolves within timeoutMs", async () => {
    // Never resolves
    const client = makeMockClient(() => new Promise(() => {}));
    const runner = new HookRunner(client);

    const hooks: HookDefinition[] = [
      {
        name: "hanging hook",
        run: { type: "tool-call", tool: "slow_op", input: {} },
        timeoutMs: 50,
        failFast: false, // don't throw HookAbortError, just return the failure
      },
    ];

    const results = await runner.runHooks(hooks, "beforeAll");
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toMatch(/timed out/i);
  }, 10_000);

  it("records timing even for timed-out hooks", async () => {
    const client = makeMockClient(() => new Promise(() => {}));
    const runner = new HookRunner(client);

    const hooks: HookDefinition[] = [
      {
        name: "slow hook",
        run: { type: "tool-call", tool: "slow_op", input: {} },
        timeoutMs: 50,
        failFast: false,
      },
    ];

    const results = await runner.runHooks(hooks, "beforeAll");
    expect(results[0].durationMs).toBeGreaterThanOrEqual(50);
  }, 10_000);
});

// ── Suite: HookAbortError identity ────────────────────────────────────────────

describe("HookAbortError", () => {
  it("has name HookAbortError", () => {
    const err = new HookAbortError("my hook", "beforeAll");
    expect(err.name).toBe("HookAbortError");
  });

  it("is an instanceof Error", () => {
    const err = new HookAbortError("my hook", "beforeAll");
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instanceof HookAbortError", () => {
    const err = new HookAbortError("my hook", "beforeAll");
    expect(err).toBeInstanceOf(HookAbortError);
  });

  it("message references hook name and phase", () => {
    const err = new HookAbortError("seed users", "beforeEach");
    expect(err.message).toContain("seed users");
    expect(err.message).toContain("beforeEach");
  });
});

// ── capture: extract context variables from tool-call results ─────────────

describe("capture: extracts variables from tool-call hook results", () => {
  it("sets a single captured variable on the context", async () => {
    const userJson = JSON.stringify({ success: true, user: { id: "alice-123", name: "Alice" } });
    const client = makeMockClient(async () => makeOkResult(userJson));
    const runner = new HookRunner(client);
    const context = new HookContext();

    const hook: HookDefinition = {
      name: "create user",
      run: { type: "tool-call", tool: "create_user", input: { id: "alice-123" } },
      capture: { userId: "$.user.id" },
    };

    await runner.runHooks([hook], "beforeAll", undefined, context);

    expect(context.has("userId")).toBe(true);
    expect(context.resolve("{{userId}}")).toBe("alice-123");
  });

  it("captures multiple variables from the same hook", async () => {
    const userJson = JSON.stringify({ user: { id: "bob-456", name: "Bob" } });
    const client = makeMockClient(async () => makeOkResult(userJson));
    const runner = new HookRunner(client);
    const context = new HookContext();

    const hook: HookDefinition = {
      name: "create user",
      run: { type: "tool-call", tool: "create_user", input: { id: "bob-456" } },
      capture: { userId: "$.user.id", userName: "$.user.name" },
    };

    await runner.runHooks([hook], "beforeAll", undefined, context);

    expect(context.resolve("{{userId}}")).toBe("bob-456");
    expect(context.resolve("{{userName}}")).toBe("Bob");
  });

  it("does NOT capture when hook fails (error thrown by tool)", async () => {
    const client = makeMockClient(async () => { throw new Error("tool crashed"); });
    const runner = new HookRunner(client);
    const context = new HookContext();

    const hook: HookDefinition = {
      name: "failing hook",
      run: { type: "tool-call", tool: "create_user", input: {} },
      capture: { userId: "$.user.id" },
      failFast: false,
    };

    await runner.runHooks([hook], "beforeAll", undefined, context);

    // Hook failed — no capture applied
    expect(context.has("userId")).toBe(false);
  });

  it("warns and skips when capture path is not found in response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeMockClient(async () => makeOkResult(JSON.stringify({ other: "data" })));
    const runner = new HookRunner(client);
    const context = new HookContext();

    const hook: HookDefinition = {
      name: "hook",
      run: { type: "tool-call", tool: "ping", input: {} },
      capture: { userId: "$.user.id" },
    };

    await runner.runHooks([hook], "beforeAll", undefined, context);

    expect(context.has("userId")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("userId"));
    warnSpy.mockRestore();
  });

  it("resolves {{varName}} placeholders in hook inputs before calling the tool", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const client = makeMockClient(async (tool: string, input: Record<string, unknown>) => {
      capturedInput = input;
      return makeOkResult(JSON.stringify({ ok: true }));
    });
    const runner = new HookRunner(client);
    const context = new HookContext();
    context.set("seededId", "user-from-prev-hook");

    const hook: HookDefinition = {
      name: "use captured id",
      run: { type: "tool-call", tool: "get_user", input: { id: "{{seededId}}" } },
    };

    await runner.runHooks([hook], "beforeEach", undefined, context);

    // The tool should have been called with the resolved value, not the placeholder
    expect(capturedInput).toEqual({ id: "user-from-prev-hook" });
  });

  it("ignores capture on shell hooks (no crash)", async () => {
    const runner = new HookRunner(makeMockClient());
    const context = new HookContext();

    const hook: HookDefinition = {
      name: "shell hook",
      run: { type: "shell", command: "echo", args: ["hello"] },
      // @ts-expect-error — capture on shell hook is not in the TS interface,
      // but the runtime should silently ignore it
      capture: { x: "$.value" },
    };

    // Should not throw
    await expect(runner.runHooks([hook], "beforeAll", undefined, context)).resolves.toBeDefined();
    expect(context.has("x")).toBe(false);
  });
});
