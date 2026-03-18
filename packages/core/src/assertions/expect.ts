import { Ajv } from "ajv";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const ajv = new Ajv();

export class AssertionError extends Error {
  constructor(
    message: string,
    public actual?: unknown
  ) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Chainable assertion API for MCP tool call results.
 *
 * @example
 * expect(result).toSucceed();
 * expect(result).toMatchSchema(schema);
 * expect(result, durationMs).toRespondWithin(500);
 * expect(result).not.toSucceed(); // negation
 */
export class MCPExpect {
  private negated: boolean;

  constructor(
    private actual: CallToolResult,
    private durationMs?: number,
    negated = false
  ) {
    this.negated = negated;
  }

  get not(): MCPExpect {
    return new MCPExpect(this.actual, this.durationMs, !this.negated);
  }

  private assert(condition: boolean, message: string): this {
    const passes = this.negated ? !condition : condition;
    if (!passes) {
      const prefix = this.negated ? "Expected NOT: " : "Expected: ";
      throw new AssertionError(prefix + message, this.actual);
    }
    return this;
  }

  /**
   * Returns the concatenated text content from all text blocks in the result.
   * Used internally by all text-based assertion methods.
   */
  private getAllText(): string {
    const content = this.actual.content ?? [];
    return content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
  }

  /**
   * Asserts that the tool call succeeded (isError !== true).
   */
  toSucceed(): this {
    return this.assert(
      !this.actual.isError,
      `tool call to succeed, but got isError=true`
    );
  }

  /**
   * Asserts that the tool call failed (isError === true).
   */
  toFail(): this {
    return this.assert(
      this.actual.isError === true,
      `tool call to fail, but isError was falsy`
    );
  }

  /**
   * Asserts that the result content matches the given JSON Schema.
   */
  toMatchSchema(schema: object): this {
    const validate = ajv.compile(schema);
    const textContent = this.getAllText();

    let parsed: unknown = textContent;
    try {
      parsed = JSON.parse(textContent);
    } catch {
      // Not JSON, validate as string
    }

    const valid = validate(parsed);
    return this.assert(
      valid,
      `result to match schema. Errors: ${JSON.stringify(validate.errors)}`
    );
  }

  /**
   * Asserts that the result text content contains the given string.
   */
  toContainText(text: string): this {
    const allText = this.getAllText();
    return this.assert(
      allText.includes(text),
      `result to contain "${text}", but got: "${allText}"`
    );
  }

  /**
   * Asserts that the result text content does NOT contain the given string.
   */
  toNotContainText(text: string): this {
    const allText = this.getAllText();
    return this.assert(
      !allText.includes(text),
      `result to NOT contain "${text}", but it was found in: "${allText}"`
    );
  }

  /**
   * Asserts that the full response text exactly equals the given string.
   */
  toEqualText(text: string): this {
    const allText = this.getAllText();
    return this.assert(
      allText === text,
      `result text to equal "${text}", but got: "${allText}"`
    );
  }

  /**
   * Asserts that the response text matches the given regex pattern.
   * Throws AssertionError immediately (before negation) if the pattern is invalid.
   */
  toMatchPattern(pattern: string): this {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw new AssertionError(`Invalid regex pattern: "${pattern}"`);
    }
    return this.assert(
      regex.test(this.getAllText()),
      `result to match pattern /${pattern}/, but got: "${this.getAllText()}"`
    );
  }

  /**
   * Asserts that the tool call completed within the given number of milliseconds.
   */
  toRespondWithin(ms: number): this {
    if (this.durationMs === undefined) {
      throw new AssertionError(
        "toRespondWithin requires durationMs to be provided to expect()"
      );
    }
    return this.assert(
      this.durationMs <= ms,
      `response within ${ms}ms, but took ${this.durationMs}ms`
    );
  }

  /**
   * Asserts that the total response text fits within a token budget.
   *
   * Uses the standard approximation of 4 characters per token — accurate within
   * ~10% for English prose and code, consistent with Claude and GPT-4 tokenisers.
   * This is a cost and latency guard: every tool response is injected into the
   * LLM context window, so unexpectedly large responses inflate spend and may
   * push important context out of the window.
   *
   * @param budget Maximum number of tokens allowed (e.g. 500 for ~2 KB of text).
   *
   * @example
   * // Fail if the tool returns more than 500 tokens (~2000 chars)
   * expect(result).toBeLessThanTokens(500);
   */
  toBeLessThanTokens(budget: number): this {
    const allText = this.getAllText();
    const estimatedTokens = Math.ceil(allText.length / 4);
    return this.assert(
      estimatedTokens <= budget,
      `response to fit within ${budget} tokens (~${budget * 4} chars), ` +
        `but estimated ${estimatedTokens} tokens (~${allText.length} chars). ` +
        `Reduce the response size or raise the budget.`
    );
  }
}

/**
 * Creates a chainable assertion object for an MCP tool call result.
 */
export function expect(
  result: CallToolResult,
  durationMs?: number
): MCPExpect {
  return new MCPExpect(result, durationMs);
}
