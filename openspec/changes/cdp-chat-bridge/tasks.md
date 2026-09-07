# Tasks: CDP Chat Bridge

Legend: `[P]` = can run in parallel with sibling `[P]` tasks in the same group; unmarked tasks are sequential (depend on a prior task in the list).

## 1. `src/cdp.ts` (new module)

- [x] 1.1 Create `src/cdp.ts` with `interface CdpPage { pageId: string; title: string }`.
      — Satisfies: `bridge-discovery` Requirement "CDP-based window discovery"; `cdp-chat-bridge` Requirement "CDP debug port precondition".
- [x] 1.2 Implement `listPages(port: number): Promise<CdpPage[]>` — `GET http://127.0.0.1:<port>/json/list`, filter `type === "page"`, map `id`→`pageId`, `title`→`title`.
      — Satisfies: `bridge-discovery` Requirement "CDP-based window discovery" (both scenarios); `cursor-control` Requirement "Multi-window discovery".
- [x] 1.3 Implement debug-port-unreachable error path in `listPages` — clear, actionable error naming the port and instructing the user to relaunch Cursor with `--remote-debugging-port`; no fallback to any other discovery mechanism.
      — Satisfies: `cdp-chat-bridge` Requirement "CDP debug port precondition" (Scenario: Debug port unreachable); `bridge-discovery` Requirement "CDP-based window discovery" (Scenario: CDP endpoint unreachable).
- [x] 1.4 Implement `sendMessage(port: number, pageId: string, text: string): Promise<void>` — open native `WebSocket` to `ws://127.0.0.1:<port>/devtools/page/<pageId>`, `Target.attachToTarget`/enable, locate `.aislash-editor-input`, `Input.dispatchMouseEvent` (click), `Input.insertText` (message text), `Input.dispatchKeyEvent` (keyDown/keyUp, `windowsVirtualKeyCode: 13`, Enter).
      — Satisfies: `cdp-chat-bridge` Requirement "CDP-based trusted message send" (Scenario: Sending a message to an existing chat tab); `chat-confirmation` Requirement "CDP trusted input confirmation" (both scenarios).
- [x] 1.5 Implement missing-chat-tab retry path in `sendMessage` — when `.aislash-editor-input` is absent, `POST /command composer.createNewComposerTab` against the extension's fixed port, then retry the CDP send once.
      — Satisfies: `cdp-chat-bridge` Requirement "CDP-based trusted message send" (Scenario: No chat tab open yet).
- [x] 1.6 [P] Separate pure logic (e.g. `/json/list` response filtering/mapping, CDP event-payload construction) from the actual WebSocket/HTTP I/O so it is unit-testable without a live Cursor process.
      — Supports: Testing Strategy (design.md) — `cdp.listPages` title→workspace mapping unit test.
- [x] 1.7 [P] Add `node:test` unit tests for `listPages` parsing/filtering logic against a mocked `/json/list` JSON payload (no network call).
      — Satisfies: Testing Strategy (design.md) row "Unit | `cdp.listPages` title→workspace mapping | mock `/json/list` JSON".

## 2. `src/composerStore.ts` (new module)

- [x] 2.1 [P] Create `src/composerStore.ts` with `interface ComposerData { fullConversationHeadersOnly: { bubbleId: string }[]; status: string }`.
      — Satisfies: `cdp-chat-bridge` Requirement "Direct SQLite conversation read".
