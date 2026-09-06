# Bridge Discovery Specification

## Purpose

Replace fixed/scanned bridge ports with OS-assigned ephemeral ports published to a shared on-disk registry, so any number of Cursor windows can be discovered reliably without port collisions or hardcoded ranges.

## Requirements

### Requirement: Ephemeral port binding

The bridge extension MUST bind an OS-assigned ephemeral port (`listen(0, ...)`) instead of a fixed or configured port.

#### Scenario: Extension activates

- GIVEN the `cursor-mcp-bridge` extension activates in a Cursor window
- WHEN it starts its HTTP server
- THEN the OS assigns a free port and no fixed port (e.g. 9421) is required
- AND the extension's configurable port setting no longer exists

### Requirement: Registry file publication

On successful bind, the extension MUST write an entry to `~/.vscode-mcp-bridge/registry.json` (`$USERPROFILE` on Windows, `$HOME` on Mac/Linux) containing the bound port as key and an object with `workspace`, `pid`, and `startedAt` fields, preserving existing entries for other windows.

#### Scenario: First window starts

- GIVEN no registry file exists yet
- WHEN the extension binds its port
- THEN the registry file is created with one entry for that window

#### Scenario: Second window starts alongside the first

- GIVEN a registry file already has one entry
- WHEN a second Cursor window's extension binds its port
- THEN the registry file contains both entries, and the first entry is unchanged

### Requirement: Registry cleanup on deactivation

The extension MUST remove its own registry entry when it deactivates cleanly.

#### Scenario: Window closes normally

- GIVEN a Cursor window with a registered bridge entry is closed normally
- WHEN the extension's `deactivate()` runs
- THEN its entry is removed from the registry file
- AND other entries remain untouched

### Requirement: Passive dead-PID cleanup on read

The client MUST discard registry entries whose process is no longer alive when reading the registry, rather than relying solely on deactivation cleanup.

#### Scenario: Cursor crashes without deactivating

- GIVEN a registry entry exists for a Cursor process that has crashed or was force-killed
- WHEN the client reads the registry (e.g. via `cursor_list_workspaces`)
- THEN that entry is excluded from the returned list because its PID is no longer alive
- AND the stale entry may remain in the file itself (no file rewrite required by this read)

#### Scenario: Registry file missing or unreadable

- GIVEN the registry file does not exist or contains invalid JSON
- WHEN the client attempts to read it
- THEN the client treats it as an empty registry rather than raising an error
