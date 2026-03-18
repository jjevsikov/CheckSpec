/**
 * Parametrized test expansion.
 *
 * Pure function — no class, no side effects beyond console.warn for empty arrays.
 * Called once in TestRunner.runCollection before hooks run so the runner sees
 * only flat, fully-resolved TestCase objects.
 */
import type { TestCase, StreamingTestCase, ParameterRow } from "./TestCollection.js";

type AnyTest = TestCase | StreamingTestCase;

/**
 * Expands any test that contains a `parametrize` array into N individual tests —
 * one per row. Tests without `parametrize` pass through unchanged.
 *
 * Expansion rules:
 * - `id`    → `"${original.id}[${index}]"`   e.g. `"add-test[0]"`, `"add-test[1]"`
 * - `name`  → `"${original.name} [case: ${row.label}]"`
 * - `input` → `{ ...base.input, ...row.input }` (row wins on key conflict)
 * - `expect`→ `{ ...base.expect, ...row.expect }` if row.expect is present (shallow)
 * - `streamExpect` → `{ ...base.streamExpect, ...row.streamExpect }` if present (shallow)
 * - All other fields (`retry`, `retryDelayMs`, `tags`, `type`, …) are inherited unchanged
 * - The `parametrize` key itself is NOT included in expanded tests
 *
 * A test with `parametrize: []` is dropped with a console.warn and excluded from the suite.
 *
 * @returns Flat array of fully-resolved test cases ready for the runner.
 */
export function expandParametrizedTests(tests: AnyTest[]): AnyTest[] {
  const result: AnyTest[] = [];

  for (const test of tests) {
    const rows = test.parametrize;

    // No parametrize field → pass through unchanged
    if (!rows) {
      result.push(test);
      continue;
    }

    // Empty array → warn and drop
    if (rows.length === 0) {
      console.warn(`warn: test "${test.name}" has empty parametrize array, skipping`);
      continue;
    }

    // Expand one copy per row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as ParameterRow;

      // Strip parametrize so it isn't propagated to expanded tests
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { parametrize: _dropped, ...base } = test;

      const expanded: AnyTest = {
        ...base,
        id: `${base.id}[${i}]`,
        name: `${base.name} [case: ${row.label}]`,
        // Row input merges over base input (row wins on conflict)
        input: { ...(base.input ?? {}), ...row.input },
        // Row expect merges over base expect (only when row provides it)
        ...(row.expect !== undefined && {
          expect: { ...(base as TestCase).expect, ...row.expect },
        }),
        // Row streamExpect merges over base streamExpect (only when row provides it)
        ...(row.streamExpect !== undefined && {
          streamExpect: {
            ...((base as StreamingTestCase).streamExpect ?? {}),
            ...row.streamExpect,
          },
        }),
      } as AnyTest;

      result.push(expanded);
    }
  }

  return result;
}

/**
 * Counts how many tests in an array have a non-empty `parametrize` field.
 * Used by the runner to populate `RunSummary.parametrizedSourceCount`.
 */
export function countParametrizedSources(tests: AnyTest[]): number {
  return tests.filter((t) => t.parametrize && t.parametrize.length > 0).length;
}
