# Delta for Cursor Control

## MODIFIED Requirements

### Requirement: Multi-window discovery

The system MUST expose a `cursor_list_workspaces` tool that returns every open Cursor window (workspace name and CDP page identifier) by querying the CDP `/json/list` endpoint, without reading any on-disk registry or scanning a fixed port range.
(Previously: sourced results from the extension's on-disk `registry.json`.)

#### Scenario: Two Cursor windows open

- GIVEN two Cursor windows are open, each reachable via the CDP debug port
- WHEN `cursor_list_workspaces` is called
- THEN the response lists both windows with their `title` and CDP page `id`
- AND no registry file is read and no port scanning occurs

#### Scenario: Stale window closed abruptly

- GIVEN a Cursor window was closed (cleanly or abruptly)
- WHEN `cursor_list_workspaces` is called
- THEN the stale entry is excluded from the result, because CDP's `/json/list` only reflects live pages

### Requirement: Multi-tab message send and read

The system MUST support sending and reading chat messages scoped to a specific agent tab via `composer_id`. `cursor_send` and `cursor_send_and_wait` MUST deliver messages via CDP trusted input (see `cdp-chat-bridge`), and `cursor_read_chat` MUST read history directly from `state.vscdb` via SQLite, rather than calling the extension's HTTP bridge for these operations.
(Previously: `cursor_send`, `cursor_send_and_wait`, and `cursor_read_chat` called the extension's `/chat/*` HTTP endpoints, which simulated an Enter keystroke and read a JSONL transcript.)

#### Scenario: First message in a new session

- GIVEN a chat panel was just opened via `cursor_open_chat`, yielding `since_ms`
- WHEN `cursor_send` is called with `port`, `message`, and `since_ms`
- THEN the message is delivered via CDP to the targeted window's chat input
- AND the response includes a `composer_id`

#### Scenario: Follow-up message to the same tab

- GIVEN a `composer_id` returned by a prior `cursor_send` call
- WHEN `cursor_send` is called again with `port`, `message`, and that `composer_id`
- THEN the message is delivered via CDP to that specific agent tab, isolated from other tabs in the same window

#### Scenario: Reading a specific tab's history

- GIVEN a `composer_id` for an existing agent session
- WHEN `cursor_read_chat` is called with `port` and `composer_id`
- THEN only that tab's conversation history is returned, read directly from `state.vscdb`
- AND no HTTP call is made to the extension for this read

### Requirement: Blocking send-and-wait

The system MUST expose `cursor_send_and_wait`, which sends a message via CDP and blocks until the agent's response is marked `"completed"` in `state.vscdb`, without polling any HTTP endpoint or watching a JSONL file.
(Previously: blocked on the extension's HTTP `/chat/send_and_wait` endpoint, which itself watched a JSONL transcript file.)

#### Scenario: Message completes before timeout

- GIVEN a message is sent via `cursor_send_and_wait` with `port`, `message`, and `since_ms`
- WHEN Cursor writes its final assistant message to `state.vscdb` with `status: "completed"`
- THEN the tool resolves with the response text and elapsed time

#### Scenario: Response exceeds timeout

- GIVEN `cursor_send_and_wait` is called with a `timeout_ms` value
- WHEN Cursor has not produced a `"completed"` message before that timeout elapses
- THEN the tool returns an error result indicating the send was not confirmed within the timeout

## Notes on Unchanged Requirements

- "Port-scoped Cursor tools" (`cursor_status`, `cursor_list_commands`, `cursor_open_chat`, `cursor_get_model`, `cursor_set_model`, `cursor_open_model_picker`, `cursor_open_file`, `cursor_editor_state`, `cursor_diagnostics`, `cursor_run_command`) is unchanged: these tools continue to call the extension's HTTP bridge on its fixed port.
- "Extension deployment tool" (`cursor_deploy_extension`) is unchanged.
