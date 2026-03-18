import { describe, it, expect } from "vitest";
import { SchemaInputGenerator } from "@checkspec/core";
import { hasIdReferenceField } from "../../packages/cli/src/commands/init.js";

const STRING_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
  },
  required: ["name"],
};

const NUMBER_SCHEMA = {
  type: "object",
  properties: {
    value: { type: "number" },
  },
  required: ["value"],
};

const MULTI_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
    active: { type: "boolean" },
  },
  required: ["name"],
};

describe("SchemaInputGenerator", () => {
  const gen = new SchemaInputGenerator();

  describe("generate (valid mode)", () => {
    it("returns the requested count of items", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "valid", count: 5 });
      expect(results).toHaveLength(5);
    });

    it("each item has a name property of type string", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "valid", count: 3 });
      for (const r of results) {
        expect(typeof r["name"]).toBe("string");
      }
    });

    it("works for number schema", () => {
      const results = gen.generate(NUMBER_SCHEMA, { mode: "valid", count: 2 });
      for (const r of results) {
        expect(typeof r["value"]).toBe("number");
      }
    });

    it("seed produces deterministic output", () => {
      const r1 = gen.generate(STRING_SCHEMA, { mode: "valid", count: 3, seed: 42 });
      const r2 = gen.generate(STRING_SCHEMA, { mode: "valid", count: 3, seed: 42 });
      expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    });
  });

  describe("generate (invalid mode)", () => {
    it("returns inputs with type mismatches", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "invalid", count: 3 });
      expect(results.length).toBeGreaterThan(0);
      // At least one should have a non-string name
      const hasMismatch = results.some(
        (r) => r["name"] !== undefined && typeof r["name"] !== "string"
      );
      expect(hasMismatch).toBe(true);
    });

    it("includes empty object for missing required fields", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "invalid", count: 5 });
      const hasEmpty = results.some((r) => Object.keys(r).length === 0);
      expect(hasEmpty).toBe(true);
    });
  });

  describe("generate (edge mode)", () => {
    it("returns an array of inputs", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "edge" });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it("includes injection strings", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "edge" });
      const allValues = results.flatMap((r) => Object.values(r)).map(String);
      const hasInjection = allValues.some(
        (v) => v.includes("DROP TABLE") || v.includes("<script>")
      );
      expect(hasInjection).toBe(true);
    });
  });

  describe("generateEdgeCases", () => {
    it("returns array with empty string case", () => {
      const results = gen.generateEdgeCases(STRING_SCHEMA);
      const hasEmpty = results.some((r) => r["name"] === "");
      expect(hasEmpty).toBe(true);
    });

    it("returns array with injection strings", () => {
      const results = gen.generateEdgeCases(STRING_SCHEMA);
      const values = results.flatMap((r) => Object.values(r)).map(String);
      const hasSQLi = values.some((v) => v.includes("DROP TABLE"));
      expect(hasSQLi).toBe(true);
    });

    it("returns empty-ish result for schema without properties", () => {
      const results = gen.generateEdgeCases({ type: "object" });
      expect(results).toHaveLength(1);
    });
  });

  describe("generate (fuzz mode)", () => {
    it("returns a mix of valid, invalid, and edge cases", () => {
      const results = gen.generate(MULTI_SCHEMA, { mode: "fuzz", count: 9 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(9);
    });
  });

  describe("generate (llm-style mode)", () => {
    it("returns an array of inputs", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "llm-style" });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it("includes an empty object (LLM forgets all fields)", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "llm-style" });
      const hasEmpty = results.some((r) => Object.keys(r).length === 0);
      expect(hasEmpty).toBe(true);
    });

    it('includes a "null"-as-string input', () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "llm-style" });
      const hasNullString = results.some((r) =>
        Object.values(r).some((v) => v === "null")
      );
      expect(hasNullString).toBe(true);
    });

    it("includes number-as-string for number fields", () => {
      const results = gen.generate(NUMBER_SCHEMA, { mode: "llm-style" });
      const hasNumberAsString = results.some((r) => r["value"] === "42");
      expect(hasNumberAsString).toBe(true);
    });

    it('includes "yes"-as-string for boolean fields', () => {
      const results = gen.generate(MULTI_SCHEMA, { mode: "llm-style" });
      const hasBoolString = results.some((r) => r["active"] === "yes");
      expect(hasBoolString).toBe(true);
    });

    it("includes inputs with hallucinated extra fields", () => {
      const results = gen.generate(STRING_SCHEMA, { mode: "llm-style" });
      const hasExtra = results.some((r) => "_llm_note" in r);
      expect(hasExtra).toBe(true);
    });

    it("generateLlmStyle is directly callable", () => {
      const results = gen.generateLlmStyle(STRING_SCHEMA);
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns single empty object for schema without properties", () => {
      const results = gen.generateLlmStyle({ type: "object" });
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({});
    });
  });

  // ── Phase-2 fixes: post-processing in valid mode ────────────────────────────

  describe("generate (valid mode) — semantic string heuristics (fix #6)", () => {
    it("replaces generated email field with a valid email address", () => {
      const schema = {
        type: "object",
        properties: { email: { type: "string" } },
        required: ["email"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 5 });
      for (const r of results) {
        expect(r["email"]).toBe("user@example.com");
      }
    });

    it("replaces generated city field with a real city name", () => {
      const schema = {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 3 });
      for (const r of results) {
        expect(r["city"]).toBe("London");
      }
    });

    it("replaces generated url field with a real URL", () => {
      const schema = {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 3 });
      for (const r of results) {
        expect(r["url"]).toBe("https://example.com");
      }
    });

    it("replaces generated country field with a country code", () => {
      const schema = {
        type: "object",
        properties: { country: { type: "string" } },
        required: ["country"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 3 });
      for (const r of results) {
        expect(r["country"]).toBe("US");
      }
    });

    it("replaces generated name field with a real name", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 3 });
      for (const r of results) {
        expect(r["name"]).toBe("Alice");
      }
    });

    it("replaces 'query' field with 'test query'", () => {
      const schema = {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 3 });
      for (const r of results) {
        expect(r["query"]).toBe("test query");
      }
    });

    it("replaces generated title field with 'Test Title'", () => {
      const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
      const results = gen.generate(schema, { mode: "valid", count: 1 });
      expect(results[0]["title"]).toBe("Test Title");
    });

    it("replaces generated date field with '2024-01-15'", () => {
      const schema = { type: "object", properties: { date: { type: "string" } }, required: ["date"] };
      const results = gen.generate(schema, { mode: "valid", count: 1 });
      expect(results[0]["date"]).toBe("2024-01-15");
    });

    it("replaces generated status field with 'active'", () => {
      const schema = { type: "object", properties: { status: { type: "string" } }, required: ["status"] };
      const results = gen.generate(schema, { mode: "valid", count: 1 });
      expect(results[0]["status"]).toBe("active");
    });

    it("replaces unknown string fields with 'test-value' instead of Lorem Ipsum", () => {
      const schema = { type: "object", properties: { frobnicator: { type: "string" } }, required: ["frobnicator"] };
      const results = gen.generate(schema, { mode: "valid", count: 1 });
      expect(results[0]["frobnicator"]).toBe("test-value");
    });
  });

  describe("generate (valid mode) — array item post-processing (fix D1)", () => {
    it("replaces string items in arrays with non-Lorem-Ipsum values", () => {
      const schema = {
        type: "object",
        properties: { metrics: { type: "array", items: { type: "string" } } },
        required: ["metrics"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 3 });
      for (const r of results) {
        const items = r["metrics"] as string[] | undefined;
        if (items && items.length > 0) {
          for (const item of items) {
            expect(item).not.toMatch(/lorem|ipsum/i);
          }
        }
      }
    });

    it("uses semantic value for recognized singular key in array items", () => {
      const schema = {
        type: "object",
        properties: { emails: { type: "array", items: { type: "string" } } },
        required: ["emails"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 3 });
      for (const r of results) {
        const items = r["emails"] as string[] | undefined;
        if (items && items.length > 0) {
          for (const item of items) {
            // singular of "emails" → "email" → "user@example.com"
            expect(item).toBe("user@example.com");
          }
        }
      }
    });

    it("clamps number items in arrays to [-100, 100]", () => {
      const schema = {
        type: "object",
        properties: { scores: { type: "array", items: { type: "number" } } },
        required: ["scores"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 5 });
      for (const r of results) {
        const items = r["scores"] as number[] | undefined;
        if (items && items.length > 0) {
          for (const item of items) {
            expect(typeof item).toBe("number");
            expect(item).toBeGreaterThanOrEqual(-100);
            expect(item).toBeLessThanOrEqual(100);
          }
        }
      }
    });
  });

  describe("generate (valid mode) — numeric clamping (fix #7)", () => {
    it("clamps unconstrained number to [-100, 100]", () => {
      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 10 });
      for (const r of results) {
        expect(typeof r["value"]).toBe("number");
        expect(r["value"] as number).toBeGreaterThanOrEqual(-100);
        expect(r["value"] as number).toBeLessThanOrEqual(100);
      }
    });

    it("rounds unconstrained float to 2 decimal places", () => {
      const schema = {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 10 });
      for (const r of results) {
        const v = r["value"] as number;
        // 2dp: multiplied by 100 and rounded should equal itself
        expect(Math.round(v * 100) / 100).toBe(v);
      }
    });

    it("clamps unconstrained integer to [-100, 100] and keeps integer type", () => {
      const schema = {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 10 });
      for (const r of results) {
        const v = r["count"] as number;
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(-100);
        expect(v).toBeLessThanOrEqual(100);
      }
    });

    it("respects explicit minimum/maximum constraints", () => {
      const schema = {
        type: "object",
        properties: { value: { type: "number", minimum: 1000, maximum: 9999 } },
        required: ["value"],
      };
      const results = gen.generate(schema, { mode: "valid", count: 5 });
      for (const r of results) {
        const v = r["value"] as number;
        // When min/max are set, we leave jsf's output alone
        expect(v).toBeGreaterThanOrEqual(1000);
        expect(v).toBeLessThanOrEqual(9999);
      }
    });
  });
});

