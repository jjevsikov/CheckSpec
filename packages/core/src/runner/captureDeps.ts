/**
 * Capture-aware dependency analysis for concurrent test scheduling.
 *
 * When tests use `capture` to extract values and later tests consume those
 * values via `{{varName}}` templates, naive chunking can cause B to execute
 * before A has written its captured value to HookContext.
 *
 * These utilities build a topologically-sorted execution plan that respects
 * capture dependencies while still maximising parallelism within each layer.
 */

import type { TestCase, StreamingTestCase } from "./TestCollection.js";

const TEMPLATE_REGEX = /\{\{(\w+)\}\}/g;

/**
 * Recursively walk all string values in `value` and collect every
 * `{{varName}}` template variable referenced.
 */
function collectTemplateVars(value: unknown, result: Set<string>): void {
  if (typeof value === "string") {
    let match: RegExpExecArray | null;
    TEMPLATE_REGEX.lastIndex = 0;
    while ((match = TEMPLATE_REGEX.exec(value)) !== null) {
      result.add(match[1]!);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTemplateVars(item, result);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectTemplateVars(v, result);
    }
  }
}

/**
 * Extract all `{{varName}}` template variables consumed by a test.
 *
 * Scans: `input`, `uri`, `promptArgs`, `name`, and the `expect` block
 * (including `contains`, `equals`, `notContains`, `matches`, and
 * `jsonPath[*].equals/contains/matches`).
 */
export function extractTemplateVars(
  test: TestCase | StreamingTestCase
): Set<string> {
  const vars = new Set<string>();

  // Scan the whole test object recursively - this covers input, expect,
  // uri, promptArgs, name, and any future fields without needing updates.
  collectTemplateVars(test, vars);

  return vars;
}

/**
 * Build a capture-aware execution schedule as an ordered list of chunks.
 *
 * Each chunk is a slice of tests that can safely run in parallel:
 * - Tests within a chunk have no dependencies on each other's captures.
 * - All dependencies of every test in chunk N are satisfied by tests in
 *   chunks 0 ... N-1.
 *
 * Within each topological layer, tests are further split into sub-chunks
 * of `concurrency` size (so the caller can run each chunk via Promise.all).
 *
 * Edge cases:
 * - No capture fields -> same chunking as the naive approach.
 * - Variables produced by hooks (not by any test) -> no dependency edge.
 * - Empty array -> returns [].
 * - concurrency=1 -> one test per chunk.
 * - Circular dependency -> throws Error with a descriptive message.
 *
 * @param tests     Flat list of already-expanded tests (parametrize already applied).
 * @param concurrency  Maximum tests per chunk (mirrors collection.concurrency).
 */
export function buildExecutionLayers(
  tests: (TestCase | StreamingTestCase)[],
  concurrency: number
): (TestCase | StreamingTestCase)[][] {
  if (tests.length === 0) return [];

  // Step 1: Build the producers map
  // Maps variable name -> index of the test that captures it.
  // Only test-level captures matter here; hook captures are already in
  // HookContext before tests run, so they create no test-to-test edges.
  const producers = new Map<string, number>();
  for (let i = 0; i < tests.length; i++) {
    const capture = (tests[i] as TestCase).capture;
    if (capture) {
      for (const varName of Object.keys(capture)) {
        producers.set(varName, i);
      }
    }
  }

  // Fast path: no test produces any captured variable -> no dependencies,
  // use identical chunking to the naive approach.
  if (producers.size === 0) {
    return naiveChunks(tests, concurrency);
  }

  // Step 2: Build dependency edges
  // deps[i] = set of test indices that test i depends on.
  const deps: Set<number>[] = tests.map(() => new Set<number>());
  // inDegree[i] = number of tests that must complete before test i.
  const inDegree = new Array<number>(tests.length).fill(0);
  // reverseDeps[j] = list of test indices that depend on j.
  const reverseDeps: number[][] = tests.map(() => []);

  for (let i = 0; i < tests.length; i++) {
    const consumed = extractTemplateVars(tests[i]!);
    for (const varName of consumed) {
      const producerIdx = producers.get(varName);
      // Only create an edge if the producer is a different test.
      if (producerIdx !== undefined && producerIdx !== i) {
        if (!deps[i]!.has(producerIdx)) {
          deps[i]!.add(producerIdx);
          inDegree[i]++;
          reverseDeps[producerIdx]!.push(i);
        }
      }
    }
  }

  // Step 3: Kahn's algorithm -> assign each test to a layer
  const layer = new Array<number>(tests.length).fill(-1);
  const queue: number[] = [];

  // Seed with tests that have no dependencies.
  for (let i = 0; i < tests.length; i++) {
    if (inDegree[i] === 0) {
      queue.push(i);
      layer[i] = 0;
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    const idx = queue.shift()!;
    processed++;

    for (const dependent of reverseDeps[idx]!) {
      // Update the layer for this dependent on every edge, tracking the max
      // across all dependencies. This is necessary for diamond-shaped graphs
      // where a node has multiple predecessors at different layers.
      layer[dependent] = Math.max(layer[dependent]!, layer[idx]! + 1);
      inDegree[dependent]--;
      if (inDegree[dependent] === 0) {
        queue.push(dependent);
      }
    }
  }

  // Step 4: Detect circular dependencies
  if (processed < tests.length) {
    // Find one cycle member to name in the error.
    const cycleIdx = layer.findIndex((l) => l === -1);
    const cycleName = tests[cycleIdx]?.name ?? `index ${cycleIdx}`;
    throw new Error(
      `Circular capture dependency detected involving test "${cycleName}". ` +
        `Tests with circular {{varName}} -> capture chains cannot be scheduled.`
    );
  }

  // Step 5: Group by layer, then split into sub-chunks
  const maxLayer = Math.max(...layer);
  const chunks: (TestCase | StreamingTestCase)[][] = [];

  for (let l = 0; l <= maxLayer; l++) {
    const layerTests = tests.filter((_, i) => layer[i] === l);
    // Split this layer's tests into sub-chunks of `concurrency` size.
    for (let start = 0; start < layerTests.length; start += concurrency) {
      chunks.push(layerTests.slice(start, start + concurrency));
    }
  }

  return chunks;
}

/** Naive fixed-size chunking (no dependency analysis). */
function naiveChunks(
  tests: (TestCase | StreamingTestCase)[],
  concurrency: number
): (TestCase | StreamingTestCase)[][] {
  const chunks: (TestCase | StreamingTestCase)[][] = [];
  for (let i = 0; i < tests.length; i += concurrency) {
    chunks.push(tests.slice(i, i + concurrency));
  }
  return chunks;
}
