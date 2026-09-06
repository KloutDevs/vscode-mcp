# Tasks: Consolidate Cursor Bridge into One Cross-Platform Client

Source of truth for exact code and step detail: `docs/superpowers/plans/2026-09-06-consolidate-cursor-bridge.md`. This file translates that approved plan's 8 tasks into the SDD tasks format without changing scope or order.

## Ordering

Sequential dependency chain: 1 → 2 → 3 → 5 → 6 → 7 → 8. Task 4 has no standalone work (folded into Task 5). Tasks 7 and 8 may run in parallel with each other once Task 6 is done, since they touch disjoint files (`README.md` vs. `../nexus-mcp`/`../klout-mcp`) and depend only on the consolidated tool set from Task 5.

- [x] 1. Registry file helpers in the extension (pure logic, unit-testable)
  - Create `extension/src/registry.ts`: `registryPath()`, `writeRegistryEntry(port, workspace, pid)`, `removeRegistryEntry(port)`.
  - Create `extension/src/registry.test.ts`: `node:test` coverage — write creates file with entry; write preserves other entries; remove deletes only the given port; remove on missing file is a no-op (via `withTempHome` temp-dir harness).
  - Verify tests fail before implementation, then pass after (RED → GREEN).
  - Requirements: `bridge-discovery` — Registry file publication, Registry cleanup on deactivation.
  - Parallel: No (blocks Task 2).
  - Commit: `feat(extension): add shared registry file for bridge port discovery`.

- [x] 2. Dynamic port + registry wiring in `extension/src/extension.ts`
  - Import `writeRegistryEntry`/`removeRegistryEntry` from `./registry.js`; add module-level `actualPort`.
  - `startServer`: bind `listen(0, "127.0.0.1", ...)`, capture the OS-assigned port, call `writeRegistryEntry(actualPort, getWorkspaceName(), process.pid)`, update status bar text.
  - `stopServer`: call `removeRegistryEntry(actualPort)` before closing the server (confirm `deactivate` already calls `stopServer`, no change needed there).
  - `GET /status`: report `actualPort` instead of the old fixed port.
  - Remove the now-unused `cursorMcpBridge.port` setting from `extension/package.json`.
  - Build and manually confirm the registry file gets a live entry with a non-9421 port.
  - Requirements: `bridge-discovery` — Ephemeral port binding, Registry file publication, Registry cleanup on deactivation, Passive dead-PID cleanup on read (enables it downstream).
  - Parallel: No (depends on Task 1; blocks Task 3).
  - Commit: `feat(extension): bind ephemeral port and publish it to the registry`.