// ── hasIdReferenceField helper ────────────────────────────────────────────────

describe("hasIdReferenceField (fix #5 — omit success:true for ID-ref tools)", () => {
  it("returns true for field named exactly 'id'", () => {
    expect(hasIdReferenceField({ properties: { id: { type: "string" } } })).toBe(true);
  });

  it("returns true for camelCase suffix 'Id' (e.g. userId, taskId)", () => {
    expect(hasIdReferenceField({ properties: { userId: { type: "string" } } })).toBe(true);
    expect(hasIdReferenceField({ properties: { taskId: { type: "string" } } })).toBe(true);
    expect(hasIdReferenceField({ properties: { formId: { type: "string" } } })).toBe(true);
  });

  it("returns true for snake_case suffix '_id' (e.g. user_id, task_id)", () => {
    expect(hasIdReferenceField({ properties: { user_id: { type: "string" } } })).toBe(true);
    expect(hasIdReferenceField({ properties: { task_id: { type: "string" } } })).toBe(true);
  });

  it("returns false for non-ID fields", () => {
    expect(hasIdReferenceField({ properties: { name: { type: "string" } } })).toBe(false);
    expect(hasIdReferenceField({ properties: { message: { type: "string" } } })).toBe(false);
    expect(hasIdReferenceField({ properties: { query: { type: "string" } } })).toBe(false);
  });

  it("returns false when a field name only contains 'id' in the middle", () => {
    // 'hideout', 'video' — 'id' appears but not as a suffix
    expect(hasIdReferenceField({ properties: { hideout: { type: "string" } } })).toBe(false);
  });

  it("returns false for empty properties", () => {
    expect(hasIdReferenceField({ properties: {} })).toBe(false);
  });

  it("returns false when inputSchema has no properties", () => {
    expect(hasIdReferenceField({})).toBe(false);
  });

  it("returns true when mixed with non-ID fields (any match is enough)", () => {
    expect(
      hasIdReferenceField({ properties: { name: {}, userId: {} } })
    ).toBe(true);
  });
});
