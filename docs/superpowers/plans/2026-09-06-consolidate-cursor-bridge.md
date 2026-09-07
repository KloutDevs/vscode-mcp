# Consolidate cursor-mcp-bridge clients — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `vscode-mcp` into the single client MCP (filesystem + full Cursor control, multi-window/multi-tab) and its `cursor-mcp-bridge` extension into a cross-platform, dynamic-port bridge — replacing the three overlapping clients (`nexus-mcp`, `klout-mcp`, old `vscode-mcp/src`) and the Windows-only PowerShell send mechanism.

**Architecture:** The extension (`extension/src/extension.ts`) binds an OS-assigned ephemeral port instead of a fixed one, and publishes `{port, workspace, pid}` to a shared JSON registry file on disk. The client (`src/index.ts`) reads that registry to discover all active Cursor windows — no port scanning. Message submission switches from `exec()`-ing PowerShell to `@nut-tree-fork/nut-js`, one code path for every OS.

**Tech Stack:** TypeScript, Node.js (ESM), `@modelcontextprotocol/sdk`, `vscode` extension API, `@nut-tree-fork/nut-js`, Node's built-in `node:test` runner (no test framework currently installed).

**Spec:** `docs/superpowers/specs/2026-09-06-consolidate-cursor-bridge-design.md`

## Global Constraints

- Registry file path: `~/.vscode-mcp-bridge/registry.json` (`$USERPROFILE` on Windows, `$HOME` on Mac/Linux).
- Registry entry shape: `{ [port: string]: { workspace: string; pid: number; startedAt: number } }`.
- Extension version must be bumped in `extension/package.json` before packaging (existing project convention).
- No new runtime dependency for the client (`src/index.ts`) — filesystem-only registry reads, `process.kill(pid, 0)` for liveness checks.
- `@nut-tree-fork/nut-js` is the only new dependency, added to `extension/package.json` only.

---

## Task 1: Registry file helpers in the extension (pure logic, unit-testable)

**Files:**
- Create: `extension/src/registry.ts`
- Test: `extension/src/registry.test.ts`

