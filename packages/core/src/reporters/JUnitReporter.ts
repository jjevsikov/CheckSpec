import type { TestCase, StreamingTestCase } from "../runner/TestCollection.js";
import type { TestResult, RunSummary } from "../runner/TestRunner.js";
import type { HookResult } from "../hooks/HookRunner.js";
import type { Reporter } from "./ConsoleReporter.js";

/**
 * JUnit XML reporter compatible with GitHub Actions, Jenkins, and other CI systems.
 * Failed hooks are emitted as <testcase classname="hooks"> elements.
 */
export class JUnitReporter implements Reporter {
  private results: TestResult[] = [];
  private hookResults: HookResult[] = [];
  private summary: RunSummary | null = null;

  onTestStart(_test: TestCase | StreamingTestCase): void {
    // no-op for JUnit
  }

  onHookEnd(result: HookResult): void {
    this.hookResults.push(result);
  }

  onTestEnd(result: TestResult): void {
    this.results.push(result);
  }

  onRunEnd(summary: RunSummary): void {
    this.summary = summary;
  }

  flush(): string {
    const s = this.summary;
    if (!s) return "<testsuites/>";

    const escape = (str: string): string =>
      str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const testCases = this.results
      .map((r) => {
        const attrs = [
          `name="${escape(r.testName)}"`,
          `classname="checkspec"`,
          `time="${(r.durationMs / 1000).toFixed(3)}"`,
        ].join(" ");

        if (r.passed) {
          return `    <testcase ${attrs}/>`;
        } else {
          const errorMessage = r.retryExhausted 
            ? `${r.error ?? "Test failed"} (failed after ${(r.retryCount ?? 0) + 1} attempts)`
            : (r.error ?? "Test failed");
          return [
            `    <testcase ${attrs}>`,
            `      <failure message="${escape(errorMessage)}">`,
            `        ${escape(r.error ?? "")}`,
            `      </failure>`,
            `    </testcase>`,
          ].join("\n");
        }
      })
      .join("\n");

    const hookCases = this.hookResults
      .filter((h) => !h.passed)
      .map((h) => {
        const attrs = [
          `name="${escape(`[${h.phase}] ${h.name}`)}"`,
          `classname="hooks"`,
          `time="${(h.durationMs / 1000).toFixed(3)}"`,
        ].join(" ");
        return [
          `    <testcase ${attrs}>`,
          `      <failure message="${escape(h.error ?? "Hook failed")}">`,
          `        ${escape(h.error ?? "")}`,
          `      </failure>`,
          `    </testcase>`,
        ].join("\n");
      })
      .join("\n");

    const failedHooks = this.hookResults.filter((h) => !h.passed).length;

    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<testsuites>`,
      `  <testsuite`,
      `    name="CheckSpec"`,
      `    tests="${s.total + this.hookResults.length}"`,
      `    failures="${s.failed + failedHooks}"`,
      `    skipped="${s.skipped}"`,
      `    time="${(s.durationMs / 1000).toFixed(3)}"`,
      `  >`,
      testCases,
      hookCases,
      `  </testsuite>`,
      `</testsuites>`,
    ].join("\n");
  }
}
