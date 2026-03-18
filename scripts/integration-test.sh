#!/usr/bin/env bash
# Integration test script — verifies the CLI works end-to-end against all fixtures.
# Run this before pushing or via: npm run test:integration

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="node $ROOT/packages/cli/dist/index.js"
ECHO="node $ROOT/fixtures/echo-server/dist/index.js"
MALICIOUS="node $ROOT/fixtures/malicious-server/dist/index.js"
BUGGY="node $ROOT/fixtures/buggy-server/dist/index.js"
TMP="$(mktemp -d)"

trap 'rm -rf "$TMP"' EXIT

echo ""
echo "CheckSpec Integration Tests"
echo "════════════════════════════════════"

# ── Build check ──────────────────────────────────────────────────────────────
echo ""
echo "Checking build artifacts..."
for f in \
  "$ROOT/packages/cli/dist/index.js" \
  "$ROOT/fixtures/echo-server/dist/index.js" \
  "$ROOT/fixtures/malicious-server/dist/index.js" \
  "$ROOT/fixtures/buggy-server/dist/index.js"; do
  if [[ ! -f "$f" ]]; then
    echo "  ✗ Missing: $f"
    echo "  Run 'npm run build' first."
    exit 1
  fi
done
echo "  ✓ All build artifacts present"

# ── 1. Echo server — tool tests must pass ────────────────────────────────────
echo ""
echo "1. Scanning echo-server (tool tests must pass)..."
$CLI scan "$ECHO" --output json > "$TMP/echo.json" || true

TOOL_FAILS=$(node -e "
  const r = JSON.parse(require('fs').readFileSync('$TMP/echo.json','utf8'));
  const fails = r.results.filter(t => t.testName.includes('valid input') && !t.passed);
  process.stdout.write(String(fails.length));
")

if [[ "$TOOL_FAILS" -gt 0 ]]; then
  echo "  ✗ Echo server tool tests had unexpected failures"
  node -e "
    const r = JSON.parse(require('fs').readFileSync('$TMP/echo.json','utf8'));
    r.results.filter(t => t.testName.includes('valid input') && !t.passed)
      .forEach(t => console.error('    -', t.testName, ':', t.error));
  "
  exit 1
fi
ECHO_TOTAL=$(node -e "const r=JSON.parse(require('fs').readFileSync('$TMP/echo.json','utf8')); process.stdout.write(String(r.total))")
echo "  ✓ Echo server: tool tests passed ($ECHO_TOTAL total tests run)"

# ── 2. Malicious server — scanner must exit non-zero (critical finding) ───────
echo ""
echo "2. Scanning malicious-server (scanner must detect critical findings)..."
if $CLI scan "$MALICIOUS" --output json > "$TMP/malicious.json" 2>/dev/null; then
  # Exit 0 means no critical findings AND no test failures — scanner is broken
  echo "  ✗ Malicious server scan exited 0 — expected critical security findings"
  exit 1
fi
MALICIOUS_TOTAL=$(node -e "const r=JSON.parse(require('fs').readFileSync('$TMP/malicious.json','utf8')); process.stdout.write(String(r.total))")
echo "  ✓ Malicious server: critical security finding detected (exit 1 as expected, $MALICIOUS_TOTAL tests run)"

# ── 3. Buggy server — --fuzz must produce valid JSON even with failures ───────
echo ""
echo "3. Scanning buggy-server with --fuzz (output must be valid JSON)..."
$CLI scan "$BUGGY" --fuzz --output json > "$TMP/buggy.json" 2>/dev/null || true

IS_VALID=$(node -e "
  try {
    const r = JSON.parse(require('fs').readFileSync('$TMP/buggy.json','utf8'));
    process.stdout.write(typeof r.total === 'number' ? 'yes' : 'no');
  } catch { process.stdout.write('no'); }
")

if [[ "$IS_VALID" != "yes" ]]; then
  echo "  ✗ Buggy server scan did not produce valid RunSummary JSON"
  exit 1
fi
BUGGY_TOTAL=$(node -e "const r=JSON.parse(require('fs').readFileSync('$TMP/buggy.json','utf8')); process.stdout.write(String(r.total))")
echo "  ✓ Buggy server: valid JSON output ($BUGGY_TOTAL tests, some failures expected)"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════"
echo "All integration checks passed ✓"
echo ""