**Interfaces:**
- Produces: `registryPath(): string`, `writeRegistryEntry(port: number, workspace: string, pid: number): void`, `removeRegistryEntry(port: number): void` — consumed by Task 2 (`extension.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// extension/src/registry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registryPath, writeRegistryEntry, removeRegistryEntry } from "./registry.js";

function withTempHome<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "vscode-mcp-test-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  delete process.env.USERPROFILE;
  try {
    return fn();
  } finally {
    process.env.HOME = prevHome;
    if (prevUserProfile) process.env.USERPROFILE = prevUserProfile;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeRegistryEntry creates the file with the entry", () => {
  withTempHome(() => {
    writeRegistryEntry(9531, "my-workspace", 1234);
    const raw = readFileSync(registryPath(), "utf-8");
    const data = JSON.parse(raw);
    assert.equal(data["9531"].workspace, "my-workspace");
    assert.equal(data["9531"].pid, 1234);
    assert.equal(typeof data["9531"].startedAt, "number");
  });
});

test("writeRegistryEntry preserves other entries", () => {
  withTempHome(() => {
    writeRegistryEntry(9531, "workspace-a", 1234);
    writeRegistryEntry(9532, "workspace-b", 5678);
    const data = JSON.parse(readFileSync(registryPath(), "utf-8"));
    assert.equal(Object.keys(data).length, 2);
    assert.equal(data["9531"].workspace, "workspace-a");
    assert.equal(data["9532"].workspace, "workspace-b");
  });
});

test("removeRegistryEntry deletes only the given port", () => {
  withTempHome(() => {
    writeRegistryEntry(9531, "workspace-a", 1234);
    writeRegistryEntry(9532, "workspace-b", 5678);
    removeRegistryEntry(9531);
    const data = JSON.parse(readFileSync(registryPath(), "utf-8"));
    assert.equal(data["9531"], undefined);
    assert.equal(data["9532"].workspace, "workspace-b");
  });
});

test("removeRegistryEntry on a missing file is a no-op", () => {
  withTempHome(() => {
    assert.doesNotThrow(() => removeRegistryEntry(9531));
    assert.equal(existsSync(registryPath()), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx tsc && node --test dist/registry.test.js`
Expected: FAIL — `Cannot find module './registry.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// extension/src/registry.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

type RegistryEntry = { workspace: string; pid: number; startedAt: number };
type Registry = Record<string, RegistryEntry>;

export function registryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".vscode-mcp-bridge", "registry.json");
}

function readRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Registry;
  } catch {
    return {};
  }
}

function writeRegistry(data: Registry): void {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

export function writeRegistryEntry(port: number, workspace: string, pid: number): void {
  const data = readRegistry();
  data[String(port)] = { workspace, pid, startedAt: Date.now() };
  writeRegistry(data);
}

export function removeRegistryEntry(port: number): void {
  const data = readRegistry();
  delete data[String(port)];
  writeRegistry(data);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx tsc && node --test dist/registry.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/registry.ts extension/src/registry.test.ts
git commit -m "feat(extension): add shared registry file for bridge port discovery"
```

---

## Task 2: Dynamic port + registry wiring in the extension

**Files:**
- Modify: `extension/src/extension.ts:1-5` (imports)
- Modify: `extension/src/extension.ts:35-61` (`activate`)
- Modify: `extension/src/extension.ts:63-66` (`deactivate`)
- Modify: `extension/src/extension.ts:135-178` (`startServer`)
- Modify: `extension/src/extension.ts:180-183` (`stopServer`)
- Modify: `extension/src/extension.ts:206-215` (`GET /status` route)

**Interfaces:**
- Consumes: `writeRegistryEntry`, `removeRegistryEntry` from Task 1 (`./registry.js`).
- Produces: module-level `actualPort: number` — the real bound port, used by the `/status` route.

- [ ] **Step 1: Add the import and module-level port variable**

In `extension.ts`, after the existing imports (after line 5), add:

```ts
import { writeRegistryEntry, removeRegistryEntry } from "./registry.js";

let actualPort = 0;
```

- [ ] **Step 2: Change `startServer` to bind an ephemeral port and register it**

Replace the current `startServer` function (lines 135-178):

```ts
function startServer(context: vscode.ExtensionContext) {
  server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      handleRequest(req, res, body).catch((err) => {
        log(`Unhandled error: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server?.address();
    actualPort = typeof address === "object" && address ? address.port : 0;
    writeRegistryEntry(actualPort, getWorkspaceName(), process.pid);
    log(`Bridge listening on http://127.0.0.1:${actualPort}`);
    statusBarItem.text = `$(radio-tower) MCP :${actualPort}`;
    statusBarItem.tooltip = `Cursor MCP Bridge active on port ${actualPort}`;
    statusBarItem.show();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    const msg = `Server error: ${err.message}`;
    log(msg);
    vscode.window.showErrorMessage(`MCP Bridge: ${msg}`);
    statusBarItem.text = `$(error) MCP Bridge error`;
    statusBarItem.show();
  });
}
```

Note: `cursorMcpBridge.port` configuration is no longer read here — port is always OS-assigned.

- [ ] **Step 3: Change `stopServer` to clean up its registry entry**

Replace `stopServer` (lines 180-183):

```ts
function stopServer() {
  if (actualPort) removeRegistryEntry(actualPort);
  server?.close();
  server = null;
}
```

- [ ] **Step 4: Confirm `deactivate` already calls `stopServer`**

`deactivate` (lines 63-66) already calls `stopServer()` — no change needed, it now benefits from the registry cleanup added in Step 3.

- [ ] **Step 5: Update `GET /status` to report the real port**

Replace the `GET /status` block (lines 206-215):

```ts
  if (route === "GET /status") {
    return json(res, 200, {
      active: true,
      version: "2.0.0",
      port: actualPort,
      workspace: getWorkspaceName(),
      workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
    });
  }
