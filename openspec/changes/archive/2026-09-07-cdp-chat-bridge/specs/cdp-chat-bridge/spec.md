# CDP Chat Bridge Specification

## Purpose

Send chat messages to Cursor and read conversation history directly from the client, using Chrome DevTools Protocol (CDP) for trusted input and direct SQLite reads of Cursor's `state.vscdb`, replacing keystroke simulation and the extension's HTTP chat endpoints.

## Requirements

### Requirement: CDP-based trusted message send

The client MUST send chat messages to a Cursor window by connecting to its CDP debug endpoint, attaching to the target page, and dispatching trusted input events (`Input.insertText` for the message text, `Input.dispatchKeyEvent` for Enter), rather than any OS-level keystroke simulation.

#### Scenario: Sending a message to an existing chat tab

- GIVEN a Cursor window is reachable via CDP and has an open chat tab (`.aislash-editor-input` present)
- WHEN the client sends a message
- THEN it clicks the input via `Input.dispatchMouseEvent`, inserts the text via `Input.insertText`, and confirms via `Input.dispatchKeyEvent` (Enter) with `isTrusted: true` semantics
- AND no OS-level keyboard/window-focus simulation occurs

#### Scenario: No chat tab open yet

- GIVEN a Cursor window is reachable via CDP but has no chat tab open
- WHEN the client attempts to send a message and finds no `.aislash-editor-input` element
- THEN the client requests `composer.createNewComposerTab` via the extension's `/command` endpoint
- AND retries the CDP send once a chat tab exists

### Requirement: Direct SQLite conversation read

The client MUST read chat conversation history directly from Cursor's `state.vscdb` SQLite database, using keys `composerData:<composerId>` and `bubbleId:<composerId>:<bubbleId>`, instead of any file-watch or HTTP-mediated read.

#### Scenario: Reading a conversation by composer ID

- GIVEN a `composerId` for an existing chat session
- WHEN the client reads its history
- THEN it opens `state.vscdb` and reads `composerData:<composerId>` for the ordered bubble list, then reads each `bubbleId:<composerId>:<bubbleId>` for message text and type
- AND no JSONL file or `fs.watch` mechanism is used

#### Scenario: Waiting for the agent's final reply

- GIVEN a message was just sent for a given `composerId`
- WHEN the client waits for a response
- THEN it polls `composerData:<composerId>` at a bounded interval until the reply count increases and `status` is `"completed"`, or a timeout elapses
- AND no `fs.watch` on `state.vscdb` or its WAL file is used

### Requirement: CDP debug port precondition

The system MUST require Cursor to be launched with `--remote-debugging-port` for CDP-based send and window discovery to function, and MUST surface a clear, actionable error when the configured debug port is unreachable.

#### Scenario: Debug port unreachable

- GIVEN Cursor was not launched with `--remote-debugging-port` (or the configured `CURSOR_CDP_PORT` is wrong)
- WHEN the client attempts to connect to `http://127.0.0.1:<port>/json/list`
- THEN the client returns an error identifying the unreachable port and instructing the user to relaunch Cursor with the debug flag
- AND the client does not fall back to keystroke simulation or any other send mechanism

#### Scenario: Configurable debug port

- GIVEN the `CURSOR_CDP_PORT` environment variable is set to a non-default value
- WHEN the client connects for discovery, send, or read
- THEN it uses that configured port instead of the default `9222`
