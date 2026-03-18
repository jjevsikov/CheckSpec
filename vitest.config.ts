import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 15_000,
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./test-results.xml",
    },
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts"],
      exclude: ["packages/core/src/**/*.test.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
