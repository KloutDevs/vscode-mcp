# Delta for Bridge Discovery

## REMOVED Requirements

### Requirement: Ephemeral port binding

(Reason: window discovery no longer depends on OS-assigned ports or a shared registry; CDP's `/json/list` endpoint enumerates windows directly. The extension reverts to a fixed, configurable port for its remaining VS Code-command endpoints.)
(Migration: extension binds a fixed port, default `9421`, configurable as before `consolidate-cursor-bridge`.)

### Requirement: Registry file publication

(Reason: no on-disk registry is needed once CDP's `/json/list` is the discovery source.)
(Migration: `registry.ts` is deleted; no replacement file is written.)

### Requirement: Registry cleanup on deactivation

(Reason: with no registry file, there is nothing to clean up on deactivation.)
(Migration: None.)

### Requirement: Passive dead-PID cleanup on read

(Reason: CDP's `/json/list` only ever reflects live pages of the running Cursor process; there is no stale-file state to filter.)
(Migration: staleness is inherently handled by CDP — a closed window's page simply disappears from `/json/list`.)

## ADDED Requirements

### Requirement: CDP-based window discovery

The client MUST discover open Cursor windows by querying `GET http://127.0.0.1:<debugPort>/json/list` on the configured CDP debug port and filtering entries where `type === "page"`, rather than reading any on-disk registry.

#### Scenario: Two Cursor windows open

- GIVEN two Cursor windows are open under the same debug-enabled process
- WHEN the client queries `/json/list`
- THEN the response includes one `page` entry per window, each with a `title` (revealing the workspace) and an `id` usable for `Target.attachToTarget`
- AND no file on disk is read for this purpose

#### Scenario: A window is closed

- GIVEN a Cursor window was open and is then closed
- WHEN the client queries `/json/list` again
- THEN that window's entry is absent from the response
- AND no stale-entry filtering logic is needed, since CDP only reports live pages

#### Scenario: CDP endpoint unreachable

- GIVEN Cursor was not launched with `--remote-debugging-port`
- WHEN the client queries `/json/list`
- THEN the request fails and the client reports that CDP discovery is unavailable, rather than falling back to a file-based registry
