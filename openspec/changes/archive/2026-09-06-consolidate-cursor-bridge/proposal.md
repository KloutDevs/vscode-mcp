# Proposal: Consolidate Cursor Bridge into One Cross-Platform Client

## Intent

Three overlapping MCP clients (`nexus-mcp`, `klout-mcp`, `vscode-mcp/src/index.ts`) duplicate Cursor-control logic with divergent tool names and capabilities, and the bridge extension is Windows-only. On this Mac the PowerShell keystroke path and `$USERPROFILE`/hardcoded Windows paths simply fail. Consolidate into a single cross-platform client so delegating tasks between Claude Code and Cursor works with multi-window and multi-tab support on any OS.

## Scope

### In Scope
- Merge all three clients into one at `vscode-mcp/src/index.ts` (filesystem tools + full Cursor tool set from `nexus-mcp`, incl. `cursor_list_workspaces` and `composer_id` multi-tab).
- Archive `nexus-mcp` and `klout-mcp` via README notice (repos kept, not deleted).
- Replace PowerShell `sendEnterKey` with one `@nut-tree-fork/nut-js` implementation.
- Replace fixed/scanned ports with OS-assigned ephemeral port + shared registry at `~/.vscode-mcp-bridge/registry.json`; client discovers windows by reading the registry.
- Fix `scripts/deploy.sh` for Mac/Linux and remove the hardcoded Windows path in `cursor_deploy_extension`.

### Out of Scope
- Removing the focus-stealing behavior on Enter (accepted, unavoidable limitation — documented only).
- Multi-editor support (VS Code/Windsurf/VSCodium); command IDs stay Cursor-specific.
- Not porting `nexus-mcp`'s machine-specific embedded context document.

## Capabilities

### New Capabilities
- `cursor-control`: unified Cursor control tools (list workspaces, status, open/send/read chat, model get/set, open file, diagnostics, run/list commands) with multi-window and multi-tab (`composer_id`) support.
- `bridge-discovery`: ephemeral-port binding by the extension + shared registry file; client discovery with passive dead-PID cleanup.
- `extension-deployment`: cross-platform `deploy.sh` and runtime-resolved `cursor_deploy_extension` path.
- `chat-confirmation`: cross-platform Enter keystroke via nut-js, replacing PowerShell.

### Modified Capabilities
- None (no prior OpenSpec specs exist).

## Approach

Fold `nexus-mcp`'s more complete Cursor tool set into `vscode-mcp/src/index.ts`, keeping existing filesystem tools; unify the port env var to `MCP_BRIDGE_PORT`. Extension calls `listen(0, ...)` and writes `{port, workspace, pid, startedAt}` to the registry on activate, removing its entry on deactivate. Client reads the registry instead of scanning 9421–9431. Enter uses `keyboard.pressKey(Key.Enter)`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/index.ts` (root MCP server) | Modified | Merge Cursor tool set; registry-based discovery |
| `extension/src/extension.ts` | Modified | Ephemeral port, registry write/cleanup, nut-js Enter |
| `extension/package.json` | Modified | Add `@nut-tree-fork/nut-js` dependency |
| `scripts/deploy.sh` | Modified | Platform detection, `$HOME` fallback |
| `../nexus-mcp`, `../klout-mcp` | Modified | README archival notice |
| HTTP bridge contract | Modified | Port now dynamic + published via registry file (breaking-change risk) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| nut-js native build (node-gyp) fails on install | Med | Document build-tool prerequisite; macOS Accessibility permission note in README |
| Cursor command IDs (`glass.*`, `composer.newAgentChat`) break on update | Med | Pre-existing risk; documented, not introduced here |
| Windows registry/deploy branch untested this session | Med | Nahuel validates on his Windows machine |
| Focus stolen on Enter | High | Accepted limitation, documented in code + README |

## Rollback Plan

Revert the `vscode-mcp` commit and re-deploy the prior `.vsix`. `nexus-mcp`/`klout-mcp` are untouched on disk (only README changed) and remain runnable as before. Delete `~/.vscode-mcp-bridge/registry.json` if stale.

## Dependencies

- `@nut-tree-fork/nut-js` (native module) added to `extension/package.json`.

## Success Criteria

- [ ] Single client builds and serves all filesystem + Cursor tools.
- [ ] Two Cursor windows resolve via `cursor_list_workspaces` with distinct ports, no scanning.
- [ ] `cursor_send_and_wait` completes end-to-end on macOS without PowerShell.
- [ ] `deploy.sh` runs on Mac/Linux; `cursor_deploy_extension` uses a runtime-resolved path.
- [ ] `nexus-mcp`/`klout-mcp` READMEs carry the archival notice.
