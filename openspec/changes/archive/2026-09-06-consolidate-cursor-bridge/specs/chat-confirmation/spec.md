# Chat Confirmation Specification

## Purpose

Deliver the Enter keystroke that submits a chat message to Cursor using one cross-platform implementation (`@nut-tree-fork/nut-js`), replacing the Windows-only PowerShell (`WScript.Shell` / `SendKeys`) mechanism.

## Requirements

### Requirement: Cross-platform Enter keystroke

The extension MUST send the Enter keystroke to confirm a chat submission using `@nut-tree-fork/nut-js` (`keyboard.pressKey(Key.Enter)` / `keyboard.releaseKey(Key.Enter)`), with no dependency on `powershell.exe` or any OS-specific shell.

#### Scenario: Sending a message on macOS

- GIVEN a chat message has been typed into Cursor's input on macOS
- WHEN the extension confirms the message
- THEN it presses and releases Enter via `nut-js`
- AND no call to `powershell.exe` or `exec` of a PowerShell script occurs

#### Scenario: Sending a message on Windows

- GIVEN a chat message has been typed into Cursor's input on Windows
- WHEN the extension confirms the message
- THEN it uses the same `nut-js` code path as macOS/Linux, not the previous PowerShell mechanism

### Requirement: No window-title dependency

The Enter-key confirmation MUST NOT depend on constructing or matching a window title, since `nut-js` operates on whatever window currently holds OS focus.

#### Scenario: Confirming without window title lookup

- GIVEN the extension needs to confirm a message
- WHEN it invokes the `nut-js`-based `sendEnterKey`
- THEN no window title is computed or passed, and no `AppActivate`-style window-activation call is made

### Requirement: Documented focus-stealing limitation

The system MUST document, in code comments and user-facing README, that pressing Enter via OS-level keystroke simulation requires Cursor to hold OS focus and may briefly steal focus from the user's current window, and that this is a known, accepted limitation with no available workaround on any supported OS.

#### Scenario: Reading the sendEnterKey implementation

- GIVEN a developer reads the `sendEnterKey` function
- WHEN they look for an explanation of its focus behavior
- THEN a comment states that Cursor must be focused for the keystroke to arrive, and that brief focus-stealing is expected and unavoidable

#### Scenario: Reading the README

- GIVEN a user reads the `vscode-mcp` README
- WHEN they look for known limitations of the Cursor bridge
- THEN the README states that confirming a message may briefly steal window focus, and that this is a known, accepted limitation
