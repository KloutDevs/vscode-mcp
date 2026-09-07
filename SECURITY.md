# Security Policy

## Supported Versions

This project doesn't maintain multiple release lines — only the latest version on `main` is supported. Please update before reporting an issue.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, use one of:

- [GitHub Private Vulnerability Reporting](https://github.com/KloutDevs/cursor-bridge/security/advisories/new) (preferred)
- Email kloutdevs@gmail.com

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal example helps a lot)
- The version/commit you tested against

You should receive a response within a few days. This is a single-maintainer project, so response time may vary — please be patient.

## Scope notes specific to this project

- `cursor-bridge` reads Cursor's local `state.vscdb` (SQLite) and talks to Cursor's Chrome DevTools Protocol debug port (`--remote-debugging-port`). Both are **local-only** by design (bound to `127.0.0.1`). If you find a way this could be reached from outside localhost, or a way the CDP/extension HTTP bridge could be abused by another local process without the user's intent, that's a valid report.
- The `run_command`/`cursor_run_command` tools execute arbitrary shell commands / VS Code commands by design — this is documented, expected behavior for an MCP server the user explicitly configures, not a vulnerability on its own.
