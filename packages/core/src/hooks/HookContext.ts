/**
 * Shared context for a test collection run.
 *
 * Stores named variables captured from hook results and resolves
 * {{varName}} template placeholders in test inputs and assertions.
 *
 * Lifecycle: one HookContext per `runCollection()` call, shared across
 * all hook phases and all tests in that collection.
 */
export class HookContext {
  private readonly vars = new Map<string, string>();

  set(key: string, value: string): void {
    this.vars.set(key, value);
  }

  has(key: string): boolean {
    return this.vars.has(key);
  }

  /**
   * Resolves all `{{varName}}` placeholders in `value`.
   * Recursively walks objects, arrays, and strings.
   * Numbers, booleans, and null pass through unchanged.
   * Warns once per unknown variable name and keeps the placeholder as-is.
   */
  resolve<T>(value: T): T {
    if (this.vars.size === 0) return value;
    return this.resolveValue(value, new Set<string>()) as T;
  }

  private resolveValue(value: unknown, warned: Set<string>): unknown {
    if (typeof value === "string") {
      return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
        if (this.vars.has(key)) return this.vars.get(key)!;
        if (!warned.has(key)) {
          warned.add(key);
          console.warn(`[HookContext] Variable "{{${key}}}" is not defined`);
        }
        return match; // keep placeholder unchanged
      });
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveValue(item, warned));
    }

    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.resolveValue(v, warned);
      }
      return out;
    }

    return value; // number, boolean, null, undefined — pass through
  }

  /**
   * Extracts a value from a parsed JSON object using a JSONPath-like expression.
   *
   * Supported syntax:
   *   `$.field`              — top-level property
   *   `$.field.nested.path`  — nested property access
   *   `$.items[0]`           — array index (zero-based)
   *   `$.items[-1]`          — negative index (last element)
   *   `$.data.users[2].name` — mixed dot and bracket notation
   *   `$.matrix[0][1]`       — consecutive bracket notation (nested arrays)
   *
   * Returns `undefined` for missing paths, non-object inputs, out-of-bounds indices,
   * bracket access on non-arrays, or invalid syntax.
   * Object/array values are JSON-serialised; primitives are converted to string.
   */
  static extractValue(json: unknown, path: string): string | undefined {
    if (!path.startsWith("$.")) return undefined;

    // Tokenize the path into property names (string) and array indices (number).
    // Handles dot notation, bracket notation, and consecutive brackets:
    //   "users[0].name"   -> ["users", 0, "name"]
    //   "matrix[0][1]"    -> ["matrix", 0, 1]
    //   "data.users[2].name" -> ["data", "users", 2, "name"]
    const parts: Array<string | number> = [];
    const tokenPattern = /(?:\.?([^.[]+)|\[(-?\d+)\])/g;
    const body = path.slice(2); // strip "$."
    let m: RegExpExecArray | null;
    while ((m = tokenPattern.exec(body)) !== null) {
      if (m[1] !== undefined) {
        parts.push(m[1]);                     // property name
      } else if (m[2] !== undefined) {
        parts.push(parseInt(m[2], 10));        // array index
      }
    }

    let current: unknown = json;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof part === "number") {
        if (!Array.isArray(current)) return undefined;
        const idx = part < 0 ? current.length + part : part;
        current = current[idx];
      } else {
        if (typeof current !== "object" || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[part];
      }
    }

    if (current === undefined || current === null) return undefined;
    if (typeof current === "object") return JSON.stringify(current);
    return String(current);
  }
}
