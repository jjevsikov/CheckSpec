/**
 * Auto-ID resolution for CheckSpec test collections.
 *
 * When a test omits the `id` field, this module generates a stable,
 * human-readable identifier from the test's name.  The algorithm:
 *
 * 1. Slugify the name:  "Add numbers › works!"  →  "add-numbers-works"
 * 2. Truncate to 40 chars to keep IDs scannable in test output
 * 3. Deduplicate: if the slug already appeared, append the test index
 *
 * Tests that provide an explicit `id` are never modified.
 */

import type { TestCase, StreamingTestCase, CheckSpecCollection, DescribeBlock } from "./TestCollection.js";

type AnyTest = TestCase | StreamingTestCase;

/**
 * Produces a URL-safe slug from an arbitrary test name string.
 * Falls back to `"test-<index>"` when the name contains no alphanumeric chars.
 */
export function slugify(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `test-${index}`;
}

/**
 * Assigns a unique `id` to every test in the array that doesn't already have one.
 *
 * Uses a shared `existingIds` set so IDs are deduplicated across all tests in a
 * collection (top-level + describe blocks) in a single pass.
 *
 * Mutates the tests in place; also returns the array for chaining.
 */
function assignIds(tests: AnyTest[], existingIds: Set<string>): AnyTest[] {
  for (let i = 0; i < tests.length; i++) {
    const test = tests[i]!;
    if (test.id) {
      // Explicit ID — register it so later auto-IDs don't collide with it
      existingIds.add(test.id);
      continue;
    }

    const base = slugify(test.name, i);
    let id = base;
    if (existingIds.has(id)) {
      // Find the first unused suffix — covers the case where `${base}-${i}`
      // itself is already taken by an explicit ID or a prior auto-ID.
      let suffix = i;
      do {
        id = `${base}-${suffix}`;
        suffix++;
      } while (existingIds.has(id));
    }
    existingIds.add(id);
    // Safe: we own the object at this point (it came from JSON.parse or a test factory)
    (test as { id: string }).id = id;
  }
  return tests;
}

/**
 * Resolves all missing `id` fields in a collection.
 *
 * Pass 1 — register all explicit IDs (so auto-generated ones don't collide).
 * Pass 2 — fill in missing IDs using slugs, deduplicating across the whole collection.
 *
 * Mutates the collection in place and returns it for convenience.
 */
export function resolveIds(collection: CheckSpecCollection): CheckSpecCollection {
  const existingIds = new Set<string>();

  // Gather all explicit IDs first — prevents auto-IDs colliding with explicit ones
  // that appear later in the collection.
  const allTests: AnyTest[] = [
    ...(collection.tests as AnyTest[]),
    ...(collection.describe ?? []).flatMap((b: DescribeBlock) => b.tests as AnyTest[]),
  ];
  for (const test of allTests) {
    if (test.id) existingIds.add(test.id);
  }

  // Now assign missing IDs, keyed relative to their own array index.
  // Top-level tests and each describe block are indexed independently —
  // this keeps auto-IDs stable when tests are added to one group without
  // disturbing the other group's IDs.
  assignIds(collection.tests as AnyTest[], existingIds);
  for (const block of collection.describe ?? []) {
    assignIds(block.tests as AnyTest[], existingIds);
  }

  return collection;
}
