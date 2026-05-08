# vscode-mcp

An MCP (Model Context Protocol) server that gives Claude IDE capabilities inside VS Code and Cursor. Claude can read, write, edit, search, and run commands in your workspace — directly from the chat.

## Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents, with optional line range |
| `write_file` | Write or overwrite a file (creates parent dirs) |
| `edit_file` | Replace an exact string in a file |
| `list_directory` | List files and dirs (optionally recursive) |
| `create_directory` | Create a directory tree |
| `delete_path` | Delete a file or directory |
| `move_path` | Move or rename a file/directory |
| `search_files` | Grep-style regex search across files |
| `find_files` | Find files by glob pattern (e.g. `*.ts`) |
| `run_command` | Execute any shell command, capture output |
| `get_workspace_info` | Platform, Node version, git branch & status |
| `get_file_info` | File metadata (size, modified time, type) |

## Installation

```bash
npm install
npm run build
```

## Using with Cursor

Cursor reads MCP server configuration from:
- **Global**: `~/.cursor/mcp.json`
- **Project**: `.cursor/mcp.json` (in your project root)

### Option A — run via `node` (after build)

Add to your Cursor MCP config:

```json
{
  "mcpServers": {
    "vscode-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/vscode-mcp/dist/index.js"]
    }
  }
}
```

### Option B — run via `npx` (no manual build needed)

```json
{
  "mcpServers": {
    "vscode-mcp": {
      "command": "npx",
      "args": ["--yes", "vscode-mcp"]
    }
  }
}
```

> After editing the config, open **Cursor Settings → Features → MCP** and click **Refresh** (or restart Cursor).

## Using with VS Code + Copilot Chat (MCP support)

Add to your VS Code `settings.json`:

```json
"mcp": {
  "servers": {
    "vscode-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/vscode-mcp/dist/index.js"]
    }
  }
}
```

## Development

```bash
npm run dev    # watch mode (recompiles on save)
npm start      # run the built server
```

## Tips

- All paths can be **absolute** or **relative to the workspace root**.
- Pass `workspace_root` to any tool to anchor relative paths to a specific directory.
- `run_command` accepts any shell command — use it for `git`, `npm`, linters, compilers, etc.
- `search_files` skips `node_modules`, `dist`, and hidden folders automatically.
