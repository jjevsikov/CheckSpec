#!/usr/bin/env bash
# Run CheckSpec collections against all demo servers.
# Run from the repository root: npm run demo
# Or directly: bash demos/run-all.sh
#
# Expected outcomes:
#   calculator-server   — ALL PASS   (clean server, no security findings)
#   filesystem-server   — SECURITY   (delete_file has rug-pull HIGH finding)
#   sqlite-server       — ALL PASS   (clean, no security findings)
#   task-manager-server — FAIL + SEC (missing dueDate validation + SYSTEM: directive)
#   notes-server        — ALL PASS   (clean server, no security findings)
#   streaming-server    — 7/8 PASS   (1 deliberate fail: minChunks=999)
#   stateful-server     — 5/6 PASS   (1 deliberate fail: string not found; hooks demo)

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $REPO_ROOT/packages/cli/dist/index.js"

print_header() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── 1. Calculator server ──────────────────────────────────────────────────────
print_header "calculator-server  (expected: ALL PASS)"
$CLI test "$REPO_ROOT/demos/calculator-server/calculator.checkspec.json" || true

# ── 2. Filesystem server ─────────────────────────────────────────────────────
print_header "filesystem-server  (expected: SECURITY rug-pull HIGH on delete_file)"
$CLI test "$REPO_ROOT/demos/filesystem-server/filesystem.checkspec.json" || true

# ── 3. SQLite server ─────────────────────────────────────────────────────────
print_header "sqlite-server  (expected: ALL PASS, clean)"
$CLI test "$REPO_ROOT/demos/sqlite-server/sqlite.checkspec.json" || true

# ── 4. Task manager server ───────────────────────────────────────────────────
print_header "task-manager-server  (expected: 1 FAILED test + SECURITY finding)"
$CLI test "$REPO_ROOT/demos/task-manager-server/task-manager.checkspec.json" || true

# ── 5. Notes server ───────────────────────────────────────────────────────────
print_header "notes-server  (expected: ALL PASS)"
$CLI test "$REPO_ROOT/demos/notes-server/notes.checkspec.json" || true

# ── 6. Streaming server ───────────────────────────────────────────────────────
print_header "streaming-server  (expected: 7/8 pass, 1 deliberate fail on minChunks)"
$CLI test "$REPO_ROOT/demos/streaming-server/streaming.checkspec.json" || true

# ── 7. Stateful server (hooks demo) ──────────────────────────────────────────
print_header "stateful-server  (expected: 5/6 pass, 1 deliberate fail on missing string)"
$CLI test "$REPO_ROOT/demos/stateful-server/stateful.checkspec.json" || true

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Demo run complete."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Tip: Run with --fuzz to see full fuzz testing:"
echo "  node packages/cli/dist/index.js scan \\"
echo "    \"node demos/calculator-server/dist/index.js\" --fuzz"
