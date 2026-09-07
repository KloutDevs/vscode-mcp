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

`cursor_send`, `cursor_send_and_wait`, `cursor_read_chat`, and `cursor_list_workspaces` talk directly to Cursor's Chrome DevTools Protocol (CDP) debug port and to its `state.vscdb` SQLite database — they do **not** require the `cursor-mcp-bridge` extension. All other Cursor-control tools do require the extension (see below) running in the target Cursor window, and take a `port` argument for its fixed HTTP bridge port.

**Requirement**: Cursor must be launched with `--remote-debugging-port=<port>` (default `9222`) for the CDP-based tools to work. See [CDP debug port setup](#cdp-debug-port-setup-required-for-chat-tools) below.

| Tool | Description |
|------|-------------|
| `cursor_list_workspaces` | Discover all open Cursor windows via CDP `/json/list` — returns `{page_id, title}` per window, no registry file, no port scanning |
| `cursor_status` | Check bridge status for a given port |
| `cursor_list_commands` | List Cursor/VS Code commands available in a window, optionally filtered |
| `cursor_open_chat` | Open a new chat/composer/agent panel; returns `since_ms`, `workspace`, `port` to scope subsequent calls |
| `cursor_send_and_wait` | Send a message via CDP trusted input and block until Cursor's agent response is marked `"completed"` in `state.vscdb` (no polling of any HTTP endpoint, no `fs.watch`) |
| `cursor_send` | Send a message via CDP trusted input and return as soon as it's delivered (no waiting for the reply); supports `composer_id` for targeting a specific agent tab |
| `cursor_read_chat` | Read the conversation history of a session by `composer_id`, read directly from `state.vscdb` |
| `cursor_get_model` | Get the currently configured AI model |
| `cursor_set_model` | Change the active AI model |
| `cursor_open_model_picker` | Open the model selector UI |
| `cursor_open_file` | Open a file in the editor, optionally at a specific line |
| `cursor_editor_state` | Get the active editor's file, cursor position, selection, open editors |
| `cursor_diagnostics` | Get all errors/warnings from the window's language servers |
| `cursor_run_command` | Execute any VS Code / Cursor command by ID |
| `cursor_deploy_extension` | Build, package, install, and reload the `cursor-mcp-bridge` extension in one shot |

### CDP debug port setup (required for chat tools)

`cursor_send`, `cursor_send_and_wait`, `cursor_read_chat`, and `cursor_list_workspaces` connect to Cursor's native Chrome DevTools Protocol debug port. Cursor must be relaunched with `--remote-debugging-port` for these to work — the flag cannot be enabled while Cursor is already running.

Set the `CURSOR_CDP_PORT` environment variable if you use a non-default port (default `9222`) when running the `vscode-mcp` server — see the MCP server config examples below (`env` field).

**macOS** — quit Cursor fully, then relaunch from a terminal:

```bash
open -a Cursor --args --remote-debugging-port=9222
```

To make this persistent (survive Dock/Spotlight launches too), edit Cursor's `Info.plist` launch arguments or wrap the app in a shell alias that always passes the flag before opening it normally.

**Linux** — launch (or add to your `.desktop` file's `Exec=` line):

```bash
cursor --remote-debugging-port=9222
```

**Windows** — add the flag to the shortcut target, or launch from PowerShell/cmd:

```powershell
cursor.exe --remote-debugging-port=9222
```

For a persistent setup on any OS, edit the application's launch shortcut/`.desktop` entry once so every normal launch (Dock, Start Menu, taskbar) includes the flag — this needs to be done only once per machine.

## The `cursor-mcp-bridge` extension

`extension/` is a small VS Code/Cursor extension that exposes an HTTP bridge for VS Code-command-dependent tools (`/command`, `/editor/*`, `/diagnostics`, `/model/*`, `/commands`, `/status`). It is cross-platform (macOS, Linux, Windows) and listens on a fixed, configurable port (default `9421`, set via the `cursorMcpBridge.port` VS Code setting).

Chat send/read/discovery no longer go through this extension — they use CDP and direct SQLite reads from the client (see [CDP debug port setup](#cdp-debug-port-setup-required-for-chat-tools) above).

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
      "args": ["/absolute/path/to/vscode-mcp/dist/index.js"],
      "env": { "CURSOR_CDP_PORT": "9222" }
    }
  }
}
```

`CURSOR_CDP_PORT` (default `9222`) must match the `--remote-debugging-port` value Cursor was launched with.

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
