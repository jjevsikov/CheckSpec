/**
 * HTMLReporter
 *
 * Generates a self-contained, single-file HTML report from CheckSpec results.
 * No external dependencies — all CSS and JS is inlined.
 *
 * Designed to be:
 *  - Opened directly in a browser (file:// — no server required)
 *  - Saved as a CI artifact
 *  - Embedded in dashboards (the <body> content is self-contained)
 *
 * Features:
 *  - Summary bar with pass/fail counts and timing
 *  - Colour-coded test rows (green pass / red fail / yellow security)
 *  - Expandable error details on click
 *  - Security findings panel
 *  - Responsive layout
 *
 * Usage:
 *  const reporter = new HTMLReporter();
 *  // ... run tests ...
 *  reporter.onRunEnd(summary);
 *  writeFileSync("report.html", reporter.flush());
 */

import type { TestCase } from "../runner/TestCollection.js";
import type { TestResult, RunSummary } from "../runner/TestRunner.js";
import type { Reporter } from "./ConsoleReporter.js";
import type { SecurityFinding } from "../security/SecurityScanner.js";

export class HTMLReporter implements Reporter {
  private results: TestResult[] = [];
  private summary: RunSummary | null = null;
  private findings: SecurityFinding[] = [];
  private serverName = "";
  private startedAt = new Date();

  /**
   * Attach security findings to the report.
   * Call this before flush() for findings to appear in the Security section.
   */
  setSecurityFindings(findings: SecurityFinding[]): void {
    this.findings = findings;
  }

  setServerName(name: string): void {
    this.serverName = name;
  }

  onTestStart(_test: TestCase): void {
    // No-op — HTML report is built after all tests complete
  }

  onTestEnd(result: TestResult): void {
    this.results.push(result);
  }

  onRunEnd(summary: RunSummary): void {
    this.summary = summary;
  }

  flush(): string {
    const summary = this.summary ?? {
      total: this.results.length,
      passed: this.results.filter((r) => r.passed).length,
      failed: this.results.filter((r) => !r.passed).length,
      skipped: 0,
      durationMs: this.results.reduce((a, r) => a + r.durationMs, 0),
      results: this.results,
      hookResults: [],
      parametrizedSourceCount: 0,
    };

    return buildHTMLReport({
      summary,
      results: this.results,
      findings: this.findings,
      serverName: this.serverName,
      generatedAt: this.startedAt,
    });
  }
}

// ── HTML generation ───────────────────────────────────────────────────────────

interface ReportData {
  summary: RunSummary;
  results: TestResult[];
  findings: SecurityFinding[];
  serverName: string;
  generatedAt: Date;
}

