# Chat Confirmation Specification

## Purpose

Confirm chat message submissions using Chrome DevTools Protocol (CDP) trusted input events, replacing OS-level keystroke simulation.

## Requirements

### Requirement: CDP trusted input confirmation

The system MUST confirm a chat submission by dispatching trusted CDP input events — `Input.dispatchMouseEvent` to focus the input, `Input.insertText` for the message text, and `Input.dispatchKeyEvent` (keyDown/keyUp, `windowsVirtualKeyCode: 13`) for Enter — targeted at the specific attached page, on all supported operating systems.

#### Scenario: Confirming a message on any OS

- GIVEN a chat message is ready to send in a Cursor window reachable via CDP
- WHEN the system confirms the message
- THEN it dispatches the same CDP event sequence regardless of host OS
- AND no `@nut-tree-fork/nut-js`, `powershell.exe`, or any OS-level keystroke API is invoked

#### Scenario: Cursor window not holding OS focus

- GIVEN the Cursor window targeted by CDP is not the OS-focused window
- WHEN the system confirms the message via CDP
- THEN the trusted input events are still delivered to the targeted page
- AND no other window briefly gains or loses OS focus as a side effect
