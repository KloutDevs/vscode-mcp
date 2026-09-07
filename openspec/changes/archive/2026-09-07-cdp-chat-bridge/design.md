# Design: CDP Chat Bridge

## Technical Approach

The MCP client (`src/index.ts`) talks Chrome DevTools Protocol directly to Cursor's native
`--remote-debugging-port`, replacing the extension's keystroke-based `/chat/*` HTTP path. Two new
client modules isolate the internal-detail surface: `src/cdp.ts` (send + window discovery) and
`src/composerStore.ts` (conversation read from `state.vscdb`). The extension reverts to a fixed
port serving only VS Code-command endpoints. This formalizes the approach validated live this
session (real 10-turn conversation, `status: "completed"` each turn). See proposal `## Approach`.

## Architecture Decisions

### Decision: CDP trusted input instead of simulated keystroke
**Choice**: `Input.insertText` + `Input.dispatchKeyEvent` (Enter) over an attached CDP session.
**Alternatives considered**: nut-js `keyboard.pressKey(Key.Enter)` (current); Cursor submit command.
**Rationale**: nut-js needs real OS focus + Accessibility perms, races concurrent tabs, and hits
`AgentRepositoryService not initialised`. No Cursor "submit-without-key" command exists. CDP emits
`isTrusted: true` events Lexical accepts; synthetic JS `InputEvent` is ignored.

### Decision: Window discovery via CDP `/json/list`, not a disk registry
**Choice**: `GET http://127.0.0.1:<port>/json/list`, filter `type === "page"`, map `title`→workspace.
**Alternatives considered**: keep `registry.ts` ephemeral-port + `~/.vscode-mcp-bridge/registry.json`.
**Rationale**: CDP already exposes one `page` per window with target `id`; the registry solved a
discovery problem CDP solves natively. Removing it deletes an entire moving part.

### Decision: SQLite polling read, not JSONL `fs.watch`
**Choice**: `node:sqlite` `DatabaseSync` reads `composerData:<id>` / `bubbleId:<composerId>:<bubbleId>`;
`waitForReply` polls `fullConversationHeadersOnly.length` + `status === "completed"` every 1–1.5s.
**Alternatives considered**: `fs.watch` on `.vscdb`; extension `/chat/read`.
**Rationale**: WAL writes to a side `-wal` file, so FS events are unreliable; polling proved reliable
across all 10 live turns and is simpler to reason about. No JSONL exists in this Cursor version.

## Data Flow

    cursor_send / _and_wait ─→ cdp.sendMessage(port,pageId,text)
        │                          │ WS ws://127.0.0.1:<port>/devtools/page/<id>
        │                          │ attach→enable→evaluate(locate .aislash-editor-input)
        │                          │ mouse click → insertText → Enter
        │                          ▼
        │                    Cursor Lexical editor (agent runs)
        ▼                          │ writes
    cursor_read_chat ─→ composerStore.read*  ◀── state.vscdb (SQLite)
    cursor_list_workspaces ─→ cdp GET /json/list

If `.aislash-editor-input` is absent, client first `POST /command composer.createNewComposerTab`
(existing extension endpoint), then retries `sendMessage`.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/cdp.ts` | Create | `listPages(port)`, `sendMessage(port,pageId,text)`; native `WebSocket` CDP client |
| `src/composerStore.ts` | Create | `readComposerData`, `readBubble`, `waitForReply` via `node:sqlite` |
| `src/index.ts` | Modify | Rewire `cursor_send`/`cursor_send_and_wait`→`cdp`, `cursor_read_chat`→`composerStore`, `cursor_list_workspaces`→`cdp.listPages`; add `CURSOR_CDP_PORT` (default 9222); drop `/chat/*` `bridgeCall`s |
| `extension/src/extension.ts` | Modify | Remove `sendEnterKey`, `focusChatInput`, routes `/chat/open|send|send_and_wait|confirm|read|status`; `listen(0,…)`→fixed port 9421; drop registry wiring |
| `extension/src/registry.ts` + `.test.ts` | Delete | Ephemeral-port registry no longer used |
| `extension/package.json` | Modify | Remove `@nut-tree-fork/nut-js` |
| `README.md` | Modify | Per-OS persistent `--remote-debugging-port` launch setup |

## Interfaces / Contracts

```ts
// src/cdp.ts
export interface CdpPage { pageId: string; title: string }
export function listPages(port: number): Promise<CdpPage[]>;
export function sendMessage(port: number, pageId: string, text: string): Promise<void>;

// src/composerStore.ts
export interface ComposerData { fullConversationHeadersOnly: { bubbleId: string }[]; status: string }
export function readComposerData(composerId: string): ComposerData | null;
export function readBubble(composerId: string, bubbleId: string): { text: string; type: number } | null;
export function waitForReply(composerId: string, sinceCount: number, timeoutMs: number): Promise<string>;
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `composerStore` parsing: header list, bubble text, `status:"completed"` | `node:test` against a fixture `state.vscdb` (never the user's live DB) |
| Unit | `cdp.listPages` title→workspace mapping | mock `/json/list` JSON |
| Integration | `sendMessage` attach→click→insert→Enter; missing-editor→createNewComposerTab retry | live Cursor with debug port (manual, per validation) |
| E2E | Multi-turn send/read reliability; `cursor_list_workspaces` with 2+ windows | manual, mirrors 10-turn live run |
| Build | Extension builds with nut-js + registry removed; VS Code-command tools still work | `npm run build` both packages |

## Threat Matrix

N/A — no VCS/PR automation, shell routing, or executable-file classification. Process integration is
CDP/WebSocket + local SQLite read only (no subprocess spawn, no shell). Row-by-row: Documentation
paths N/A (no path classification); Git selection/Commit/Push/PR N/A (no VCS automation). CDP/SQLite
error handling is covered under Testing and Interfaces, not this matrix.

## Migration / Rollout

No data migration. Operational prerequisite: user relaunches Cursor with `--remote-debugging-port`
(cannot be enabled hot) — documented per OS in README. Rollback: restore `registry.ts`,
ephemeral ports, nut-js, and `/chat/*`; delete the two new modules (proposal `## Rollback Plan`).

## Open Questions

- [ ] Exact `title` format from `/json/list` for workspace extraction (confirm against real windows).
- [ ] `node:sqlite` stability on the user's installed Node version.
- [ ] Windows `--remote-debugging-port` parity (no Windows in session; user validates).