function buildHTMLReport(data: ReportData): string {
  const { summary, results, findings, serverName, generatedAt } = data;
  const passRate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
  const hasSecurity = findings.length > 0;
  const title = serverName ? `CheckSpec — ${serverName}` : "CheckSpec Report";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background: #0f0f13;
    color: #e0e0e0;
    min-height: 100vh;
    padding: 0 0 60px;
  }

  /* ── Header ── */
  .header {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border-bottom: 1px solid #2a2a4a;
    padding: 28px 40px 24px;
  }
  .header-top { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
  .header-logo {
    font-size: 22px; font-weight: 800; letter-spacing: -0.5px;
    background: linear-gradient(90deg, #6c8fff, #a78bfa);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .header-server { color: #888; font-size: 13px; }
  .header-meta { color: #555; font-size: 12px; margin-top: 4px; }

  /* ── Summary bar ── */
  .summary {
    display: flex; gap: 24px; flex-wrap: wrap;
    padding: 0 40px; margin-top: 24px;
  }
  .stat {
    background: #1c1c28; border: 1px solid #2e2e42;
    border-radius: 10px; padding: 16px 24px; flex: 1; min-width: 140px;
  }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666; }
  .stat-value { font-size: 32px; font-weight: 700; margin-top: 4px; }
  .stat-value.pass { color: #4ade80; }
  .stat-value.fail { color: #f87171; }
  .stat-value.neutral { color: #94a3b8; }
  .stat-value.warn  { color: #fbbf24; }

  /* ── Progress bar ── */
  .progress-wrap { padding: 24px 40px 0; }
  .progress-bar {
    height: 6px; background: #1e1e2e; border-radius: 999px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, #4ade80, #22c55e);
    transition: width 0.4s ease;
  }
  .progress-fill.failing { background: linear-gradient(90deg, #f87171, #ef4444); }

  /* ── Section ── */
  .section { padding: 32px 40px 0; }
  .section-title {
    font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px;
    color: #666; margin-bottom: 12px; font-weight: 600;
  }

  /* ── Test rows ── */
  .test-table { width: 100%; border-collapse: collapse; }
  .test-row {
    border-bottom: 1px solid #1e1e2e; cursor: pointer;
    transition: background 0.1s;
  }
  .test-row:hover { background: #1c1c28; }
  .test-row.pass  .test-status { color: #4ade80; }
  .test-row.fail  .test-status { color: #f87171; }
  .test-row.security-fail .test-status { color: #fbbf24; }

  .test-status { width: 24px; padding: 10px 0 10px 16px; font-size: 15px; }
  .test-name   { padding: 10px 8px; font-size: 13px; width: 100%; }
  .test-type   { padding: 10px 8px; font-size: 11px; color: #555; white-space: nowrap; }
  .test-time   { padding: 10px 16px 10px 8px; font-size: 12px; color: #555; white-space: nowrap; }

  .test-detail {
    display: none; background: #131320;
    border-top: 1px solid #1e1e2e; border-bottom: 1px solid #1e1e2e;
  }
  .test-detail.open { display: table-row; }
  .test-detail-inner { padding: 12px 16px 12px 40px; }
  .test-error { color: #f87171; font-size: 12px; font-family: "Courier New", monospace; margin-bottom: 8px; }
  .test-block-title { font-size: 11px; text-transform: uppercase; color: #888; margin-top: 12px; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.5px; }
  .test-block-code { background: #0d0d1a; color: #d4d4d8; padding: 10px; border-radius: 6px; font-family: "Courier New", monospace; font-size: 12px; overflow-x: auto; border: 1px solid #1e1e2e; margin-bottom: 12px; white-space: pre-wrap; word-wrap: break-word; max-height: 400px; }
  .test-tags  { margin-top: 12px; display: flex; gap: 6px; flex-wrap: wrap; }
  .tag {
    background: #1e1e2e; border: 1px solid #2e2e42;
    border-radius: 4px; padding: 2px 6px; font-size: 10px; color: #666;
  }

  /* ── Security findings ── */
  .finding {
    background: #1c1c28; border: 1px solid #2e2e42;
    border-radius: 8px; padding: 16px; margin-bottom: 12px;
  }
  .finding.critical { border-color: #7f1d1d; background: #1c1012; }
  .finding.high     { border-color: #7c2d12; background: #1c1209; }
  .finding.medium   { border-color: #78350f; background: #1c1600; }
  .finding.low      { border-color: #365314; background: #111a07; }
  .finding-badge {
    display: inline-block; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 1px;
    padding: 3px 8px; border-radius: 4px; margin-bottom: 8px;
  }
  .finding-badge.critical { background: #7f1d1d; color: #fca5a5; }
  .finding-badge.high     { background: #7c2d12; color: #fb923c; }
  .finding-badge.medium   { background: #78350f; color: #fbbf24; }
  .finding-badge.low      { background: #365314; color: #86efac; }
  .finding-type  { font-size: 14px; font-weight: 600; color: #e0e0e0; }
  .finding-desc  { font-size: 12px; color: #888; margin-top: 4px; }
  .finding-evidence {
    margin-top: 8px; font-family: "Courier New", monospace;
    font-size: 11px; color: #666; background: #0d0d1a;
    padding: 8px 10px; border-radius: 4px; word-break: break-all;
  }

  /* ── Footer ── */
  .footer {
    text-align: center; color: #333; font-size: 11px;
    margin-top: 48px; padding: 0 40px;
  }

  @media (max-width: 600px) {
    .header, .summary, .section, .progress-wrap, .footer { padding-left: 16px; padding-right: 16px; }
    .test-type, .test-time { display: none; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-top">
    <div class="header-logo">CheckSpec</div>
    ${serverName ? `<div class="header-server">${escHtml(serverName)}</div>` : ""}
  </div>
  <div class="header-meta">Generated ${generatedAt.toLocaleString()} · ${summary.total} tests · ${summary.durationMs}ms</div>
</div>

<div class="summary">
  <div class="stat">
    <div class="stat-label">Passed</div>
    <div class="stat-value pass">${summary.passed}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Failed</div>
    <div class="stat-value ${summary.failed > 0 ? "fail" : "pass"}">${summary.failed}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Pass rate</div>
    <div class="stat-value ${passRate === 100 ? "pass" : passRate >= 80 ? "neutral" : "fail"}">${passRate}%</div>
  </div>
  <div class="stat">
    <div class="stat-label">Duration</div>
    <div class="stat-value neutral">${formatDuration(summary.durationMs)}</div>
  </div>
  ${hasSecurity ? `<div class="stat">
    <div class="stat-label">Security findings</div>
    <div class="stat-value warn">${findings.length}</div>
  </div>` : ""}
</div>

<div class="progress-wrap">
  <div class="progress-bar">
    <div class="progress-fill${summary.failed > 0 ? " failing" : ""}" style="width:${passRate}%"></div>
  </div>
</div>

<div class="section">
  <div class="section-title">Test Results</div>
  <table class="test-table">
    <tbody>
      ${results.map((r, i) => renderTestRow(r, i)).join("\n      ")}
    </tbody>
  </table>
</div>

${hasSecurity ? `<div class="section">
  <div class="section-title">Security Findings</div>
  ${findings.map(renderFinding).join("\n  ")}
</div>` : ""}

<div class="footer">
  CheckSpec · <a href="https://github.com/jjevsikov/CheckSpec" style="color:#444;text-decoration:none">github.com/jjevsikov/CheckSpec</a>
</div>

<script>
  document.querySelectorAll('.test-row').forEach(function(row) {
    row.addEventListener('click', function() {
      var id = row.dataset.id;
      var detail = document.getElementById('detail-' + id);
      if (detail) detail.classList.toggle('open');
    });
  });
</script>
</body>
</html>`;
}

// ── Row renderers ─────────────────────────────────────────────────────────────

function renderTestRow(result: TestResult, index: number): string {
  const isSecFail = !result.passed && result.testName.includes("security");
  const rowClass = result.passed ? "pass" : isSecFail ? "security-fail" : "fail";
  const icon = result.passed ? "✓" : "✗";
  const tags = (result.tags ?? []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join("");

  let extraHtml = "";
  if (result.testCase?.input) {
    extraHtml += `<div class="test-block-title">Input:</div>
<pre class="test-block-code">${escHtml(JSON.stringify(result.testCase.input, null, 2))}</pre>`;
  }
  if (result.actual !== undefined) {
    const isError = result.actual && typeof result.actual === "object" && "isError" in result.actual && result.actual.isError;
    const actualStr = JSON.stringify(result.actual, null, 2);
    extraHtml += `<div class="test-block-title">Output${isError ? " (server error)" : ""}:</div>
<pre class="test-block-code" ${isError ? 'style="border-color:#7f1d1d"' : ''}>${escHtml(actualStr)}</pre>`;
  }

  return `<tr class="test-row ${rowClass}" data-id="${index}">
      <td class="test-status">${icon}</td>
      <td class="test-name">${escHtml(result.testName)}</td>
      <td class="test-type">${escHtml(result.testType ?? "")}</td>
      <td class="test-time">${result.durationMs}ms</td>
    </tr>
    <tr class="test-detail" id="detail-${index}">
      <td colspan="4">
        <div class="test-detail-inner">
          ${result.error ? `<div class="test-error">${escHtml(result.error)}</div>` : ""}
          ${!result.error && !extraHtml ? "<div style='color:#555;font-size:12px'>No additional details</div>" : ""}
          ${extraHtml}
          ${tags ? `<div class="test-tags">${tags}</div>` : ""}
        </div>
      </td>
    </tr>`;
}

function renderFinding(f: SecurityFinding): string {
  const sev = escHtml(f.severity);
  return `<div class="finding ${sev}">
    <span class="finding-badge ${sev}">${sev}</span>
    <div class="finding-type">${escHtml(f.type)}${f.tool ? ` — ${escHtml(f.tool)}` : ""}</div>
    <div class="finding-desc">${escHtml(f.description)}</div>
    ${f.evidence ? `<div class="finding-evidence">${escHtml(f.evidence)}</div>` : ""}
  </div>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