- [x] 3. Replace PowerShell `sendEnterKey` with `nut-js`
  - Add `@nut-tree-fork/nut-js` to `extension/package.json` dependencies; `npm install`.
  - Replace `sendEnterKey` in `extension/src/extension.ts` with `keyboard.pressKey(Key.Enter)` / `releaseKey`; remove PowerShell `exec()` window-title construction; remove unused `child_process` `exec` import if nothing else uses it.
  - Build; manually verify on macOS via `curl` to `/chat/send` (Accessibility permission prompt, `"confirmed": true`).
  - Requirements: `chat-confirmation` — Cross-platform Enter keystroke, No window-title dependency, Documented focus-stealing limitation.
  - Parallel: No (depends on Task 2's `extension.ts` changes; blocks Task 5 only indirectly — no shared files, but keep sequential per plan order).
  - Commit: `feat(extension): replace PowerShell keystroke simulation with nut-js`.

- [x] 4. (Folded into Task 5) Fix `cursor_deploy_extension` hardcoded Windows path
  - No standalone work or commit — the fix is applied as part of Task 5's `cursor_deploy_extension` handler (runtime-resolved path via `fileURLToPath(import.meta.url)`, no hardcoded Windows path).
  - Requirements: `extension-deployment` — Runtime-resolved deploy script path.
  - Parallel: N/A.

- [x] 5. Merge Cursor-control tools into `vscode-mcp/src/index.ts`
  - Replace the single-port `bridgeCall`/`BRIDGE_PORT` with a port-aware `bridgeCall(method, path, body, port, timeoutMs)`; add `readRegistry()` and `isPidAlive(pid)`.
  - Replace the existing Cursor-tool `TOOLS` entries with the consolidated set: `cursor_list_workspaces`, `cursor_status`, `cursor_list_commands`, `cursor_open_chat`, `cursor_send_and_wait`, `cursor_send`, `cursor_read_chat`, `cursor_get_model`, `cursor_set_model`, `cursor_open_model_picker`, `cursor_open_file`, `cursor_editor_state`, `cursor_diagnostics`, `cursor_run_command`, `cursor_deploy_extension`.
  - Replace the tool handlers in the `CallToolRequestSchema` switch accordingly, including the `cursor_deploy_extension` handler using `fileURLToPath(import.meta.url)` to resolve `scripts/deploy.sh` at runtime (fixes Task 4's issue).
  - Add `import { fileURLToPath } from "url"` (top of file).
  - Build with no TypeScript errors; manually verify `cursor_list_workspaces` returns live workspaces/ports via Claude Code's MCP config.
  - Requirements: `cursor-control` — Multi-window discovery, Port-scoped Cursor tools, Multi-tab message send and read, Blocking send-and-wait, Extension deployment tool; `bridge-discovery` — Passive dead-PID cleanup on read; `extension-deployment` — Runtime-resolved deploy script path.
  - Parallel: No (depends on Tasks 1–3 being complete; the registry contract and nut-js signature must be stable first).
  - Commit: `feat: consolidate cursor-bridge tools from nexus-mcp into vscode-mcp client`.

- [x] 6. Cross-platform `scripts/deploy.sh`
  - Replace the `EXTENSIONS_DIR="$USERPROFILE/.cursor/extensions"` line with an `if [ -n "$USERPROFILE" ]; then ... else EXTENSIONS_DIR="$HOME/.cursor/extensions"; fi` fallback.
  - Confirm no other OS-specific assumptions remain in the script.
  - Manually verify: `bash scripts/deploy.sh` builds, packages, installs, reloads, and reports `"active": true` with a non-9421 port.
  - Requirements: `extension-deployment` — Cross-platform extensions directory resolution.
  - Parallel: No (depends on Task 5 being buildable end-to-end for the manual verification step).
  - Commit: `fix(deploy): support macOS/Linux by falling back to \$HOME`.

- [x] 7. Update `vscode-mcp/README.md`
  - Document: filesystem tools (existing table, unchanged), the full Cursor-control tool set from Task 5, the `cursor-mcp-bridge` extension's dynamic-port + registry mechanism, the macOS Accessibility permission prompt, the undocumented/unstable Cursor command-ID caveat, and the focus-stealing limitation on send.
  - Requirements: all four capability specs (`cursor-control`, `bridge-discovery`, `extension-deployment`, `chat-confirmation`) — documentation surface for each.
  - Parallel: Yes, with Task 8 (disjoint files, both depend only on Task 6 being complete).
  - Commit: `docs: document the consolidated client and cross-platform bridge`.

- [ ] 8. Mark `nexus-mcp` and `klout-mcp` as archived
  - [x] Create `../nexus-mcp/README.md` with an archival notice pointing to `vscode-mcp` (committed in that repo).
  - [ ] Create `../klout-mcp/README.md` with the equivalent notice (adjusted: klout-mcp was an earlier iteration of nexus-mcp) — BLOCKED: `~/Desktop/Trabajo/KloutDevs/klout-mcp` does not exist on this machine.
  - Commit each repo separately; do not push any of the three repos without asking first.
  - Requirements: proposal scope item "Archive `nexus-mcp` and `klout-mcp` via README notice" (no dedicated capability spec — archival is process, not a runtime capability).
  - Parallel: Yes, with Task 7 (disjoint files/repos, both depend only on Task 6 being complete).
  - Commit: `docs: mark project as archived, absorbed into vscode-mcp` (in each of `nexus-mcp` and `klout-mcp`).
