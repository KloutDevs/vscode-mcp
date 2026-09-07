# Archive Report: CDP Chat Bridge

**Change**: cdp-chat-bridge  
**Archived**: 2026-09-07  
**Status**: Archived and closed  
**Verification**: Passed (0 critical, 0 warning)

## Executive Summary

The CDP Chat Bridge change has been successfully implemented, verified, and archived. All 21 tasks completed. Delta specs for 4 capabilities (`cdp-chat-bridge`, `cursor-control`, `bridge-discovery`, `chat-confirmation`) have been merged into the main specification repository. The change replaces OS-level keystroke simulation and file-based window discovery with Chrome DevTools Protocol (CDP) for trusted message submission and direct SQLite reads for conversation history, eliminating the need for the `@nut-tree-fork/nut-js` dependency and the ephemeral-port registry system.

## Implementation Complete

### Tasks Status

All 21 implementation tasks marked complete:
- Section 1: `src/cdp.ts` new module (7 tasks) — [x] all complete
- Section 2: `src/composerStore.ts` new module (5 tasks) — [x] all complete
- Section 3: `src/index.ts` rewire (5 tasks) — [x] all complete
- Section 4: Extension cleanup (4 tasks) — [x] all complete  
- Section 5: Documentation (2 tasks) — [x] all complete

Persisted tasks artifact: `openspec/changes/archive/2026-09-07-cdp-chat-bridge/tasks.md` — no unchecked implementation tasks.

### Verification Status

Verification passed with 0 critical issues, 0 warnings. See original verification report for detail.

### Specs Synced to Main

| Capability | Action | Details |
|------------|--------|---------|
| `cdp-chat-bridge` | Created | New spec: CDP-based trusted message send via `Input.insertText`/`Input.dispatchKeyEvent`; direct SQLite conversation read from `state.vscdb`; debug-port error handling |
| `cursor-control` | Updated | 3 requirements modified: Multi-window discovery now uses CDP `/json/list` instead of registry; Multi-tab message send/read now use CDP/SQLite instead of HTTP bridge; Blocking send-and-wait now polls `state.vscdb` instead of JSONL |
| `bridge-discovery` | Updated | Complete replacement: 4 requirements removed (Ephemeral port binding, Registry file publication, Registry cleanup, Passive PID cleanup); 1 requirement added (CDP-based window discovery via `/json/list`) |
| `chat-confirmation` | Updated | Complete replacement: 3 requirements removed (Cross-platform Enter keystroke, No window-title dependency, Focus-stealing limitation); 1 requirement added (CDP trusted input confirmation on all OS) |

**Merge locations**:
- `openspec/specs/cdp-chat-bridge/spec.md` — newly created
- `openspec/specs/cursor-control/spec.md` — 3 requirements updated
- `openspec/specs/bridge-discovery/spec.md` — 4 removed, 1 added
- `openspec/specs/chat-confirmation/spec.md` — 3 removed, 1 added

## Archive Contents

The change folder `openspec/changes/cdp-chat-bridge/` has been moved to `openspec/changes/archive/2026-09-07-cdp-chat-bridge/` with all artifacts intact:

- `proposal.md` ✓ — Scope, approach, rollback plan, success criteria
- `design.md` ✓ — Technical approach, architecture decisions, data flow, interfaces, testing strategy
- `tasks.md` ✓ — All 21 tasks with checkmarks; no unchecked items
- `specs/cdp-chat-bridge/spec.md` ✓
- `specs/cursor-control/spec.md` ✓
- `specs/bridge-discovery/spec.md` ✓
- `specs/chat-confirmation/spec.md` ✓

**Move verification**: Mechanical shell move (`git mv`) with pre-move snapshot. Post-move `diff -r` comparison showed no byte differences (empty diff output = passing evidence).

## Capability Summary

### New Capability: `cdp-chat-bridge`

Sends chat messages to Cursor using CDP trusted input events and reads conversation history directly from `state.vscdb` SQLite database, replacing keystroke simulation and HTTP bridge chat endpoints.

**Key features**:
- `cdp.listPages(port)`: Discover open Cursor windows via CDP `/json/list` endpoint
- `cdp.sendMessage(port, pageId, text)`: Send message via native WebSocket to `/devtools/page/<id>`, attach, click input, insert text, dispatch Enter keydown/keyup
- Auto-create chat tab if missing: `POST /command composer.createNewComposerTab`, retry send
- `composerStore.readComposerData(composerId)`: Read bubbles from `composerData:<id>` SQLite key
- `composerStore.readBubble(composerId, bubbleId)`: Read message text and type
- `composerStore.waitForReply(composerId, sinceCount, timeoutMs)`: Poll for `status: "completed"` at 1–1.5s intervals

