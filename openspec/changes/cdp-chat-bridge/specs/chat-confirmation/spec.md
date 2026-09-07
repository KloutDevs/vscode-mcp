# Delta for Chat Confirmation

## REMOVED Requirements

### Requirement: Cross-platform Enter keystroke

(Reason: OS-level keystroke simulation via `@nut-tree-fork/nut-js` is unreliable — it requires real OS focus, needs Accessibility/Automation permissions not always available, and races with concurrent tab activity. CDP trusted input events replace it entirely.)
(Migration: see ADDED "CDP trusted input confirmation" below; `sendEnterKey`, `focusChatInput`, and the `@nut-tree-fork/nut-js` dependency are deleted from the extension.)

### Requirement: No window-title dependency

(Reason: this requirement described a property of the removed `nut-js` mechanism (no window-title lookup needed for OS focus). It no longer applies once confirmation happens over CDP, which targets a specific page ID rather than relying on OS window focus at all.)
(Migration: None — CDP's `Target.attachToTarget` addresses the correct page directly by `id`, making window-title matching unnecessary by construction.)

### Requirement: Documented focus-stealing limitation

(Reason: CDP dispatches trusted input events directly to the targeted Chromium page via `Target.attachToTarget`; it does not require the Cursor window to hold OS-level focus, so no focus-stealing occurs and there is nothing to document as a limitation.)
(Migration: None — the limitation no longer exists.)

## ADDED Requirements

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
