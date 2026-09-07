# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `cursor_list_workspaces` now returns `extension_port` and the list of open agent/composer conversations (`composer_id`, name, last-updated time, mode) per window, read directly from `state.vscdb`.
- Per-window dynamic port + registry (`~/.cursor-bridge/registry.json`) restored for the extension's HTTP bridge, so command-dependent tools (`cursor_set_model`, `cursor_diagnostics`, `cursor_open_file`, etc.) work correctly with multiple Cursor windows open at once.

### Fixed
- `cursor_send`/`cursor_send_and_wait` without a known `composer_id` now correctly detect which tab received the message by asking the extension which composer is actually selected, instead of guessing via SQLite's `rowid` ordering (which doesn't reliably track recency — Cursor touches unrelated composer rows in the background).
- `cursor_send`/`cursor_send_and_wait` no longer time out when the message lands in an already-open tab instead of a freshly created one.

## [1.0.0] — 2026-09-07

Renamed from `vscode-mcp` to `cursor-bridge` to reflect its actual scope: controlling Cursor's chat/agent panels, not a general VS Code integration.

### Added
- **CDP-based chat send/read** (`src/cdp.ts`, `src/composerStore.ts`): messages are sent via Chrome DevTools Protocol trusted input (`Input.insertText` + `Input.dispatchKeyEvent`), and conversation state is read directly from Cursor's `state.vscdb` SQLite database — replacing the previous PowerShell/`nut-js` keystroke simulation and JSONL transcript watching entirely.
- Requires launching Cursor with `--remote-debugging-port` (see README).

### Removed
- `@nut-tree-fork/nut-js` dependency and all OS-level keystroke simulation from the extension.
- JSONL-based transcript reading (`/chat/read`, `fs.watch`) — that storage format doesn't exist in current Cursor versions.

## [0.x] — consolidation (2026-09-06)

- Consolidated three overlapping MCP clients (`nexus-mcp`, `klout-mcp`, and this project's own client) into one: filesystem tools plus the full Cursor-control tool set (multi-window discovery, multi-tab send via `composer_id`).
- `nexus-mcp` and `klout-mcp` are archived; this repo is their successor.
- Cross-platform fixes to `scripts/deploy.sh` (was Windows-only via `$USERPROFILE`).

## Earlier history

Before the consolidation above, this project (as `vscode-mcp`) grew iteratively from a basic filesystem MCP server into a full Cursor-control bridge — session isolation via `composer_id`, blocking `cursor_send_and_wait`, `/chat/status` response detection, and various fixes to the Windows-only send mechanism that predated the CDP rewrite. See `git log` for the full commit-by-commit history.

[Unreleased]: https://github.com/KloutDevs/cursor-bridge/compare/main...HEAD
