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

### Cursor-control tools

These require the `cursor-mcp-bridge` extension (see below) to be installed and running in the target Cursor window(s). All tools other than `cursor_list_workspaces` and `cursor_deploy_extension` take a `port` argument identifying which Cursor window to talk to — get it from `cursor_list_workspaces` or `cursor_open_chat`.

| Tool | Description |
|------|-------------|
| `cursor_list_workspaces` | Discover all active Cursor bridge instances via the shared registry file — returns `{port, workspace}` per open window, no port scanning |
| `cursor_status` | Check bridge status for a given port |
| `cursor_list_commands` | List Cursor/VS Code commands available in a window, optionally filtered |
| `cursor_open_chat` | Open a new chat/composer/agent panel; returns `since_ms`, `workspace`, `port` to scope subsequent calls |
| `cursor_send_and_wait` | Send a message and block until Cursor's agent finishes responding (via `fs.watch` on the transcript, no polling) |
| `cursor_send` | Send a message and return as soon as it's confirmed in the transcript (no waiting for the reply); supports `composer_id` for targeting a specific agent tab |
| `cursor_read_chat` | Read the conversation history of a session, by `composer_id` or `since_ms` |
| `cursor_get_model` | Get the currently configured AI model |
| `cursor_set_model` | Change the active AI model |
| `cursor_open_model_picker` | Open the model selector UI |
| `cursor_open_file` | Open a file in the editor, optionally at a specific line |
| `cursor_editor_state` | Get the active editor's file, cursor position, selection, open editors |
| `cursor_diagnostics` | Get all errors/warnings from the window's language servers |
| `cursor_run_command` | Execute any VS Code / Cursor command by ID |
| `cursor_deploy_extension` | Build, package, install, and reload the `cursor-mcp-bridge` extension in one shot |

## The `cursor-mcp-bridge` extension

`extension/` is a small VS Code/Cursor extension that exposes an HTTP bridge for the Cursor-control tools above. It is cross-platform (macOS, Linux, Windows).

**Dynamic port + registry discovery**: on activation, the extension binds to an OS-assigned ephemeral port (`listen(0, ...)`) instead of a fixed port, so multiple Cursor windows never collide. It publishes `{port, workspace, pid, startedAt}` to a shared JSON registry file at `~/.vscode-mcp-bridge/registry.json` (`$USERPROFILE` on Windows, `$HOME` on macOS/Linux) and removes its entry on deactivation. The client reads this registry via `cursor_list_workspaces` to discover every active window — no port scanning — and passively filters out dead entries by checking `process.kill(pid, 0)` (handles Cursor windows that exit abruptly without running `deactivate`).

**Chat message delivery**: sending a message pastes it into the chat input via the clipboard, then presses Enter using [`@nut-tree-fork/nut-js`](https://github.com/nut-tree/nut.js) — one cross-platform code path (previously Windows-only PowerShell `SendKeys`).

- **macOS**: the first keystroke triggers an Accessibility permission prompt. Grant it to the Cursor / Extension Host process, or `cursor_send`/`cursor_send_and_wait` will silently fail to submit.
- **Focus-stealing limitation (accepted, not fixable)**: `nut-js` presses the key into whichever window currently has OS focus. There is no known way to deliver a keystroke to a specific window without it holding focus, on any OS. Cursor must be the frontmost window when a send is triggered.
- **Command-ID caveat**: internal Cursor command IDs used for opening/sending chat (`glass.*`, `composer.newAgentChat`, etc.) are undocumented and may change or break on Cursor updates — this is a pre-existing risk, not introduced by this bridge.

Building and deploying the extension:

```bash
bash scripts/deploy.sh
```

This builds the MCP server and the extension, packages a `.vsix`, installs it into Cursor's extensions directory, and reloads the active window.

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
