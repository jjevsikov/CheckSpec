# Using CheckSpec with Python MCP Servers

CheckSpec is fully language-agnostic. Because the MCP protocol runs over **stdio JSON-RPC**, any server that speaks MCP — regardless of implementation language — works out of the box.

This guide covers Python specifically, since Python servers have a few extra setup requirements compared to Node.js.

---

## Prerequisites

Install the Python MCP package using [uv](https://docs.astral.sh/uv/) (recommended) or pip:

```bash
# uv (recommended — handles virtual envs automatically)
uv add "mcp[cli]"

# or pip inside a venv
pip install "mcp[cli]"
```

---

## Minimal FastMCP server

```python
# my_server.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-server")

@mcp.tool()
def greet(name: str) -> str:
    """Return a greeting for the given name."""
    return f"Hello, {name}!"

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

---

## Running CheckSpec against it

### Using `--cwd` (recommended)

The `--cwd` flag sets the working directory for the server process. This lets `uv run` pick up the correct virtual environment automatically:

```bash
# Scan and auto-generate tests
checkspec scan "uv run my_server.py" --cwd /path/to/project

# Inspect capabilities
checkspec inspect "uv run my_server.py" --cwd /path/to/project

# Run a saved collection
checkspec test my_server.checkspec.json --cwd /path/to/project
```

### Inline `--directory` (no `--cwd` needed)

If you prefer to keep the directory embedded in the command itself (e.g. because you already have a server config that uses `uv --directory`), pass the whole thing as the server command:

```bash
# uv --directory style (args before "run")
checkspec scan "uv --directory /path/to/project run my_server.py"

# uv run --directory style (args after "run")
checkspec scan "uv run --directory /path/to/project my_server.py"
```

**Example** — `file_reader` server with its config already written as:
```json
{
  "command": "uv",
  "args": ["--directory", "/path/to/file_reader", "run", "file_reader.py"]
}
```

Scan it directly on the command line:
```bash
checkspec scan "uv --directory /path/to/file_reader run file_reader.py"
```

Inspect it:
```bash
checkspec inspect "uv --directory /path/to/file_reader run file_reader.py"
```

Or save the generated collection once and re-run from it:
```bash
checkspec scan "uv --directory /path/to/file_reader run file_reader.py" \
  --save file_reader.checkspec.json

checkspec test file_reader.checkspec.json
```

### Using pip/venv directly

```bash
# Activate your venv first, then:
checkspec scan "python my_server.py" --cwd /path/to/project
```

---

## Saving a collection

Use `--save` to persist the auto-generated collection so you can re-run it in CI:

```bash
checkspec scan "uv run my_server.py" \
  --cwd /path/to/project \
  --save my_server.checkspec.json
```

The saved `my_server.checkspec.json` stores the `cwd` field, so you don't need to pass `--cwd` again for `checkspec test`:

```bash
checkspec test my_server.checkspec.json
```

---

## Suppressing Python log noise

Python MCP servers (FastMCP in particular) write verbose `INFO` log lines to stderr:

```
INFO     Processing request of type ListToolsRequest
INFO     Processing request of type CallToolRequestParams
```

CheckSpec suppresses server stderr by default so these don't pollute your test output. To see them (useful when debugging a broken server), add `--verbose`:

```bash
checkspec scan "uv run my_server.py" --cwd /path/to/project --verbose
```

---

## Setting environment variables

Pass `--env KEY=VALUE` (repeatable) to inject environment variables into the server process:

```bash
checkspec scan "uv run my_server.py" \
  --cwd /path/to/project \
  --env API_KEY=test123 \
  --env DATABASE_URL=sqlite:///test.db
```

Environment variables can also be stored in the collection file's `server.env` field:

```json
{
  "server": {
    "command": "uv",
    "args": ["run", "my_server.py"],
    "cwd": "/path/to/project",
    "env": {
      "API_KEY": "test123"
    }
  }
}
```

---

## Common errors

### `ModuleNotFoundError: No module named 'mcp'`

**Cause:** `uv run` couldn't find the virtual environment with `mcp` installed.

**Fix:** Add `--cwd` pointing to the project directory:

```bash
checkspec scan "uv run my_server.py" --cwd /path/to/project
```

Or use `uv run --directory`:

```bash
checkspec scan "uv run --directory /path/to/project my_server.py"
```

### `spawn uv ENOENT`

**Cause:** `uv` is not on your `PATH`.

**Fix:** Install uv from [astral.sh/uv](https://docs.astral.sh/uv/) or use `python` directly.

### Server connects but all tests fail

**Cause:** The server started but isn't responding. Add `--verbose` to see server output:

```bash
checkspec scan "uv run my_server.py" --cwd /path/to/project --verbose
```

---

## Collection file example (Python server)

```json
{
  "version": "1.0",
  "name": "My Python MCP Server",
  "server": {
    "command": "uv",
    "args": ["run", "my_server.py"],
    "cwd": "/path/to/project",
    "env": {
      "LOG_LEVEL": "WARNING"
    }
  },
  "tests": [
    {
      "id": "greet-valid",
      "name": "greet tool - valid input",
      "type": "tool-call",
      "tool": "greet",
      "input": { "name": "Alice" },
      "expect": { "success": true },
      "tags": ["smoke"]
    }
  ]
}
```

---

## CI/CD example (GitHub Actions)

```yaml
- name: Set up uv
  uses: astral-sh/setup-uv@v4

- name: Install Python deps
  run: uv sync
  working-directory: my-python-server/

- name: Install checkspec
  run: npm install -g @checkspec/cli

- name: Run MCP tests
  run: |
    checkspec test my-python-server/server.checkspec.json \
      --output junit \
      > test-results.xml

- name: Upload results
  uses: actions/upload-artifact@v4
  with:
    name: checkspec-results
    path: test-results.xml
```
