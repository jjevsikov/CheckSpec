#!/usr/bin/env bash
# Build all CheckSpec demo servers.
# Run from the repository root: npm run demo:build
# Or directly: bash demos/build-all.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SERVERS=(
  calculator-server
  filesystem-server
  sqlite-server
  task-manager-server
  notes-server
  streaming-server
  stateful-server
)

echo "Building CheckSpec demo servers..."
echo ""

for server in "${SERVERS[@]}"; do
  dir="$REPO_ROOT/demos/$server"
  echo "  ▶ Building $server..."
  (cd "$dir" && npm run build 2>&1 | sed 's/^/    /')
  echo "  ✓ $server built"
  echo ""
done

echo "All demo servers built successfully."
echo ""
echo "Run the demos:"
echo "  npm run demo                    # run all collections"
echo "  bash demos/run-all.sh           # same"
echo ""
echo "Or run a single server:"
echo "  node packages/cli/dist/index.js test demos/calculator-server/calculator.checkspec.json"
