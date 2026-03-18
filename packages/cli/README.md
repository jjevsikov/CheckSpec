# @checkspec/cli

Command-line interface for [CheckSpec](https://github.com/jjevsikov/CheckSpec) — the test framework for MCP servers.

## Install

```bash
npm install -g @checkspec/cli
```

Or run directly with npx:

```bash
npx checkspec scan "node dist/my-server.js"
```

## Commands

```bash
# Auto-scan: discover tools, fuzz inputs, run security checks
checkspec scan "node dist/server.js"

# Run a custom test collection
checkspec test my-server.checkspec.json

# Scaffold a starter collection from a live server
checkspec init "node dist/server.js" --out my-server.checkspec.json

# Detect schema drift against a saved baseline
checkspec diff "node dist/server.js"

# Display all server capabilities
checkspec inspect "node dist/server.js"

# AI-generate a test collection (requires ANTHROPIC_API_KEY)
checkspec generate "node dist/server.js" --out tests.checkspec.json

# Convert saved results to another format
checkspec report results.json --format junit
```

All commands support `--url` for HTTP servers and `--cwd` / `--env` for environment control. Run `checkspec --help` for the full option list.

## Documentation

Full docs, examples, and the collection format reference are in the [main repository](https://github.com/jjevsikov/CheckSpec).

## License

MIT
