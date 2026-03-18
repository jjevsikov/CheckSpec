import type { TestCase } from "../runner/TestCollection.js";
import type { TestResult, RunSummary } from "../runner/TestRunner.js";
import type { Reporter } from "./ConsoleReporter.js";

/**
 * Machine-readable JSON reporter. Outputs the full RunSummary as JSON.
 */
export class JSONReporter implements Reporter {
  private summary: RunSummary | null = null;

  onTestStart(_test: TestCase): void {
    // no-op
  }

  onTestEnd(_result: TestResult): void {
    // no-op — all data comes from RunSummary
  }

  onRunEnd(summary: RunSummary): void {
    this.summary = summary;
  }

  flush(): string {
    return JSON.stringify(this.summary, null, 2);
  }
}
