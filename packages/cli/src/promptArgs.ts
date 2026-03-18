/**
 * Shared helper for discovering valid prompt argument values.
 *
 * MCP's PromptArgument type only exposes `name`, `description`, and `required`
 * — it does NOT include enum constraints. Servers validate args server-side
 * (typically via Zod), so the only way to discover valid enum values is to
 * probe: call getPrompt with placeholder args and parse the validation error.
 */

import type { MCPRecordingClient } from "@checkspec/core";

interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/**
 * Builds a prompt args map, probing the server to discover enum constraints.
 *
 * 1. Start with `"example-<argName>"` for each arg.
 * 2. Call `client.getPrompt()` to validate.
 * 3. If the server returns `invalid_enum_value` errors, extract `options[0]`
 *    and retry once with corrected values.
 *
 * Falls back to the initial placeholder values if probing fails or the error
 * format is unrecognised.
 */
export async function probePromptArgs(
  client: MCPRecordingClient,
  promptName: string,
  args: PromptArgument[]
): Promise<Record<string, string>> {
  if (!args || args.length === 0) return {};

  const promptArgs: Record<string, string> = {};
  for (const arg of args) {
    promptArgs[arg.name] = `example-${arg.name}`;
  }

  // Probe: try calling getPrompt to see if the server accepts these args
  try {
    await client.getPrompt(promptName, promptArgs);
    return promptArgs; // accepted as-is
  } catch (err: unknown) {
    // Parse the error message for Zod invalid_enum_value entries
    const corrected = tryExtractEnumFixes(err, promptArgs);
    if (corrected) return corrected;
  }

  return promptArgs; // fallback to placeholders
}

/**
 * Parses a Zod validation error from getPrompt and extracts enum fixes.
 *
 * Zod invalid_enum_value errors look like:
 * ```json
 * [{
 *   "code": "invalid_enum_value",
 *   "options": ["brief", "detailed", "csv"],
 *   "path": ["format"],
 *   "received": "example-format",
 *   "message": "Invalid enum value. Expected 'brief' | 'detailed' | 'csv', received 'example-format'"
 * }]
 * ```
 *
 * Returns corrected args map if any enum fixes were found, or null.
 */
function tryExtractEnumFixes(
  err: unknown,
  currentArgs: Record<string, string>
): Record<string, string> | null {
  const message = err instanceof Error ? err.message : String(err);

  // The error message typically contains embedded JSON array from Zod
  // Try to find a JSON array in the message
  const jsonMatch = message.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  let zodErrors: Array<{
    code?: string;
    options?: string[];
    path?: string[];
  }>;
  try {
    zodErrors = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (!Array.isArray(zodErrors)) return null;

  const enumFixes = zodErrors.filter(
    (e) =>
      e.code === "invalid_enum_value" &&
      Array.isArray(e.options) &&
      e.options.length > 0 &&
      Array.isArray(e.path) &&
      e.path.length > 0
  );

  if (enumFixes.length === 0) return null;

  const corrected = { ...currentArgs };
  for (const fix of enumFixes) {
    const argName = fix.path![0];
    if (argName && argName in corrected) {
      corrected[argName] = fix.options![0];
    }
  }

  return corrected;
}