```

- [ ] **Step 6: Remove the now-unused port setting from `package.json`**

In `extension/package.json`, remove the `cursorMcpBridge.port` property from `contributes.configuration.properties` (the whole `"cursorMcpBridge.port": { ... }` block) since the port is no longer configurable — it's always OS-assigned.

- [ ] **Step 7: Build and manually verify**

Run: `cd extension && npm run build`
Expected: compiles with no errors.

Manual check (requires Cursor running with the extension loaded — see Task 7 for packaging/install): after reload, open the registry file (`cat ~/.vscode-mcp-bridge/registry.json` on Mac, or the extension's Output channel) and confirm an entry appears with a non-9421 port and the correct workspace name and a live `pid`.

- [ ] **Step 8: Commit**

```bash
git add extension/src/extension.ts extension/package.json
git commit -m "feat(extension): bind ephemeral port and publish it to the registry"
```

---

## Task 3: Replace PowerShell `sendEnterKey` with `nut-js`

**Files:**
- Modify: `extension/package.json` (add dependency)
- Modify: `extension/src/extension.ts:17-33` (remove now-unused command lists — no, keep those, they're for `/chat/open`; only touch `sendEnterKey`)
- Modify: `extension/src/extension.ts:121-131` (`sendEnterKey`)

**Interfaces:**
- Consumes: `keyboard`, `Key` from `@nut-tree-fork/nut-js`.
- Produces: `sendEnterKey(): Promise<void>` — same signature as before, so Task 2's callers (`/chat/send`, `/chat/send_and_wait`) need no changes.

- [ ] **Step 1: Add the dependency**

In `extension/package.json`, add to `dependencies` (create the key if it doesn't exist — currently the extension only has `devDependencies`):

```json
"dependencies": {
  "@nut-tree-fork/nut-js": "^4.2.0"
}
```

- [ ] **Step 2: Install it**

Run: `cd extension && npm install`
Expected: installs successfully. If it fails with a native build error, note the failure — Task requires `node-gyp` build tools present (Xcode Command Line Tools on Mac, `build-essential` on Linux, Visual Studio Build Tools on Windows); install those and retry before proceeding.

- [ ] **Step 3: Replace `sendEnterKey`**

Replace the current implementation (lines 121-131):

```ts
import { keyboard, Key } from "@nut-tree-fork/nut-js";

// ...

// NOTE: this presses Enter into whatever window currently has OS focus.
// Cursor must already be the frontmost/focused window for this to reach
// the chat input — there is no known way to deliver a keystroke to Cursor
// without it holding focus, on any OS (confirmed via research, see spec
// docs/superpowers/specs/2026-09-06-consolidate-cursor-bridge-design.md).
async function sendEnterKey(): Promise<void> {
  await keyboard.pressKey(Key.Enter);
  await keyboard.releaseKey(Key.Enter);
}
```

Remove the old `getWorkspaceName()`-based `windowTitle` construction and the `exec(...)` call to `powershell` entirely — `nut-js` needs no window title, it operates on whatever has OS focus.

- [ ] **Step 4: Remove the now-unused `exec` import if nothing else uses it**

Check remaining usages of `exec` from `child_process` in `extension.ts` — it was only used by the old `sendEnterKey`. If no other call site remains, remove `import { exec } from "child_process";` from the top of the file.

- [ ] **Step 5: Build**

Run: `cd extension && npm run build`
Expected: compiles with no errors.

- [ ] **Step 6: Manual verification (macOS)**

Package and install the extension (see Task 7), open a Cursor agent chat, trigger `/chat/send` via a manual `curl` call using the registry-discovered port:

```bash
PORT=$(node -pe "Object.keys(JSON.parse(require('fs').readFileSync(process.env.HOME + '/.vscode-mcp-bridge/registry.json', 'utf-8')))[0]")
curl -s -X POST "http://127.0.0.1:$PORT/chat/send" -H "Content-Type: application/json" -d '{"message":"hola, esto es una prueba"}'
```

Expected: macOS prompts for Accessibility permission the first time (grant it to the Cursor / Extension Host process); the message appears sent in Cursor's chat and the curl response shows `"confirmed": true`.

- [ ] **Step 7: Commit**

```bash
git add extension/package.json extension/package-lock.json extension/src/extension.ts
git commit -m "feat(extension): replace PowerShell keystroke simulation with nut-js"
```

---

## Task 4: Fix `cursor_deploy_extension` hardcoded Windows path

**Files:**
- Modify: `src/index.ts` (the `cursor_deploy_extension` handler — this logic is being merged in from `nexus-mcp` per Task 5, so apply this fix as part of writing that handler in Task 5, Step 3. This task exists only to document the fix in isolation for review purposes — see Task 5.)

This task is folded into Task 5 (the handler doesn't exist yet in `vscode-mcp/src/index.ts` until that merge happens). No standalone commit here.

---

## Task 5: Merge Cursor-control tools into `vscode-mcp/src/index.ts`

**Files:**
- Modify: `src/index.ts` (replace the existing Cursor-tools block with the consolidated set)

**Interfaces:**
- Consumes: nothing new from other tasks (client-side, talks to the bridge over HTTP as before).
- Produces: tool names available to Claude Code — `cursor_list_workspaces`, `cursor_status`, `cursor_open_chat`, `cursor_send_and_wait`, `cursor_send`, `cursor_read_chat`, `cursor_get_model`, `cursor_set_model`, `cursor_open_model_picker`, `cursor_open_file`, `cursor_editor_state`, `cursor_diagnostics`, `cursor_run_command`, `cursor_list_commands`, `cursor_deploy_extension` — plus the existing filesystem tools, unchanged.

- [ ] **Step 1: Remove the old single-port `bridgeCall` and replace with a port-aware version**

In `src/index.ts`, replace the existing `bridgeCall` function and the `BRIDGE_PORT` constant (currently near the top, using `MCP_BRIDGE_PORT` env var) with:

```ts
function bridgeCall(method: string, path: string, body?: unknown, port?: number, timeoutMs = 310_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: port ?? 9421,
        path,
        method,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload, "utf8") } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { resolve(Buffer.concat(chunks).toString("utf8")); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("bridge timeout")); });
    if (payload) req.write(payload, "utf8");
    req.end();
  });
}

