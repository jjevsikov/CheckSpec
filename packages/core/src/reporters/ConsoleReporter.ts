import chalk from "chalk";
import type { TestCase, StreamingTestCase } from "../runner/TestCollection.js";
import type { TestResult, RunSummary } from "../runner/TestRunner.js";
import type { HookResult } from "../hooks/HookRunner.js";

export interface Reporter {
  onTestStart(test: TestCase | StreamingTestCase): void;
  onTestEnd(result: TestResult): void;
  onRunEnd(summary: RunSummary): void;
  /** Optional: called after each hook completes so reporters can surface hook output inline */
  onHookEnd?(result: HookResult): void;
  /** Optional: called when entering a describe block */
  onDescribeStart?(name: string): void;
  /** Optional: called when leaving a describe block (after all tests and teardown hooks) */
  onDescribeEnd?(name: string): void;
  /** Returns the formatted output string */
  flush(): string;
}

const PHASE_LABEL: Record<string, string> = {
  beforeAll:  "setup",
  afterAll:   "teardown",
  beforeEach: "each",
  afterEach:  "each",
};

/**
 * Pretty terminal reporter using chalk.
 * Outputs colored pass/fail results with timing.
 */
export class ConsoleReporter implements Reporter {
  private lines: string[] = [];

  onDescribeStart(name: string): void {
    const pad = Math.max(0, 44 - name.length);
    const line = "\n" + chalk.bold(`  ${name}`) + " " + chalk.gray("─".repeat(pad));
    console.log(line);
    this.lines.push(line);
  }

  onTestStart(test: TestCase | StreamingTestCase): void {
    process.stdout.write(chalk.gray(`  Running: ${test.name}...`));
  }

  onHookEnd(result: HookResult): void {
    // Clear any in-progress "Running:" line before printing hook output
    process.stdout.write("\r\x1b[K");

    const label = `[${PHASE_LABEL[result.phase] ?? result.phase}]`.padEnd(11);
    const hookName = result.name.padEnd(35);
    const icon = result.passed ? chalk.green("✓") : chalk.red("✗");
    const timing = chalk.gray(`${result.durationMs}ms`);
    const line = chalk.gray(label) + " " + hookName + ` ${icon} ${timing}`;
    console.log(line);
    this.lines.push(line);

    if (!result.passed && result.error) {
      const errLine = chalk.red(`    Hook error: ${result.error}`);
      console.log(errLine);
      this.lines.push(errLine);
    }
  }

  onTestEnd(result: TestResult): void {
    // Clear the "Running:" line
    process.stdout.write("\r\x1b[K");

    // Retry annotation helpers
    const configuredRetry = result.testCase?.retry ?? 0;
    const maxAttempts = 1 + configuredRetry;

    if (result.passed) {
      let annotation = "";
      if (configuredRetry > 0) {
        // Show attempt X/N for all passes when retry was configured — tells the
        // operator this test is retry-guarded (even if it passed on attempt 1).
        const attemptNum = (result.retryCount ?? 0) + 1;
        annotation = chalk.gray(` (passed on attempt ${attemptNum}/${maxAttempts})`);
      }
      const timing = chalk.gray(configuredRetry > 0 ? ` ${result.durationMs}ms` : ` (${result.durationMs}ms)`);
      const line = chalk.green(`  ✓ ${result.testName}`) + annotation + timing;
      console.log(line);
      this.lines.push(line);
    } else {
      let annotation = "";
      if (result.retryExhausted) {
        annotation = chalk.gray(` (failed after ${maxAttempts} attempts)`);
      }
      const timing = chalk.gray(result.retryExhausted ? ` ${result.durationMs}ms` : ` (${result.durationMs}ms)`);
      const line = chalk.red(`  ✗ ${result.testName}`) + annotation + timing;
      console.log(line);
      this.lines.push(line);
      if (result.error) {
        const errLine = chalk.red(`    ${result.error}`);
        console.log(errLine);
        this.lines.push(errLine);
      }
    }
  }

  onRunEnd(summary: RunSummary): void {
    console.log();

    const hooksPassed = summary.hookResults.filter((h) => h.passed).length;
    const hooksFailed = summary.hookResults.filter((h) => !h.passed).length;

    const testStatusColor = summary.failed === 0 ? chalk.green : chalk.red;
    const paramNote =
      summary.parametrizedSourceCount > 0
        ? chalk.gray(
            ` (${summary.total} cases from ${summary.parametrizedSourceCount} parametrized test${summary.parametrizedSourceCount === 1 ? "" : "s"})`
          )
        : "";
    const testLine =
      testStatusColor(`Tests: ${summary.passed} passed, ${summary.failed} failed`) + paramNote;
    console.log(testLine);
    this.lines.push(testLine);

    if (summary.hookResults.length > 0) {
      const hookStatusColor = hooksFailed === 0 ? chalk.green : chalk.red;
      const hookLine = hookStatusColor(
        `Hooks: ${hooksPassed} passed, ${hooksFailed} failed`
      );
      console.log(hookLine);
      this.lines.push(hookLine);
    }

    if (summary.skipped > 0) {
      const skippedLine = chalk.yellow(`Skipped: ${summary.skipped}`);
      console.log(skippedLine);
      this.lines.push(skippedLine);
    }

    const durationLine = chalk.gray(`Total: ${summary.durationMs}ms`);
    console.log(durationLine);
    this.lines.push(durationLine);
  }

  flush(): string {
    return this.lines.join("\n");
  }
}
