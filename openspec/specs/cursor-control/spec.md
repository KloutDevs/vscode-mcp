# Cursor Control Specification

## Purpose

Provide a single, cross-platform MCP tool set to discover, inspect, and drive Cursor windows (multi-window and multi-tab agent sessions) from the `vscode-mcp` client, replacing the overlapping and duplicated tool sets previously split across `nexus-mcp`, `klout-mcp`, and the old `vscode-mcp/src/index.ts`.

## Requirements

### Requirement: Multi-window discovery

The system MUST expose a `cursor_list_workspaces` tool that returns every live Cursor bridge instance (workspace name and port) without scanning a fixed port range.

#### Scenario: Two Cursor windows open

- GIVEN two Cursor windows are open, each running the bridge extension
- WHEN `cursor_list_workspaces` is called
- THEN the response lists both workspaces with their distinct ports
- AND no port scanning occurs

#### Scenario: Stale window closed abruptly

- GIVEN a Cursor window was closed without the extension deactivating cleanly
- WHEN `cursor_list_workspaces` is called
- THEN the stale entry is excluded from the result

### Requirement: Port-scoped Cursor tools

The system MUST expose the following tools, each accepting an explicit `port` parameter (obtained from `cursor_list_workspaces` or `cursor_open_chat`) to target a specific Cursor window: `cursor_status`, `cursor_list_commands`, `cursor_open_chat`, `cursor_get_model`, `cursor_set_model`, `cursor_open_model_picker`, `cursor_open_file`, `cursor_editor_state`, `cursor_diagnostics`, `cursor_run_command`.

#### Scenario: Checking bridge status for one window

- GIVEN a known bridge port from `cursor_list_workspaces`
- WHEN `cursor_status` is called with that port
- THEN the tool returns whether the bridge is active for that window

#### Scenario: Running an arbitrary command

- GIVEN a Cursor window's port and a command ID discovered via `cursor_list_commands`
- WHEN `cursor_run_command` is called with that port and command
- THEN the command executes in the targeted window only

### Requirement: Multi-tab message send and read

The system MUST support sending and reading chat messages scoped to a specific agent tab via `composer_id`, in addition to session scoping via `since_ms`.

#### Scenario: First message in a new session

- GIVEN a chat panel was just opened via `cursor_open_chat`, yielding `since_ms`
- WHEN `cursor_send` is called with `port`, `message`, and `since_ms`
- THEN the message is delivered and the response includes a `composer_id`

#### Scenario: Follow-up message to the same tab

- GIVEN a `composer_id` returned by a prior `cursor_send` call
- WHEN `cursor_send` is called again with `port`, `message`, and that `composer_id`
- THEN the message is delivered to that specific agent tab, isolated from other tabs in the same window

#### Scenario: Reading a specific tab's history

- GIVEN a `composer_id` for an existing agent session
- WHEN `cursor_read_chat` is called with `port` and `composer_id`
- THEN only that tab's conversation history is returned

### Requirement: Blocking send-and-wait

The system MUST expose `cursor_send_and_wait`, which sends a message and blocks until Cursor's agent finishes responding, without polling.

#### Scenario: Message completes before timeout

- GIVEN a message is sent via `cursor_send_and_wait` with `port`, `message`, and `since_ms`
- WHEN Cursor writes its final assistant message
- THEN the tool resolves immediately with the response text and elapsed time

#### Scenario: Response exceeds timeout

- GIVEN `cursor_send_and_wait` is called with a `timeout_ms` value
- WHEN Cursor has not produced a final message before that timeout elapses
- THEN the tool returns an error result indicating the send was not confirmed within the timeout

### Requirement: Extension deployment tool

The system MUST expose a `cursor_deploy_extension` tool that builds, packages, installs, and reloads the bridge extension, resolving script and extension paths relative to the running module rather than any hardcoded OS-specific path.

#### Scenario: Deploying after an extension code change

- GIVEN a change was made to the extension source
- WHEN `cursor_deploy_extension` is called
- THEN the extension is rebuilt, packaged, installed, and reloaded regardless of host OS or clone location