function readRegistry(): Record<string, { workspace: string; pid: number; startedAt: number }> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const path = join(home, ".vscode-mcp-bridge", "registry.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(require("fs").readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

`join` and `existsSync` are already imported at the top of `src/index.ts` from `path` and `fs` respectively — no new imports needed for those two.

- [ ] **Step 2: Add the consolidated tool definitions**

In the `TOOLS` array in `src/index.ts`, remove the existing Cursor-bridge tool entries (`cursor_status`, `cursor_list_commands`, `cursor_open_chat`, `cursor_send_message`, `cursor_get_model`, `cursor_set_model`, `cursor_open_model_picker`, `cursor_send_and_wait`, `cursor_open_file`, `cursor_editor_state`, `cursor_diagnostics`, `cursor_run_command`) and replace them with:

```ts
  {
    name: "cursor_list_workspaces",
    description: "Discover all active Cursor bridge instances by reading the shared registry file. Returns each open Cursor window with its workspace name and port. Use when multiple Cursor projects are open simultaneously.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cursor_status",
    description: "Check if the Cursor MCP bridge is running on a given port. Use cursor_list_workspaces to find the right port.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number", description: "Bridge port from cursor_list_workspaces" } },
      required: ["port"],
    },
  },
  {
    name: "cursor_list_commands",
    description: "List Cursor/VS Code commands available in a given window. Use filter to narrow results.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Bridge port" },
        filter: { type: "string", description: "Optional keyword filter (e.g. 'chat', 'model', 'glass')" },
      },
      required: ["port"],
    },
  },
  {
    name: "cursor_open_chat",
    description: "Open a new chat, composer, or agent panel in a Cursor window. Returns since_ms, workspace and port — store them to scope all subsequent calls to this session.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Bridge port from cursor_list_workspaces" },
        mode: { type: "string", enum: ["chat", "composer", "agent"], description: "Panel to open (default: agent)" },
      },
      required: ["port"],
    },
  },
  {
    name: "cursor_send_and_wait",
    description: "Send a message to the active Cursor agent in a given window and block until Cursor finishes responding. Uses fs.watch on the JSONL transcript — resolves the instant Cursor writes a final (non-tool-use) assistant message. No polling.",
    inputSchema: {
      type: "object",
      properties: {
        port:       { type: "number", description: "Bridge port from cursor_list_workspaces or cursor_open_chat" },
        message:    { type: "string", description: "Message to send" },
        since_ms:   { type: "number", description: "Timestamp from cursor_open_chat to scope this session" },
        timeout_ms: { type: "number", description: "Safety-valve timeout in ms (default 300000)" },
      },
      required: ["port", "message", "since_ms"],
    },
  },
  {
    name: "cursor_send",
    description: "Send a message to a Cursor window and return as soon as it's confirmed in the transcript (no waiting for Cursor's reply). On first call pass since_ms; after that pass composer_id for targeted, session-isolated delivery to a specific agent tab.",
    inputSchema: {
      type: "object",
      properties: {
        port:        { type: "number", description: "Bridge port" },
        message:     { type: "string", description: "Message to send" },
        since_ms:    { type: "number", description: "Timestamp from cursor_open_chat — used only when composer_id is unknown" },
        composer_id: { type: "string", description: "Composer ID returned by a previous cursor_send call — use this for all messages after the first, to target a specific agent tab" },
      },
      required: ["port", "message"],
    },
  },
  {
    name: "cursor_read_chat",
    description: "Read the conversation history of a Cursor agent session. Pass composer_id for direct, unambiguous access to a specific tab.",
    inputSchema: {
      type: "object",
      properties: {
        port:        { type: "number", description: "Bridge port" },
        composer_id: { type: "string", description: "Composer ID from cursor_send response — preferred over since_ms" },
        since_ms:    { type: "number", description: "Fallback: filter transcripts by creation time" },
      },
      required: ["port"],
    },
  },
  {
    name: "cursor_get_model",
    description: "Get the currently configured AI model in a Cursor window.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number", description: "Bridge port" } },
      required: ["port"],
    },
  },
  {
    name: "cursor_set_model",
    description: "Change the active AI model in a Cursor window (e.g. claude-sonnet-4-5, gpt-4o).",
    inputSchema: {
      type: "object",
      properties: {
        port:  { type: "number", description: "Bridge port" },
        model: { type: "string", description: "Model slug to activate" },
      },
      required: ["port", "model"],
    },
  },
  {
    name: "cursor_open_model_picker",
    description: "Open the model selector UI in a Cursor window so the user can pick a model visually.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number", description: "Bridge port" } },
      required: ["port"],
    },
  },
  {
    name: "cursor_open_file",
    description: "Open a file in a Cursor window's editor, optionally jumping to a specific line.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Bridge port" },
        path: { type: "string", description: "Absolute file path" },
        line: { type: "number", description: "Line number (1-indexed)" },
      },
      required: ["port", "path"],
    },
  },
  {
    name: "cursor_editor_state",
    description: "Get the currently active editor in a Cursor window: file path, cursor position, selected text, open editors.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number", description: "Bridge port" } },
      required: ["port"],
    },
  },
  {
    name: "cursor_diagnostics",
    description: "Get all errors and warnings from a Cursor window's language servers.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number", description: "Bridge port" } },
      required: ["port"],
    },
  },
  {
    name: "cursor_run_command",
    description: "Execute any VS Code / Cursor command by ID in a given window. Use cursor_list_commands to discover IDs.",
    inputSchema: {
      type: "object",
      properties: {
        port:    { type: "number", description: "Bridge port" },
        command: { type: "string", description: "Command ID" },
        args:    { type: "array",  description: "Optional arguments" },
      },
      required: ["port", "command"],
    },
  },
  {
    name: "cursor_deploy_extension",
    description: "Build, package, install and reload the cursor-mcp-bridge extension in one shot. Run this after any change to the extension source.",
    inputSchema: { type: "object", properties: {} },
  },
```

- [ ] **Step 3: Replace the tool handlers**

In the `CallToolRequestSchema` handler's `switch`, remove the old `case "cursor_status":` through `case "cursor_run_command":` blocks and replace with:

```ts
      case "cursor_list_workspaces": {
        const registry = readRegistry();
        const results = Object.entries(registry)
          .filter(([, entry]) => isPidAlive(entry.pid))
          .map(([port, entry]) => ({ port: Number(port), workspace: entry.workspace }));
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "cursor_status": {
        const result = await bridgeCall("GET", "/status", undefined, a.port as number, 10_000);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_list_commands": {
        const filter = (a.filter as string | undefined) ?? "";
        const qs = filter ? `?filter=${encodeURIComponent(filter)}` : "";
        const result = await bridgeCall("GET", `/commands${qs}`, undefined, a.port as number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_open_chat": {
        const port = a.port as number;
        const openedAt = Date.now();
        const result = await bridgeCall("POST", "/chat/open", { mode: (a.mode as string | undefined) ?? "agent" }, port, 10_000) as Record<string, unknown>;
        return { content: [{ type: "text", text: JSON.stringify({ ...result, since_ms: openedAt, port }, null, 2) }] };
      }

      case "cursor_send_and_wait": {
        const result = await bridgeCall("POST", "/chat/send_and_wait", {
          message:    a.message as string,
          since_ms:   a.since_ms as number,
          timeout_ms: (a.timeout_ms as number | undefined) ?? 300_000,
        }, a.port as number, ((a.timeout_ms as number | undefined) ?? 300_000) + 5_000) as { ok?: boolean; text?: string; error?: string; waited_ms?: number };

        if (!result.ok) {
          return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text", text: `**Cursor** (${result.waited_ms}ms):\n\n${result.text}` }] };
      }

      case "cursor_send": {
        const port = a.port as number;
        const result = await bridgeCall("POST", "/chat/send", {
          message:     a.message,
          since_ms:    a.since_ms,
          composer_id: a.composer_id,
        }, port, 65_000) as { ok?: boolean; confirmed?: boolean; composerId?: string; workspace?: string; attempt?: number; error?: string };
        if (!result.ok || !result.confirmed) {
          return { content: [{ type: "text", text: `Error: ${result.error ?? "send not confirmed"}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify({ confirmed: true, composer_id: result.composerId, workspace: result.workspace, port, attempt: result.attempt }) }] };
      }

      case "cursor_read_chat": {
        const port = a.port as number;
        const composerId = a.composer_id as string | undefined;
        const qs = composerId ? `?composer_id=${encodeURIComponent(composerId)}` : `?since=${a.since_ms ?? 0}`;
        const result = await bridgeCall("GET", `/chat/read${qs}`, undefined, port, 10_000);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_get_model": {
        const result = await bridgeCall("GET", "/model/current", undefined, a.port as number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_set_model": {
        const result = await bridgeCall("POST", "/model/set", { model: a.model as string }, a.port as number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_open_model_picker": {
        const result = await bridgeCall("POST", "/model/picker", undefined, a.port as number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_open_file": {
        const result = await bridgeCall("POST", "/editor/open", { path: a.path, line: a.line }, a.port as number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_editor_state": {
        const result = await bridgeCall("GET", "/editor/state", undefined, a.port as number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_diagnostics": {
        const result = await bridgeCall("GET", "/diagnostics", undefined, a.port as number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_run_command": {
        const result = await bridgeCall("POST", "/command", { command: a.command, args: a.args }, a.port as number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_deploy_extension": {
        const { exec: execCb } = await import("child_process");
        const { promisify: promisifyFn } = await import("util");
        const execDeployAsync = promisifyFn(execCb);
        const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "deploy.sh");
        const { stdout, stderr } = await execDeployAsync(`bash "${scriptPath}"`, { timeout: 120_000 });
        return { content: [{ type: "text", text: stdout || stderr }] };
      }
```

- [ ] **Step 4: Add the two new imports required by `cursor_deploy_extension`**

At the top of `src/index.ts`, add (next to the existing `path` import):

```ts
import { fileURLToPath } from "url";
```

(`dirname` is already imported from `path` in the existing file.)

- [ ] **Step 5: Build**

Run: `cd .. && npm run build` (from `extension/`, or `npm run build` from the repo root, targeting `src/index.ts`)
Expected: compiles with no TypeScript errors. Fix any type mismatches surfaced (e.g. `a.port` casts) before proceeding.

- [ ] **Step 6: Manual verification**

With the rebuilt extension installed (Task 7) and Cursor running, from a Node REPL or a small script, call the built `dist/index.js` tools manually is impractical (MCP stdio protocol) — instead verify via Claude Code directly: register the updated `vscode-mcp` in `~/.cursor/mcp.json` or Claude Code's MCP config, restart Claude Code, and call `cursor_list_workspaces` — expect it to return the workspace(s) with their live ports, matching what Task 2 confirmed in the registry file.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: consolidate cursor-bridge tools from nexus-mcp into vscode-mcp client"
```

---

## Task 6: Cross-platform `deploy.sh`

**Files:**
- Modify: `scripts/deploy.sh`

- [ ] **Step 1: Replace the Windows-only `$USERPROFILE` reference**

Replace this block in `scripts/deploy.sh`:

```bash
# 3. remove old versions + install new one
echo "[3/4] Cleaning old versions and installing $VERSION..."
EXTENSIONS_DIR="$USERPROFILE/.cursor/extensions"
```

with:

```bash
# 3. remove old versions + install new one
echo "[3/4] Cleaning old versions and installing $VERSION..."
if [ -n "$USERPROFILE" ]; then
  EXTENSIONS_DIR="$USERPROFILE/.cursor/extensions"
else
  EXTENSIONS_DIR="$HOME/.cursor/extensions"
fi
```

- [ ] **Step 2: Verify the rest of the script has no other OS-specific assumptions**

Read through the rest of `deploy.sh` (the `curl`, `cursor --install-extension`, and `sleep` calls) — these are already POSIX-shell/cross-platform as written (assuming `bash` and `cursor` CLI are on `PATH`, true for both Mac and Windows-with-Git-Bash setups). No further changes needed.

- [ ] **Step 3: Manual verification**

Run: `bash scripts/deploy.sh` on this Mac.
Expected: builds both the MCP and the extension, packages the `.vsix`, installs it via `cursor --install-extension`, reloads the window, and prints a final `Bridge status: {...}` line with `"active": true` and a non-9421 port.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy.sh
git commit -m "fix(deploy): support macOS/Linux by falling back to \$HOME"
```

---

## Task 7: Update `vscode-mcp/README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the README to document the full picture**

Replace the current content with a version that documents (a) the filesystem tools (unchanged, keep the existing table), (b) the full Cursor-control tool set from Task 5's tool list, (c) the `cursor-mcp-bridge` extension, its dynamic-port + registry mechanism, and the macOS Accessibility permission prompt from `nut-js`, (d) the known limitation that the internal Cursor command IDs (`glass.*`, `composer.newAgentChat`, etc.) are undocumented and may break on Cursor updates, and (e) the focus-stealing caveat on message send. Base the content on the tool tables already written in this plan (Task 5, Step 2) and the mechanism described in the spec's "Cómo funciona" section.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the consolidated client and cross-platform bridge"
```

---

## Task 8: Mark `nexus-mcp` and `klout-mcp` as archived

**Files:**
- Modify: `../nexus-mcp/README.md` (create if it doesn't exist — currently `nexus-mcp` has no README, per earlier audit)
- Modify: `../klout-mcp/README.md` (same)

- [ ] **Step 1: Add an archival notice to `nexus-mcp`**

Create `~/Desktop/Trabajo/KloutDevs/nexus-mcp/README.md` (this repo currently has none) with:

```markdown
# nexus-mcp (archived)

This project was absorbed into [vscode-mcp](https://github.com/KloutDevs/vscode-mcp) on
2026-09-06. Its multi-window/multi-tab Cursor control tools now live in
`vscode-mcp/src/index.ts`, alongside filesystem tools and the `cursor-mcp-bridge` extension.

Do not install this MCP going forward — use `vscode-mcp` instead.
```

- [ ] **Step 2: Add the same notice to `klout-mcp`**

Create `~/Desktop/Trabajo/KloutDevs/klout-mcp/README.md` with the same content (adjusted: "This project was an earlier iteration of `nexus-mcp`, which was itself absorbed into `vscode-mcp`...").

- [ ] **Step 3: Commit both**

```bash
cd ~/Desktop/Trabajo/KloutDevs/nexus-mcp && git add README.md && git commit -m "docs: mark project as archived, absorbed into vscode-mcp"
cd ~/Desktop/Trabajo/KloutDevs/klout-mcp && git add README.md && git commit -m "docs: mark project as archived, absorbed into vscode-mcp"
```

Note: this plan does not push any commits (in this repo or `nexus-mcp`/`klout-mcp`) — pushing is a user decision, ask before running `git push` on any of the three repos.

---

## Self-Review Notes

- **Spec coverage:** all 6 items from the spec's "Alcance de este cambio" map to a task — (1) single client → Task 5, (2) archive nexus-mcp/klout-mcp → Task 8, (3) nut-js → Task 3, (4) dynamic port + registry → Tasks 1-2, (5) deploy.sh → Task 6, (6) `cursor_deploy_extension` path fix → Task 5 Step 3.
- **Type consistency:** `bridgeCall(method, path, body, port, timeoutMs)` signature is defined once in Task 5 Step 1 and used identically across every handler in Task 5 Step 3. `writeRegistryEntry`/`removeRegistryEntry` signatures match between Task 1 (definition) and Task 2 (usage).
- **No placeholders:** every step has literal code, no "add error handling" or "similar to Task N" shortcuts.