**Implementation files**:
- `src/cdp.ts` — CDP WebSocket client, window discovery, message send
- `src/composerStore.ts` — SQLite database read, reply wait polling
- `src/index.ts` — Tool rewiring
- `extension/src/extension.ts` — Remove `/chat/*` routes, keep `/command` for tab creation

### Modified Capability: `cursor-control`

Three core requirements updated to use CDP/SQLite instead of the extension's HTTP bridge:

1. **Multi-window discovery** — now queries `GET /json/list` on CDP debug port, no registry read
2. **Multi-tab message send and read** — `cursor_send`/`cursor_send_and_wait` send via CDP, `cursor_read_chat` reads directly from `state.vscdb`
3. **Blocking send-and-wait** — polls `state.vscdb` for `status: "completed"` instead of HTTP endpoint

Port-scoped tools and Extension deployment tool remain unchanged.

### Modified Capability: `bridge-discovery`

Complete architectural shift from ephemeral-port registry to CDP discovery:
- **Removed**: Ephemeral port binding, Registry file publication, Registry cleanup, Passive PID cleanup
- **Added**: CDP-based window discovery via `/json/list` endpoint
- **Extension port**: Reverted to fixed configurable port (default 9421)

### Modified Capability: `chat-confirmation`

Replaced OS-level keystroke simulation with CDP trusted input:
- **Removed**: Cross-platform Enter keystroke via nut-js, Window-title dependency, Focus-stealing limitation
- **Added**: CDP trusted input confirmation using `Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent` (Enter)
- Result: Works on all OS, no focus-stealing, no permission/accessibility requirements

## Dependencies Resolved

**User-facing prerequisites**:
- Node 22+ (for native WebSocket and `node:sqlite`)
- Cursor launched with `--remote-debugging-port` flag (documented per-OS setup in README)
- `CURSOR_CDP_PORT` environment variable (default 9222, configurable)

**Removed dependencies**:
- `@nut-tree-fork/nut-js` from extension (deleted)
- `registry.ts` module (deleted)

**Rollback path**: Revert to archived `consolidate-cursor-bridge` state; restore `registry.ts`, ephemeral ports, nut-js, and `/chat/*` endpoints.

## Source of Truth Updated

Main specification files now reflect the new CDP-based architecture:

| File | Purpose |
|------|---------|
| `openspec/specs/cdp-chat-bridge/spec.md` | New CDP capabilities |
| `openspec/specs/cursor-control/spec.md` | Updated tool behavior (discovery, send, read, wait) |
| `openspec/specs/bridge-discovery/spec.md` | Updated discovery mechanism (CDP replaces registry) |
| `openspec/specs/chat-confirmation/spec.md` | Updated confirmation method (CDP replaces keystroke) |

## Artifact State

**Persisted artifacts** (openspec mode):
- Main spec files: `openspec/specs/{cdp-chat-bridge,cursor-control,bridge-discovery,chat-confirmation}/spec.md`
- Change folder: `openspec/changes/archive/2026-09-07-cdp-chat-bridge/`
- Archive report: `openspec/changes/archive/2026-09-07-cdp-chat-bridge/archive-report.md`

**Artifact locators** (for traceability):
- Proposal: `openspec/changes/archive/2026-09-07-cdp-chat-bridge/proposal.md`
- Specification deltas: `openspec/changes/archive/2026-09-07-cdp-chat-bridge/specs/`
- Design: `openspec/changes/archive/2026-09-07-cdp-chat-bridge/design.md`
- Tasks: `openspec/changes/archive/2026-09-07-cdp-chat-bridge/tasks.md`
- Archive report: `openspec/changes/archive/2026-09-07-cdp-chat-bridge/archive-report.md`

## SDD Cycle Complete

The change has been fully planned (proposal), specified (delta specs merged into main), designed, implemented (all 21 tasks complete), verified (0 critical, 0 warning), and archived.

**Status**: Ready for the next change.

---

**Archive Date**: 2026-09-07  
**Archiver**: sdd-archive (Haiku 4.5)  
**Mode**: openspec (filesystem)  
**Mechanical verification**: diff -r passed (empty output)  
