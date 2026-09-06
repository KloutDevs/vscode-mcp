# Extension Deployment Specification

## Purpose

Make building, packaging, and installing the `cursor-mcp-bridge` extension work on Mac/Linux as well as Windows, removing hardcoded Windows-only paths from both `deploy.sh` and `cursor_deploy_extension`.

## Requirements

### Requirement: Cross-platform extensions directory resolution

`scripts/deploy.sh` MUST resolve the Cursor extensions install directory using `$USERPROFILE` when set, falling back to `$HOME` otherwise, instead of assuming `$USERPROFILE` is always present.

#### Scenario: Running on macOS or Linux

- GIVEN `deploy.sh` runs on a machine where `$USERPROFILE` is not set
- WHEN the script determines the extensions directory
- THEN it uses `$HOME/.cursor/extensions`
- AND the script completes without error due to an undefined variable

#### Scenario: Running on Windows

- GIVEN `deploy.sh` runs on a machine where `$USERPROFILE` is set
- WHEN the script determines the extensions directory
- THEN it uses `$USERPROFILE/.cursor/extensions`, preserving existing Windows behavior

### Requirement: Runtime-resolved deploy script path

The `cursor_deploy_extension` MCP tool MUST resolve the path to `scripts/deploy.sh` relative to the running module's own location, not a hardcoded absolute path tied to one machine or OS.

#### Scenario: Repository cloned to a non-default location

- GIVEN `vscode-mcp` is cloned to an arbitrary directory on any supported OS
- WHEN `cursor_deploy_extension` is invoked
- THEN it locates and executes `scripts/deploy.sh` correctly without relying on a hardcoded absolute path

#### Scenario: Previously hardcoded path is absent

- GIVEN the previous implementation hardcoded a Windows-specific path (e.g. `C:/Users/.../vscode-mcp/scripts/deploy.sh`)
- WHEN `cursor_deploy_extension` runs on macOS or Linux
- THEN deployment succeeds because no OS-specific path is referenced
