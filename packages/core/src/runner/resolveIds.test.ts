import { describe, it, expect } from "vitest";
import { resolveIds, slugify } from "./resolveIds.js";
import type { CheckSpecCollection } from "./TestCollection.js";

// ── slugify ──────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and hyphenates words", () => {
    expect(slugify("Add Numbers Works", 0)).toBe("add-numbers-works");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("  -- hello world --  ", 0)).toBe("hello-world");
  });

  it("collapses multiple non-alphanumeric chars into one hyphen", () => {
    expect(slugify("a › b :: c", 0)).toBe("a-b-c");
  });

  it("truncates to 40 characters", () => {
    const long = "a".repeat(50);
    expect(slugify(long, 0)).toHaveLength(40);
  });

  it("falls back to test-<index> when name has no alphanumeric chars", () => {
    expect(slugify("--- !!!  ---", 3)).toBe("test-3");
    expect(slugify("", 5)).toBe("test-5");
  });
});

// ── resolveIds ───────────────────────────────────────────────────────────────

function makeCollection(
  topLevel: { id?: string; name: string }[],
  describeBlocks: { name: string; tests: { id?: string; name: string }[] }[] = []
): CheckSpecCollection {
  return {
    version: "1.0",
    name: "Test",
    server: { command: "node", args: [] },
    tests: topLevel.map((t) => ({
      ...t,
      type: "tool-call" as const,
      tool: "echo",
    })),
    describe: describeBlocks.map((b) => ({
      name: b.name,
      tests: b.tests.map((t) => ({
        ...t,
        type: "tool-call" as const,
        tool: "echo",
      })),
    })),
  } as unknown as CheckSpecCollection;
}

describe("resolveIds", () => {
  it("leaves explicit IDs unchanged", () => {
    const col = makeCollection([{ id: "my-test", name: "My Test" }]);
    resolveIds(col);
    expect(col.tests[0]!.id).toBe("my-test");
  });

  it("generates a slug ID from the test name when id is omitted", () => {
    const col = makeCollection([{ name: "Echo works" }]);
    resolveIds(col);
    expect(col.tests[0]!.id).toBe("echo-works");
  });

  it("deduplicates auto-IDs that collide", () => {
    const col = makeCollection([
      { name: "Echo works" },
      { name: "Echo works" }, // would produce same slug
    ]);
    resolveIds(col);
    expect(col.tests[0]!.id).toBe("echo-works");
    expect(col.tests[1]!.id).toBe("echo-works-1"); // index appended
  });

  it("auto-IDs do not collide with explicit IDs", () => {
    const col = makeCollection([
      { id: "echo-works", name: "Explicit" }, // claims the slug
      { name: "Echo works" },                 // would also slug to "echo-works"
    ]);
    resolveIds(col);
    expect(col.tests[0]!.id).toBe("echo-works");
    expect(col.tests[1]!.id).toBe("echo-works-1");
  });

  it("resolves IDs inside describe blocks", () => {
    const col = makeCollection([], [
      { name: "group", tests: [{ name: "Tool call works" }] },
    ]);
    resolveIds(col);
    expect(col.describe![0]!.tests[0]!.id).toBe("tool-call-works");
  });

  it("top-level and describe block IDs share a dedup namespace", () => {
    const col = makeCollection(
      [{ name: "Echo works" }],
      [{ name: "group", tests: [{ name: "Echo works" }] }]
    );
    resolveIds(col);
    // First one (top-level) gets the clean slug
    expect(col.tests[0]!.id).toBe("echo-works");
    // Second one (describe block): same slug taken, so appends local array index (0)
    expect(col.describe![0]!.tests[0]!.id).toBe("echo-works-0");
  });

  it("is idempotent — calling twice does not change IDs", () => {
    const col = makeCollection([{ name: "Echo works" }, { name: "Another test" }]);
    resolveIds(col);
    const first = col.tests[0]!.id;
    const second = col.tests[1]!.id;
    resolveIds(col);
    expect(col.tests[0]!.id).toBe(first);
    expect(col.tests[1]!.id).toBe(second);
  });

  it("returns the collection for chaining", () => {
    const col = makeCollection([{ name: "Echo" }]);
    const returned = resolveIds(col);
    expect(returned).toBe(col);
  });

  it("handles a collection with zero tests and no describe blocks", () => {
    const col = makeCollection([]);
    expect(() => resolveIds(col)).not.toThrow();
  });

  it("generates test-<i> fallback when name has no alphanumeric chars", () => {
    const col = makeCollection([{ name: "!!! ---" }]);
    resolveIds(col);
    expect(col.tests[0]!.id).toMatch(/^test-\d+$/);
  });

  it("dedup suffix itself does not collide with an explicit ID", () => {
    // Explicit ID "echo-works-1" occupies the first fallback suffix for index 1.
    // The auto-ID at index 1 must skip "echo-works-1" and try the next suffix.
    const col = makeCollection([
      { id: "echo-works-1", name: "Explicit" },
      { name: "Echo works" },   // index 1 → slug "echo-works" → not taken → "echo-works"
      { name: "Echo works" },   // index 2 → slug "echo-works" → taken → try "echo-works-2"
    ]);
    resolveIds(col);
    expect(col.tests[0]!.id).toBe("echo-works-1");   // explicit, untouched
    expect(col.tests[1]!.id).toBe("echo-works");      // first auto, clean slug
    expect(col.tests[2]!.id).toBe("echo-works-2");    // skipped -1 (taken), used -2
  });

  it("dedup handles multiple suffix collisions", () => {
    // All fallback suffixes -0, -1, -2 are taken by explicit IDs
    const col = makeCollection([
      { id: "echo-works-0", name: "A" },
      { id: "echo-works-1", name: "B" },
      { id: "echo-works-2", name: "C" },
      { name: "Echo works" },   // index 3 → slug taken? no, "echo-works" is free
      { name: "Echo works" },   // index 4 → slug "echo-works" taken → try -4, should work
    ]);
    resolveIds(col);
    expect(col.tests[3]!.id).toBe("echo-works");
    expect(col.tests[4]!.id).toBe("echo-works-4");
  });
});
