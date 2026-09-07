# Bridge Discovery Specification

## Purpose

Discover open Cursor windows using Chrome DevTools Protocol (`/json/list` endpoint) instead of OS-assigned ephemeral ports and on-disk registry files, enabling reliable multi-window discovery without registry state management.

## Requirements

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