- [x] 2.2 Implement `readComposerData(composerId: string): ComposerData | null` — `node:sqlite` `DatabaseSync` read of key `composerData:<composerId>` from `state.vscdb`.
      — Satisfies: `cdp-chat-bridge` Requirement "Direct SQLite conversation read" (Scenario: Reading a conversation by composer ID); `cursor-control` Requirement "Multi-tab message send and read" (Scenario: Reading a specific tab's history).
- [x] 2.3 Implement `readBubble(composerId: string, bubbleId: string): { text: string; type: number } | null` — read of key `bubbleId:<composerId>:<bubbleId>`.
      — Satisfies: `cdp-chat-bridge` Requirement "Direct SQLite conversation read" (Scenario: Reading a conversation by composer ID).
- [x] 2.4 Implement `waitForReply(composerId: string, sinceCount: number, timeoutMs: number): Promise<string>` — poll `readComposerData` every 1–1.5s until `fullConversationHeadersOnly.length` increases past `sinceCount` and `status === "completed"`, or `timeoutMs` elapses; no `fs.watch` on `.vscdb`/`-wal`.
      — Satisfies: `cdp-chat-bridge` Requirement "Direct SQLite conversation read" (Scenario: Waiting for the agent's final reply); `cursor-control` Requirement "Blocking send-and-wait" (both scenarios).
- [x] 2.5 [P] Add `node:test` unit tests for header-list parsing, bubble text/type parsing, and `status === "completed"` detection, run against a fixture `state.vscdb` (never the user's live DB).
      — Satisfies: Testing Strategy (design.md) row "Unit | `composerStore` parsing ... | `node:test` against a fixture `state.vscdb`".

## 3. `src/index.ts` — rewire cursor tools

- [x] 3.1 Add `CURSOR_CDP_PORT` env var (default `9222`) used by `cdp.ts` calls from `index.ts`.
      — Satisfies: `cdp-chat-bridge` Requirement "CDP debug port precondition" (Scenario: Configurable debug port).
- [x] 3.2 Rewire `cursor_send` and `cursor_send_and_wait` to call `cdp.sendMessage` instead of the extension's `/chat/send` and `/chat/send_and_wait` HTTP endpoints; `cursor_send_and_wait` additionally calls `composerStore.waitForReply` and resolves with response text/elapsed time or a timeout error.
      — Satisfies: `cursor-control` Requirement "Multi-tab message send and read" (both send scenarios); `cursor-control` Requirement "Blocking send-and-wait" (both scenarios).
- [x] 3.3 Rewire `cursor_read_chat` to call `composerStore.readComposerData`/`readBubble` instead of the extension's `/chat/read` HTTP endpoint.
      — Satisfies: `cursor-control` Requirement "Multi-tab message send and read" (Scenario: Reading a specific tab's history).
- [x] 3.4 Rewire `cursor_list_workspaces` to call `cdp.listPages` instead of reading the extension's on-disk registry.
      — Satisfies: `cursor-control` Requirement "Multi-window discovery" (both scenarios).
- [x] 3.5 Remove the now-unused `bridgeCall`s to `/chat/*` endpoints from `index.ts` (open/confirm/status paths not covered by 3.2–3.4, if any remain wired to chat HTTP routes).
      — Satisfies: `cdp-chat-bridge` Purpose (replacing keystroke simulation and the extension's HTTP chat endpoints).

## 4. Extension changes

- [x] 4.1 [P] Delete `extension/src/registry.ts` and its test file.
      — Satisfies: `bridge-discovery` REMOVED Requirement "Registry file publication"; REMOVED Requirement "Registry cleanup on deactivation".
- [x] 4.2 Remove `@nut-tree-fork/nut-js` dependency from `extension/package.json`.
      — Satisfies: `chat-confirmation` REMOVED Requirement "Cross-platform Enter keystroke".
- [x] 4.3 Remove `sendEnterKey` and `focusChatInput` from `extension/src/extension.ts`.
      — Satisfies: `chat-confirmation` REMOVED Requirement "Cross-platform Enter keystroke"; REMOVED Requirement "No window-title dependency"; REMOVED Requirement "Documented focus-stealing limitation".
- [x] 4.4 Remove routes `/chat/send`, `/chat/send_and_wait`, `/chat/confirm`, `/chat/read`, `/chat/status` from `extension/src/extension.ts`. Keep `/chat/open` (with `CHAT_OPEN_COMMANDS`/`COMPOSER_OPEN_COMMANDS`/`AGENT_OPEN_COMMANDS` and the `tryCommands` call) — it backs the still-unchanged `cursor_open_chat` tool per the `cursor-control` spec's "Notes on Unchanged Requirements".
      — Satisfies: `cdp-chat-bridge` Purpose; `cursor-control` Requirement "Multi-tab message send and read" (Previously-note superseded).
      — RESOLVED (2026-09-07): the original pass removed `/chat/open` along with the other `/chat/*` routes, breaking `cursor_open_chat` — contradicted the spec's "unchanged" note. Restored the route, its command-ID lists, and rebuilt clean (root + extension `tsc`, both pass).
- [x] 4.5 Remove registry wiring from `extension/src/extension.ts` (imports/calls referencing the deleted `registry.ts`).
      — Satisfies: `bridge-discovery` REMOVED Requirement "Registry file publication"; REMOVED Requirement "Passive dead-PID cleanup on read".
- [x] 4.6 Revert `startServer` from ephemeral `listen(0, …)` to a fixed configurable port, default `9421`.
      — Satisfies: `bridge-discovery` REMOVED Requirement "Ephemeral port binding" (Migration: fixed port default `9421`, configurable).
- [x] 4.7 Run `npm run build` in `extension/` to confirm it builds with nut-js and registry removed, and remaining VS Code-command tools (`/command`, `/editor/*`, `/diagnostics`, `/model/*`) still work.
      — Satisfies: Testing Strategy (design.md) row "Build | Extension builds with nut-js + registry removed ...".

## 5. Documentation

- [x] 5.1 [P] Update `README.md` documenting the `--remote-debugging-port` requirement, per-OS persistent launch setup, and the `CURSOR_CDP_PORT` env var.
      — Satisfies: proposal "Add `CURSOR_CDP_PORT` env var ... and document persistent launch flag per OS"; `cdp-chat-bridge` Requirement "CDP debug port precondition".
- [x] 5.2 [P] Update `README.md` to remove references to the `@nut-tree-fork/nut-js` dependency and the ephemeral-port registry.
      — Satisfies: proposal Affected Areas "`README` | Modified | Debug-flag setup per OS".
