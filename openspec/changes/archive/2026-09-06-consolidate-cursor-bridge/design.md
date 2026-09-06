# Design: Consolidate Cursor Bridge into One Cross-Platform Client

## Technical Approach

Fold `nexus-mcp`'s complete Cursor tool set into `vscode-mcp/src/index.ts`, keeping the existing filesystem tools. The extension binds an OS-assigned ephemeral port (`listen(0)`) and publishes `{port, workspace, pid, startedAt}` to a shared JSON registry at `~/.vscode-mcp-bridge/registry.json`; the client reads the registry to discover windows instead of scanning ports 9421–9431. Message submission moves from PowerShell `exec()` to `@nut-tree-fork/nut-js`, one code path per OS. Reference plan (exact code): `docs/superpowers/plans/2026-09-06-consolidate-cursor-bridge.md`. Approved architecture: `docs/superpowers/specs/2026-09-06-consolidate-cursor-bridge-design.md`. Approach maps directly to the proposal's four new capabilities.

## Architecture Decisions

| Decision | Choice | Alternatives rejected | Rationale |
|---|---|---|---|
| Client location | Single client in `src/index.ts` (filesystem + full Cursor set from nexus-mcp) | Keep 3 clients; new 4th client | Removes divergent duplicate tool names; nexus has the most complete multi-window/tab support |
| Window discovery | Ephemeral port + shared registry file | Fixed port; range scan 9421–9431 | Scan breaks >11 windows / on port collision; registry is exact and OS-safe |
| Registry concurrency | Read-modify-write, no lockfile | flock/lockfile | One entry per process, writes rare and atomic per-OS |
| Dead-entry cleanup | Passive: `process.kill(pid,0)` filter in `cursor_list_workspaces` | Active heartbeat/TTL | Handles abrupt Cursor exits that skip `deactivate` without a background loop |
| Enter keystroke | `@nut-tree-fork/nut-js` `keyboard.pressKey(Key.Enter)` | PowerShell SendKeys; osascript; xdotool | Single cross-platform path; PowerShell is Windows-only |
| Archival | README notice on nexus/klout, repos untouched | Delete repos | Reversible; GitHub archival is the user's decision |

## Data Flow

    Cursor window (extension)          Claude Code (client src/index.ts)
      activate → listen(0)                cursor_list_workspaces
        │ actualPort                          │ readRegistry() + isPidAlive()
        ▼                                      ▼
    writeRegistryEntry ──→ ~/.vscode-mcp-bridge/registry.json ──→ resolve {port,workspace}
        │                                      │ bridgeCall(method,path,body,port)
        │  HTTP 127.0.0.1:actualPort  ◄─────────┘
    handleRequest / sendEnterKey (nut-js)
      deactivate → removeRegistryEntry

## File Changes

| File | Action | Description |
|---|---|---|
| `extension/src/registry.ts` | Create | `registryPath/writeRegistryEntry/removeRegistryEntry`; `$USERPROFILE ?? $HOME` |
| `extension/src/registry.test.ts` | Create | node:test unit coverage for registry helpers |
| `extension/src/extension.ts` | Modify | Ephemeral `listen(0)`, `actualPort`, registry write/cleanup, nut-js `sendEnterKey`, drop PowerShell `exec` |
| `extension/package.json` | Modify | Add `@nut-tree-fork/nut-js`; bump version; remove `cursorMcpBridge.port` config |
| `src/index.ts` | Modify | Port-aware `bridgeCall`, `readRegistry`/`isPidAlive`, merged tool set, `cursor_deploy_extension` runtime path via `fileURLToPath` |
| `scripts/deploy.sh` | Modify | `$USERPROFILE`→`$HOME` fallback for extensions dir |
| `README.md` | Modify | Document tools, registry, Accessibility prompt, focus/command-ID caveats |
| `../nexus-mcp/README.md`, `../klout-mcp/README.md` | Create | Archival notice |

## Interfaces / Contracts

```ts
// extension/src/registry.ts
registryPath(): string
writeRegistryEntry(port: number, workspace: string, pid: number): void
removeRegistryEntry(port: number): void
// registry entry: { [port: string]: { workspace: string; pid: number; startedAt: number } }

// src/index.ts
bridgeCall(method: string, path: string, body?: unknown, port?: number, timeoutMs = 310_000): Promise<unknown>
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | registry write/preserve/remove/missing-file | `node:test` with temp `$HOME` (`withTempHome`), 4 RED tests first |
| Integration | two windows resolve distinct ports without scanning | Manual: two Cursor windows, `cursor_list_workspaces` |
| E2E | `cursor_send_and_wait` end-to-end on macOS; `deploy.sh` install | Manual: package `.vsix`, curl `/chat/send`, verify Accessibility grant + `confirmed:true` |

Windows registry/deploy branch is validated separately by the user on Windows.

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A: no executable-file classification introduced | — | — |
| Git repository selection | N/A: no VCS automation in code paths (commits are manual, user-run) | — | — |
| Commit state | N/A: no automated commit logic | — | — |
| Push state | N/A: plan explicitly forbids auto-push; user runs `git push` | — | — |
| PR commands | N/A: no PR automation | — | — |
| Subprocess/shell execution | Applicable: `cursor_deploy_extension` execs `bash deploy.sh` | Resolve script path at runtime via `fileURLToPath(import.meta.url)` (no hardcoded/interpolated user path); fixed `bash "<scriptPath>"` argument, 120s timeout | Verify resolved path stays inside repo; deploy runs on Mac with `$HOME` fallback |
| Process integration | Applicable: `process.kill(pid,0)` liveness + OS keystroke injection | `kill(pid,0)` wrapped in try/catch (probe only, never signals); nut-js presses into focused window — focus-steal documented as accepted limitation | Passive dead-PID filtering covered via registry manual check; keystroke verified E2E |

## Migration / Rollout

No data migration. Rollback: revert the `vscode-mcp` commit, re-deploy prior `.vsix`; delete stale `~/.vscode-mcp-bridge/registry.json`. nexus/klout untouched on disk.

## Open Questions

- None blocking. Windows-branch validation deferred to user's Windows machine (accepted per proposal).
