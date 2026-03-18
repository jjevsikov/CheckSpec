/**
 * Unit tests for HookContext — variable storage, template resolution, and
 * JSONPath-like value extraction.
 *
 * No live server required.
 * Run: ./node_modules/.bin/vitest run test/core/hook-context.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookContext } from "../../packages/core/src/hooks/HookContext.js";

// ── set / has ─────────────────────────────────────────────────────────────

describe("set and has", () => {
  it("has() returns false for an unset variable", () => {
    const ctx = new HookContext();
    expect(ctx.has("userId")).toBe(false);
  });

  it("has() returns true after set()", () => {
    const ctx = new HookContext();
    ctx.set("userId", "alice-123");
    expect(ctx.has("userId")).toBe(true);
  });

  it("set() overwrites an existing variable", () => {
    const ctx = new HookContext();
    ctx.set("x", "first");
    ctx.set("x", "second");
    expect(ctx.resolve("{{x}}")).toBe("second");
  });
});

// ── resolve: strings ──────────────────────────────────────────────────────

describe("resolve: strings", () => {
  let ctx: HookContext;
  beforeEach(() => {
    ctx = new HookContext();
    ctx.set("userId", "alice-123");
    ctx.set("name", "Alice");
  });

  it("resolves a single placeholder", () => {
    expect(ctx.resolve("{{userId}}")).toBe("alice-123");
  });

  it("resolves multiple different placeholders in one string", () => {
    expect(ctx.resolve("id={{userId}}, name={{name}}")).toBe("id=alice-123, name=Alice");
  });

  it("resolves the same placeholder appearing twice", () => {
    expect(ctx.resolve("{{userId}}-{{userId}}")).toBe("alice-123-alice-123");
  });

  it("leaves text without placeholders unchanged", () => {
    expect(ctx.resolve("hello world")).toBe("hello world");
  });

  it("warns once and preserves unknown placeholders", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = ctx.resolve("{{missing}}-{{missing}}");
    expect(result).toBe("{{missing}}-{{missing}}");
    // Warned exactly once (not twice — deduped per resolve() call)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("missing");
    warnSpy.mockRestore();
  });
});

// ── resolve: fast path when no vars ───────────────────────────────────────

describe("resolve: fast path when no variables are captured", () => {
  it("returns the same reference when no variables are captured", () => {
    const ctx = new HookContext();
    const input = { id: "test", nested: { a: 1 } };
    expect(ctx.resolve(input)).toBe(input); // same reference, not a clone
  });

  it("returns same reference for string when no variables are captured", () => {
    const ctx = new HookContext();
    const s = "hello world";
    expect(ctx.resolve(s)).toBe(s);
  });
});

// ── resolve: primitives pass through ──────────────────────────────────────

describe("resolve: non-string primitives pass through unchanged", () => {
  const ctx = new HookContext();

  it("numbers", () => { expect(ctx.resolve(42)).toBe(42); });
  it("booleans", () => { expect(ctx.resolve(true)).toBe(true); });
  it("null", () => { expect(ctx.resolve(null)).toBeNull(); });
  it("undefined", () => { expect(ctx.resolve(undefined)).toBeUndefined(); });
});

// ── resolve: objects and arrays ───────────────────────────────────────────

describe("resolve: objects and arrays", () => {
  let ctx: HookContext;
  beforeEach(() => {
    ctx = new HookContext();
    ctx.set("id", "u1");
    ctx.set("label", "Admin");
  });

  it("resolves placeholders in object string values", () => {
    const result = ctx.resolve({ userId: "{{id}}", role: "{{label}}" });
    expect(result).toEqual({ userId: "u1", role: "Admin" });
  });

  it("preserves non-string object values unchanged", () => {
    const result = ctx.resolve({ count: 5, active: true, data: null });
    expect(result).toEqual({ count: 5, active: true, data: null });
  });

  it("resolves placeholders in nested objects", () => {
    const result = ctx.resolve({ outer: { inner: "{{id}}" } });
    expect(result).toEqual({ outer: { inner: "u1" } });
  });

  it("resolves placeholders in arrays", () => {
    const result = ctx.resolve(["{{id}}", "{{label}}", 99]);
    expect(result).toEqual(["u1", "Admin", 99]);
  });

  it("resolves placeholders in mixed nested structure", () => {
    const result = ctx.resolve({
      ids: ["{{id}}", "static"],
      meta: { label: "{{label}}", count: 3 },
    });
    expect(result).toEqual({
      ids: ["u1", "static"],
      meta: { label: "Admin", count: 3 },
    });
  });

  it("does not mutate the original object", () => {
    const original = { id: "{{id}}" };
    ctx.resolve(original);
    expect(original).toEqual({ id: "{{id}}" });
  });
});

// ── extractValue ──────────────────────────────────────────────────────────

describe("HookContext.extractValue", () => {
  const json = {
    id: "alice-123",
    name: "Alice",
    count: 42,
    active: true,
    nested: { role: "admin", level: 2 },
    arr: [1, 2, 3],
  };

  it("extracts a top-level string field", () => {
    expect(HookContext.extractValue(json, "$.id")).toBe("alice-123");
  });

  it("extracts a top-level number field (as string)", () => {
    expect(HookContext.extractValue(json, "$.count")).toBe("42");
  });

  it("extracts a top-level boolean field (as string)", () => {
    expect(HookContext.extractValue(json, "$.active")).toBe("true");
  });

  it("extracts a nested string field", () => {
    expect(HookContext.extractValue(json, "$.nested.role")).toBe("admin");
  });

  it("extracts a nested number field", () => {
    expect(HookContext.extractValue(json, "$.nested.level")).toBe("2");
  });

  it("returns JSON string for object values", () => {
    const result = HookContext.extractValue(json, "$.nested");
    expect(result).toBe(JSON.stringify(json.nested));
  });

  it("returns JSON string for array values", () => {
    const result = HookContext.extractValue(json, "$.arr");
    expect(result).toBe(JSON.stringify(json.arr));
  });

  it("returns undefined for a missing top-level field", () => {
    expect(HookContext.extractValue(json, "$.missing")).toBeUndefined();
  });

  it("returns undefined for a missing nested field", () => {
    expect(HookContext.extractValue(json, "$.nested.missing")).toBeUndefined();
  });

  it("returns undefined when path does not start with '$.'", () => {
    expect(HookContext.extractValue(json, "id")).toBeUndefined();
    expect(HookContext.extractValue(json, "$id")).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(HookContext.extractValue("not an object", "$.id")).toBeUndefined();
    expect(HookContext.extractValue(42, "$.id")).toBeUndefined();
    expect(HookContext.extractValue(null, "$.id")).toBeUndefined();
  });

  it("returns undefined for null field value", () => {
    expect(HookContext.extractValue({ x: null }, "$.x")).toBeUndefined();
  });

  it("handles deeply nested paths", () => {
    const deep = { a: { b: { c: "deep-value" } } };
    expect(HookContext.extractValue(deep, "$.a.b.c")).toBe("deep-value");
  });
});

// ── extractValue: array indexing ──────────────────────────────────────────

describe("HookContext.extractValue — array indexing", () => {
  it("extracts a property from the first array element: $.users[0].id", () => {
    const json = { users: [{ id: "a" }, { id: "b" }] };
    expect(HookContext.extractValue(json, "$.users[0].id")).toBe("a");
  });

  it("extracts from the second array element: $.users[1].id", () => {
    const json = { users: [{ id: "a" }, { id: "b" }] };
    expect(HookContext.extractValue(json, "$.users[1].id")).toBe("b");
  });

  it("extracts last element with negative index: $.items[-1]", () => {
    const json = { items: ["first", "middle", "last"] };
    expect(HookContext.extractValue(json, "$.items[-1]")).toBe("last");
  });

  it("extracts second-to-last element: $.items[-2]", () => {
    const json = { items: ["first", "middle", "last"] };
    expect(HookContext.extractValue(json, "$.items[-2]")).toBe("middle");
  });

  it("supports mixed dot and bracket notation: $.data.users[2].name", () => {
    const json = {
      data: {
        users: [
          { name: "Alice" },
          { name: "Bob" },
          { name: "Carol" },
        ],
      },
    };
    expect(HookContext.extractValue(json, "$.data.users[2].name")).toBe("Carol");
  });

  it("returns JSON string for an array element that is an object", () => {
    const json = { items: [{ x: 1 }, { x: 2 }] };
    const result = HookContext.extractValue(json, "$.items[0]");
    expect(result).toBe(JSON.stringify({ x: 1 }));
  });

  it("returns JSON string for an array element that is an array", () => {
    const json = { matrix: [[1, 2], [3, 4]] };
    const result = HookContext.extractValue(json, "$.matrix[0]");
    expect(result).toBe(JSON.stringify([1, 2]));
  });

  it("returns undefined for an out-of-bounds positive index", () => {
    const json = { items: ["only-one"] };
    expect(HookContext.extractValue(json, "$.items[5]")).toBeUndefined();
  });

  it("returns undefined for an out-of-bounds negative index", () => {
    const json = { items: ["only-one"] };
    expect(HookContext.extractValue(json, "$.items[-5]")).toBeUndefined();
  });

  it("returns undefined when bracket notation is used on a non-array", () => {
    const json = { user: { id: "alice" } };
    expect(HookContext.extractValue(json, "$.user[0]")).toBeUndefined();
  });

  it("returns undefined when bracket notation is used on a string", () => {
    const json = { name: "Alice" };
    expect(HookContext.extractValue(json, "$.name[0]")).toBeUndefined();
  });

  it("dot notation on an array property still returns JSON-serialised array", () => {
    const json = { arr: [1, 2, 3] };
    expect(HookContext.extractValue(json, "$.arr")).toBe(JSON.stringify([1, 2, 3]));
  });

  it("extracts a number element from an array (as string)", () => {
    const json = { scores: [10, 20, 30] };
    expect(HookContext.extractValue(json, "$.scores[1]")).toBe("20");
  });

  it("supports consecutive bracket notation: $.matrix[0][1]", () => {
    const json = { matrix: [[10, 20], [30, 40]] };
    expect(HookContext.extractValue(json, "$.matrix[0][1]")).toBe("20");
  });

  it("supports consecutive brackets with trailing dot property: $.grid[1][0].value", () => {
    const json = { grid: [[{ value: "a" }], [{ value: "b" }]] };
    expect(HookContext.extractValue(json, "$.grid[1][0].value")).toBe("b");
  });
});
