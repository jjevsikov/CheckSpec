import { describe, it, expect as vitestExpect } from "vitest";
import { expect as mcpExpect, AssertionError, MCPExpect } from "@checkspec/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function makeResult(
  text: string,
  isError = false
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

describe("MCPExpect", () => {
  describe("toSucceed", () => {
    it("passes when isError is falsy", () => {
      vitestExpect(() => mcpExpect(makeResult("ok")).toSucceed()).not.toThrow();
    });

    it("throws when isError is true", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("err", true)).toSucceed()
      ).toThrow(AssertionError);
    });
  });

  describe("toFail", () => {
    it("passes when isError is true", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("err", true)).toFail()
      ).not.toThrow();
    });

    it("throws when isError is falsy", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("ok")).toFail()
      ).toThrow(AssertionError);
    });
  });

  describe("toContainText", () => {
    it("passes when text is found", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello world")).toContainText("hello")
      ).not.toThrow();
    });

    it("throws when text is not found", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello world")).toContainText("missing")
      ).toThrow(AssertionError);
    });
  });

  describe("toRespondWithin", () => {
    it("passes when duration is within limit", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("ok"), 100).toRespondWithin(500)
      ).not.toThrow();
    });

    it("throws when duration exceeds limit", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("ok"), 1000).toRespondWithin(500)
      ).toThrow(AssertionError);
    });

    it("throws when durationMs is not provided", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("ok")).toRespondWithin(500)
      ).toThrow(AssertionError);
    });
  });

  describe("toMatchSchema", () => {
    it("passes for valid JSON matching schema", () => {
      const result = makeResult(JSON.stringify({ name: "Alice", age: 30 }));
      vitestExpect(() =>
        mcpExpect(result).toMatchSchema({
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
          required: ["name"],
        })
      ).not.toThrow();
    });

    it("throws for invalid JSON against schema", () => {
      const result = makeResult(JSON.stringify({ name: 123 }));
      vitestExpect(() =>
        mcpExpect(result).toMatchSchema({
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        })
      ).toThrow(AssertionError);
    });
  });

  describe("not (negation)", () => {
    it("negates toSucceed", () => {
      const result = makeResult("err", true);
      vitestExpect(() =>
        mcpExpect(result).not.toSucceed()
      ).not.toThrow();
    });

    it("negates toContainText", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello")).not.toContainText("missing")
      ).not.toThrow();
    });

    it("throws on double negation that fails", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello")).not.toContainText("hello")
      ).toThrow(AssertionError);
    });
  });

  describe("toBeLessThanTokens", () => {
    it("passes when estimated tokens are within budget", () => {
      // 40 chars → ceil(40/4) = 10 tokens → under budget of 20
      const result = makeResult("a".repeat(40));
      vitestExpect(() =>
        mcpExpect(result).toBeLessThanTokens(20)
      ).not.toThrow();
    });

    it("passes when estimated tokens exactly equal the budget", () => {
      // 400 chars → ceil(400/4) = 100 tokens → exactly at budget
      const result = makeResult("a".repeat(400));
      vitestExpect(() =>
        mcpExpect(result).toBeLessThanTokens(100)
      ).not.toThrow();
    });

    it("throws when estimated tokens exceed the budget", () => {
      // 2000 chars → ceil(2000/4) = 500 tokens → over budget of 100
      const result = makeResult("a".repeat(2000));
      vitestExpect(() =>
        mcpExpect(result).toBeLessThanTokens(100)
      ).toThrow(AssertionError);
    });

    it("counts tokens across multiple content blocks", () => {
      // Two blocks of 600 chars each = 1200 total → ceil(1200/4) = 300 tokens → over budget of 200
      const result: import("@modelcontextprotocol/sdk/types.js").CallToolResult = {
        content: [
          { type: "text", text: "a".repeat(600) },
          { type: "text", text: "b".repeat(600) },
        ],
      };
      vitestExpect(() =>
        mcpExpect(result).toBeLessThanTokens(200)
      ).toThrow(AssertionError);
    });

    it("passes on empty content with any budget", () => {
      const result = makeResult("");
      vitestExpect(() =>
        mcpExpect(result).toBeLessThanTokens(1)
      ).not.toThrow();
    });

    it("is negatable", () => {
      // 2000 chars → 500 tokens, budget 100 → would normally throw; negated passes
      const result = makeResult("a".repeat(2000));
      vitestExpect(() =>
        mcpExpect(result).not.toBeLessThanTokens(100)
      ).not.toThrow();
    });
  });

  describe("toNotContainText", () => {
    it("passes when text is absent", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello world")).toNotContainText("missing")
      ).not.toThrow();
    });

    it("throws when text is present", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello world")).toNotContainText("hello")
      ).toThrow(AssertionError);
    });

    it("negation: passes when text IS present (double negative)", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello world")).not.toNotContainText("hello")
      ).not.toThrow();
    });

    it("negation: throws when text is absent (double negative)", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello world")).not.toNotContainText("missing")
      ).toThrow(AssertionError);
    });
  });

  describe("toEqualText", () => {
    it("passes when text matches exactly", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("exact match")).toEqualText("exact match")
      ).not.toThrow();
    });

    it("throws when text does not match exactly", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello world")).toEqualText("hello")
      ).toThrow(AssertionError);
    });

    it("throws for empty string vs non-empty", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("not empty")).toEqualText("")
      ).toThrow(AssertionError);
    });

    it("passes for empty result with empty expected", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("")).toEqualText("")
      ).not.toThrow();
    });

    it("is negatable", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello")).not.toEqualText("goodbye")
      ).not.toThrow();
    });
  });

  describe("toMatchPattern", () => {
    it("passes when response matches the regex pattern", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("user-123")).toMatchPattern("^user-\\d+$")
      ).not.toThrow();
    });

    it("throws when response does not match the pattern", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("hello world")).toMatchPattern("^\\d+$")
      ).toThrow(AssertionError);
    });

    it("passes for case-insensitive partial match", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("Hello World")).toMatchPattern("[Hh]ello")
      ).not.toThrow();
    });

    it("throws AssertionError for an invalid regex pattern (not negated)", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("any")).toMatchPattern("[invalid")
      ).toThrow(AssertionError);
    });

    it("is negatable — passes when pattern does not match", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("abc")).not.toMatchPattern("^\\d+$")
      ).not.toThrow();
    });

    it("negation throws when pattern does match", () => {
      vitestExpect(() =>
        mcpExpect(makeResult("123")).not.toMatchPattern("^\\d+$")
      ).toThrow(AssertionError);
    });
  });

  describe("MCPExpect type", () => {
    it("is instance of MCPExpect", () => {
      vitestExpect(mcpExpect(makeResult("ok"))).toBeInstanceOf(MCPExpect);
    });

    it("chains return this", () => {
      const e = mcpExpect(makeResult("test text"));
      vitestExpect(e.toSucceed()).toBe(e);
    });
  });
});
