# Proposal: CDP Chat Bridge

## Intent

The keystroke-simulation send path from `consolidate-cursor-bridge` (`@nut-tree-fork/nut-js` Enter) is unreliable: it needs real OS focus, requires Accessibility/Automation permissions the runtime cannot guarantee, races with concurrent tab activity, and intermittently breaks on `AgentRepositoryService not initialised`. Cursor is Electron/Chromium and natively supports `--remote-debugging-port`. Chrome DevTools Protocol (CDP) produces trusted (`isTrusted: true`) input events that Cursor's Lexical chat editor accepts. This was validated live this session: a real 10-turn conversation completed end-to-end with no failures. This change formalizes that already-approved approach.

## Scope

### In Scope
- New client module `src/cdp.ts`: WebSocket to `/json/list`, attach via `Target.attachToTarget`, send via click + `Input.insertText` + `Input.dispatchKeyEvent` (Enter).
- New client module `src/composerStore.ts`: read conversation from `state.vscdb` via `node:sqlite`.
- Rewire `cursor_send`, `cursor_send_and_wait`, `cursor_read_chat` to use CDP/SQLite directly; `cursor_list_workspaces` to list CDP `page` entries.
- Shrink extension: remove `sendEnterKey`, `focusChatInput`, `/chat/*`, `registry.ts`, ephemeral-port system, and `@nut-tree-fork/nut-js`; revert to fixed configurable port (9421).
- Add `CURSOR_CDP_PORT` env var (default 9222) and document persistent launch flag per OS.

### Out of Scope
- Multi-editor support (selector `.aislash-editor-input` and `state.vscdb` schema are Cursor-specific).
- Root-cause fix for `AgentRepositoryService not initialised`.
- Automating the Cursor `--remote-debugging-port` launch flag (user configures once).

## Capabilities

### New Capabilities
- `cdp-chat-bridge`: CDP-based message send and SQLite-based conversation read from the client, replacing extension HTTP chat endpoints.

### Modified Capabilities
- `cursor-control`: `cursor_send`/`cursor_send_and_wait`/`cursor_read_chat`/`cursor_list_workspaces` now use CDP/SQLite, not the HTTP bridge.
- `bridge-discovery`: ephemeral-port binding and registry removed; extension reverts to fixed configurable port, discovery moves to CDP.
- `chat-confirmation`: nut-js Enter keystroke replaced by CDP trusted input; focus-stealing limitation no longer applies.

## Approach

Client talks CDP over native Node WebSocket to the Cursor debug port; discovery, send, and read all flow through CDP/SQLite. The extension keeps only VS Code-command-dependent endpoints (`/command`, `/editor/*`, `/diagnostics`, `/model/*`) on a fixed port. If no chat tab exists, client first calls `POST /command composer.createNewComposerTab`, then retries.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/cdp.ts` | New | CDP connect/attach/send |
| `src/composerStore.ts` | New | SQLite conversation read |
| `src/index.ts` (tools) | Modified | Rewire 4 cursor tools |
| `extension/` | Removed | `/chat/*`, `registry.ts`, nut-js dep |
| `README` | Modified | Debug-flag setup per OS |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `.aislash-editor-input`/`state.vscdb` are internal, may change | Med | Same class of risk as prior `glass.*` reliance; isolate in two modules |
| User must launch Cursor with debug flag | High | Documented per-OS persistent setup |
| `node:sqlite` stability varies by Node version | Low | Confirm against user's Node; no new dependency |

## Rollback Plan

Revert to the archived `consolidate-cursor-bridge` state: restore `registry.ts`, ephemeral ports, nut-js dependency, and `/chat/*` endpoints; drop `src/cdp.ts` and `src/composerStore.ts`.

## Dependencies

- Node 22+ (native WebSocket, `node:sqlite`). No new npm dependency.
- Cursor launched with `--remote-debugging-port`.

## Success Criteria

- [ ] Multi-turn conversation via CDP completes reliably (matches live 10-turn validation).
- [ ] `cursor_read_chat` returns correct history from `state.vscdb`.
- [ ] `cursor_list_workspaces` lists all open windows via CDP.
- [ ] Extension builds with nut-js and registry removed; VS Code-command tools still work.
