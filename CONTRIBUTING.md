# Contributing to cursor-bridge

Thanks for considering a contribution. This is a small, single-maintainer project — keep changes focused and this stays easy for everyone.

## Reporting issues

Search [existing issues](https://github.com/KloutDevs/cursor-bridge/issues) first. If you're filing a new one, use the appropriate issue template and include:

- Cursor version (`cursor --version`) and OS
- Whether you're using the CDP-based tools (`cursor_send`, `cursor_read_chat`, `cursor_list_workspaces`) or the extension-backed ones
- Steps to reproduce, and what you expected vs. what happened

For security vulnerabilities, see [SECURITY.md](SECURITY.md) instead — do not open a public issue.

## Development setup

```bash
git clone https://github.com/KloutDevs/cursor-bridge.git
cd cursor-bridge
npm install
npm run build
```

To work on the extension:

```bash
cd extension
npm install
npm run build
```

`bash scripts/deploy.sh` builds both, packages the extension as a `.vsix`, installs it into Cursor, and reloads the active window.

## Running tests

```bash
npm run build
node --test dist/*.test.js

cd extension
npm run build
node --test dist/*.test.js
```

There's no test runner wired into `npm test` yet — run the two commands above directly.

## Making a pull request

- One logical change per PR. If it touches both the client (`src/`) and the extension (`extension/`), that's fine as long as it's one coherent change — don't bundle unrelated fixes.
- Reference an issue if one exists (`Fixes #123`).
- Run the build and tests above before opening the PR; a red CI check is fine to iterate on, but don't open a PR you haven't built locally at least once.
- Use [Conventional Commits](https://www.conventionalcommits.org/) style for commit messages (`feat:`, `fix:`, `docs:`, `chore:`) — this repo's history already follows that convention.
- Update `CHANGELOG.md` under `[Unreleased]` for any user-facing change.

## Code style

TypeScript, ESM in `src/`, CommonJS in `extension/` (VS Code extension host requirement). No linter/formatter is currently enforced — match the existing style in the file you're editing (2-space indent, double quotes, semicolons).

## Scope note

Both `src/cdp.ts` (Chrome DevTools Protocol) and `src/composerStore.ts` (`state.vscdb` reads) depend on **undocumented internals of Cursor** (a private DOM selector, a private SQLite schema). If your PR touches either file, say in the PR description which Cursor version you tested against — this surface can and does change between Cursor releases without notice.
