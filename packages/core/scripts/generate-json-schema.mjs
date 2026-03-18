/**
 * Build-time script: generates checkspec.schema.json from the Zod collection schema.
 *
 * Run automatically as part of `npm run build` (after tsc compiles the TS).
 * Can also be run standalone: `node scripts/generate-json-schema.mjs`
 *
 * Output: packages/core/checkspec.schema.json
 *
 * This file is shipped with the @checkspec/core package and referenced by
 * the $schema field that `checkspec init` and `checkspec generate` write into
 * generated collection files — enabling IDE autocomplete and inline validation.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { collectionSchema } from "../dist/schema/collectionSchema.js";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(__dirname, "../checkspec.schema.json");

const jsonSchema = zodToJsonSchema(collectionSchema, {
  name: "CheckSpecCollection",
  // Inline all $defs so the file is self-contained (no $ref resolution needed)
  $refStrategy: "none",
  // Include descriptions from .describe() calls and JSDoc-style comments
  definitionPath: "$defs",
});

writeFileSync(outFile, JSON.stringify(jsonSchema, null, 2) + "\n");
console.log(`Generated checkspec.schema.json`);
