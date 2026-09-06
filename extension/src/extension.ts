import * as vscode from "vscode";
import * as http from "http";
import { exec } from "child_process";
import * as fs from "fs";
import * as nodePath from "path";
import { writeRegistryEntry, removeRegistryEntry } from "./registry.js";

let actualPort = 0;

// ─── response state tracking ─────────────────────────────────────────────────
// We have no direct API to know when Cursor finishes generating a response.
// Heuristic: "responding" = within MIN_WAIT_MS of sending OR file activity
// within INACTIVITY_MS. After both windows close, we consider it done.
const MIN_WAIT_MS = 12000;      // always wait at least 12s after send
const INACTIVITY_MS = 6000;     // 6s of no file edits = probably done

let lastSendTime = 0;
let lastActivityTime = 0;

// Known Cursor / VS Code command IDs to try, ordered by likelihood
const CHAT_OPEN_COMMANDS = [
  "aichat.newchataction",
  "workbench.action.chat.open",
  "workbench.panel.chat.view.copilot.focus",
];

const COMPOSER_OPEN_COMMANDS = [
  "composer.newAgentChat",
  "workbench.panel.chat.view.edits.focus",
  "workbench.action.chat.open",
];

const AGENT_OPEN_COMMANDS = [
  "composer.newAgentChat",
  "aichat.newchataction",
];

let server: http.Server | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

// ─── activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Cursor MCP Bridge");
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "cursorMcpBridge.showStatus";

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorMcpBridge.showStatus", showStatus),
    vscode.commands.registerCommand("cursorMcpBridge.restart", () => {
      stopServer();
      startServer(context);
    }),
    // Track file edits as a proxy for "Cursor is still working"
    vscode.workspace.onDidChangeTextDocument(() => {
      lastActivityTime = Date.now();
    }),
    statusBarItem,
    outputChannel
  );

  startServer(context);
}

export function deactivate() {
  stopServer();

}

// ─── transcript helpers ───────────────────────────────────────────────────────

function getWorkspaceName(): string {
  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  return wsPath ? nodePath.basename(wsPath) : "";
}

function getTranscriptsDir(): string | null {
  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsPath) return null;
  const slug = wsPath.replace(/[:\\/]+/g, "-").replace(/^-/, "").replace(/-+/g, "-");
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return nodePath.join(userHome, ".cursor", "projects", slug, "agent-transcripts");
}

/** Direct path to a specific composer's JSONL — bypasses time-based scanning entirely. */
function composerJsonlPath(composerId: string): string | null {
  const dir = getTranscriptsDir();
  if (!dir) return null;
  const p = nodePath.join(dir, composerId, `${composerId}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

/** Count user messages. If composerId given, reads that file directly (no scanning). */
function countUserMessages(sinceMs = 0, composerId?: string): { count: number; composerId: string | null } {
  // Fast path: known composerId
  if (composerId) {
    const jsonl = composerJsonlPath(composerId);
    if (!jsonl) return { count: 0, composerId };
    const lines = fs.readFileSync(jsonl, "utf-8").split("\n").filter((l) => l.trim());
    const count = lines.reduce((n, l) => { try { return JSON.parse(l).role === "user" ? n + 1 : n; } catch { return n; } }, 0);
    return { count, composerId };
  }

  // Slow path: scan by time (first send of a new session)
  const dir = getTranscriptsDir();
  if (!dir || !fs.existsSync(dir)) return { count: 0, composerId: null };
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const jsonl = nodePath.join(dir, d.name, `${d.name}.jsonl`);
      const mtime = fs.existsSync(jsonl) ? fs.statSync(jsonl).mtimeMs : 0;
      return { id: d.name, jsonl, mtime };
    })
    .filter((e) => e.mtime > sinceMs)
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) return { count: -1, composerId: null };
  const { id, jsonl } = entries[0];
  const lines = fs.readFileSync(jsonl, "utf-8").split("\n").filter((l) => l.trim());
  const count = lines.reduce((n, l) => { try { return JSON.parse(l).role === "user" ? n + 1 : n; } catch { return n; } }, 0);
  return { count, composerId: id };
}

function sendEnterKey(): Promise<void> {
  return new Promise((resolve) => {
    // Use workspace-specific window title so we target the right Cursor instance
    const wsName = getWorkspaceName();
    const windowTitle = wsName ? `${wsName} - Cursor` : "Cursor";
    exec(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "$wsh = New-Object -ComObject WScript.Shell; $wsh.AppActivate('${windowTitle}'); Start-Sleep -Milliseconds 200; $wsh.SendKeys('{ENTER}')"`,
      () => resolve()
    );
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

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

function stopServer() {
  if (actualPort) removeRegistryEntry(actualPort);
  server?.close();
  server = null;
}

// ─── request router ───────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method?.toUpperCase() ?? "GET";
  const path = url.pathname;

  log(`${method} ${path}`);

  let parsed: unknown = {};
  if (rawBody) {
    try { parsed = JSON.parse(rawBody); } catch { /* ignore */ }
  }
  const body = parsed as Record<string, unknown>;

  const route = `${method} ${path}`;

  // ── GET /status ─────────────────────────────────────────────────────────────
  if (route === "GET /status") {
    return json(res, 200, {
      active: true,
      version: "2.0.0",
      port: actualPort,
      workspace: getWorkspaceName(),
      workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
    });
  }

  // ── GET /commands ────────────────────────────────────────────────────────────
  if (route === "GET /commands") {
    const filter = url.searchParams.get("filter") ?? "";
    const all = await vscode.commands.getCommands(true);
    const filtered = filter
      ? all.filter((c) => c.toLowerCase().includes(filter.toLowerCase()))
      : all.filter((c) =>
          c.startsWith("cursor") ||
          c.startsWith("composer") ||
          c.startsWith("aichat") ||
          c.includes("chat") ||
          c.includes("agent") ||
          c.includes("model")
        );
    filtered.sort();
    return json(res, 200, { count: filtered.length, commands: filtered });
  }

  // ── POST /chat/open ──────────────────────────────────────────────────────────
  if (route === "POST /chat/open") {
    const mode = (body.mode as string | undefined) ?? "chat";
    const message = body.message as string | undefined;

    const commandLists: Record<string, string[]> = {
      chat: CHAT_OPEN_COMMANDS,
      composer: COMPOSER_OPEN_COMMANDS,
      agent: AGENT_OPEN_COMMANDS,
    };

    const commands = commandLists[mode] ?? CHAT_OPEN_COMMANDS;
    const result = await tryCommands(commands, message ? { query: message } : undefined);
    return json(res, result.ok ? 200 : 500, result);
  }

  // ── GET /chat/read ───────────────────────────────────────────────────────────
  if (route === "GET /chat/read") {
    const sinceMs       = Number(url.searchParams.get("since") ?? "0");
    const composerParam = url.searchParams.get("composer_id") ?? undefined;
    const transcriptsDir = getTranscriptsDir();

    if (!transcriptsDir || !fs.existsSync(transcriptsDir)) {
      return json(res, 404, { error: `No transcripts dir found` });
    }

    let composerId: string;
    let jsonlPath: string;

    if (composerParam) {
      // Fast path: direct read by composerId — no scanning, no ambiguity
      const direct = nodePath.join(transcriptsDir, composerParam, `${composerParam}.jsonl`);
      if (!fs.existsSync(direct)) {
        return json(res, 404, { error: `Transcript not found for composer ${composerParam}`, responding: true });
      }
      composerId = composerParam;
      jsonlPath  = direct;
    } else {
      // Slow path: scan by mtime
      const entries = fs.readdirSync(transcriptsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const jsonl = nodePath.join(transcriptsDir, d.name, `${d.name}.jsonl`);
          const mtime = fs.existsSync(jsonl) ? fs.statSync(jsonl).mtimeMs : 0;
          return { id: d.name, jsonl, mtime };
        })
        .filter((e) => e.mtime > sinceMs)
        .sort((a, b) => b.mtime - a.mtime);
      if (entries.length === 0) {
        return json(res, 404, {
          error: sinceMs > 0 ? `No transcripts after ${new Date(sinceMs).toISOString()} yet` : "No transcripts found",
          responding: true,
        });
      }
      composerId = entries[0].id;
      jsonlPath  = entries[0].jsonl;
    }
    const messages = fs.readFileSync(jsonlPath, "utf-8")
      .split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((l: Record<string, unknown>) => l.role === "user" || l.role === "assistant")
      .map((l: Record<string, unknown>) => {
        const msg = l.message as { content?: Array<{ type: string; text?: string }> };
        const text = (msg?.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "").join("")
          .replace(/<timestamp>[^<]*<\/timestamp>\s*/g, "")
          .replace(/<\/?user_query>\s*/g, "").trim();
        return { role: l.role as string, text };
      })
      .filter((m) => m.text);

    return json(res, 200, { composerId, count: messages.length, messages });
  }

  // ── POST /chat/send_and_wait ─────────────────────────────────────────────────
  // Sends a message with confirmation, then holds the HTTP connection open via
  // fs.watch until Cursor writes a new assistant entry to the JSONL transcript.
  if (route === "POST /chat/send_and_wait") {
    const message = body.message as string | undefined;
    if (!message) return json(res, 400, { error: "message is required" });

    const sinceMs  = (body.since_ms  as number | undefined) ?? 0;
    const timeoutMs = (body.timeout_ms as number | undefined) ?? 300_000; // 5 min

    // ── Step 1: confirmed send ────────────────────────────────────────────────
    const before = countUserMessages(sinceMs);
    const userCountBefore = Math.max(0, before.count);

    // snapshot assistant count before sending
    const transcriptsDir = getTranscriptsDir();
    const assistantCountBefore = (() => {
      if (!transcriptsDir || !fs.existsSync(transcriptsDir)) return 0;
      const entries = fs.readdirSync(transcriptsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const jsonl = nodePath.join(transcriptsDir, d.name, `${d.name}.jsonl`);
          return fs.existsSync(jsonl) ? fs.statSync(jsonl).mtimeMs : 0;
        }).filter(m => m > sinceMs);
      if (entries.length === 0) return 0;
      // count assistant lines across all relevant transcripts
      const entries2 = fs.readdirSync(transcriptsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => { const j = nodePath.join(transcriptsDir, d.name, `${d.name}.jsonl`); return { id: d.name, jsonl: j, mtime: fs.existsSync(j) ? fs.statSync(j).mtimeMs : 0 }; })
        .filter(e => e.mtime > sinceMs).sort((a,b) => b.mtime - a.mtime);
      if (entries2.length === 0) return 0;
      return fs.readFileSync(entries2[0].jsonl, "utf-8").split("\n").filter(l=>l.trim()).reduce((n,l) => { try { return JSON.parse(l).role==="assistant"?n+1:n; } catch { return n; } }, 0);
    })();

    await vscode.env.clipboard.writeText(message);
    await vscode.commands.executeCommand("glass.focusInput");
    await new Promise(r => setTimeout(r, 350));
    await vscode.commands.executeCommand("glass.osEditSelectAll");
    await vscode.commands.executeCommand("glass.osEditPaste");
    await new Promise(r => setTimeout(r, 250));

    let attempt = 0;
    let sendConfirmed = false;
    for (let a = 1; a <= 3 && !sendConfirmed; a++) {
      attempt = a;
      await sendEnterKey();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !sendConfirmed) {
        await new Promise(r => setTimeout(r, 1500));
        if (countUserMessages(sinceMs).count > userCountBefore) sendConfirmed = true;
      }
      if (!sendConfirmed && a < 3) {
        await vscode.env.clipboard.writeText(message);
        await vscode.commands.executeCommand("glass.focusInput");
        await new Promise(r => setTimeout(r, 300));
        await vscode.commands.executeCommand("glass.osEditSelectAll");
        await vscode.commands.executeCommand("glass.osEditPaste");
        await new Promise(r => setTimeout(r, 250));
      }
    }

    if (!sendConfirmed) {
      return json(res, 500, { ok: false, error: "Send not confirmed after 3 attempts" });
    }

    lastSendTime = Date.now();
    lastActivityTime = Date.now();
    log(`Message sent (attempt ${attempt}), watching for Cursor response...`);

    // ── Step 2: fs.watch for assistant reply ──────────────────────────────────
    const watchDir = transcriptsDir ?? nodePath.join(
      process.env.USERPROFILE ?? "", ".cursor", "projects"
    );

    // Returns the response ONLY when the last assistant message is a final
    // pure-text reply (no tool_use blocks). Messages with tool_use are
    // intermediate steps — Cursor is still working.
    const parseLastAssistant = (): { text: string; composerId: string } | null => {
      if (!transcriptsDir || !fs.existsSync(transcriptsDir)) return null;
      const entries = fs.readdirSync(transcriptsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => { const j = nodePath.join(transcriptsDir, d.name, `${d.name}.jsonl`); return { id: d.name, jsonl: j, mtime: fs.existsSync(j) ? fs.statSync(j).mtimeMs : 0 }; })
        .filter(e => e.mtime > sinceMs).sort((a,b) => b.mtime - a.mtime);
      if (entries.length === 0) return null;
      const { id, jsonl } = entries[0];
      const lines = fs.readFileSync(jsonl, "utf-8").split("\n").filter(l=>l.trim());
      const assistants = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).filter((l: Record<string,unknown>) => l.role === "assistant");
      if (assistants.length <= assistantCountBefore) return null;
      const last = assistants[assistants.length - 1] as Record<string,unknown>;
      const msg = last.message as { content?: Array<{ type: string; text?: string }> };
      const content = msg?.content ?? [];
      // Only resolve when message has NO tool_use — that signals completion
      const hasToolUse = content.some(c => c.type === "tool_use");
      if (hasToolUse) return null;
      const text = content.filter(c => c.type === "text")
        .map(c => c.text ?? "").join("")
        .replace(/<timestamp>[^<]*<\/timestamp>\s*/g, "")
        .replace(/<\/?user_query>\s*/g, "").trim();
      return text ? { text, composerId: id } : null;
    };

    // Check immediately (might already be written)
    const immediate = parseLastAssistant();
    if (immediate) {
      return json(res, 200, { ok: true, confirmed: true, attempt, ...immediate, waited_ms: 0 });
    }

    // Hold the HTTP connection — resolve via watcher or timeout
    return new Promise<void>(resolve => {
      let settled = false;
      const startedAt = Date.now();

      const settle = (data: unknown, status: number) => {
        if (settled) return;
        settled = true;
        watcher?.close();
        clearTimeout(timer);
        const payload = Buffer.from(JSON.stringify(data, null, 2), "utf8");
        if (!res.headersSent) {
          res.writeHead(status, { "Content-Length": payload.length });
          res.end(payload);
        }
        resolve();
      };

      let watcher: ReturnType<typeof fs.watch> | null = null;
      try {
        if (fs.existsSync(watchDir)) {
          watcher = fs.watch(watchDir, { recursive: true }, (_event, filename) => {
            if (!filename?.endsWith(".jsonl")) return;
            // Fire on every JSONL write. parseLastAssistant returns non-null
            // ONLY when the last assistant message has no tool_use blocks,
            // meaning Cursor has finished — no timeouts needed.
            const result = parseLastAssistant();
            if (result) settle({ ok: true, confirmed: true, attempt, ...result, waited_ms: Date.now() - startedAt }, 200);
          });
        }
      } catch (err) {
        log(`fs.watch failed: ${err} — falling back to timeout`);
      }

      const timer = setTimeout(() => {
        // One last check before giving up
        const last = parseLastAssistant();
        if (last) settle({ ok: true, confirmed: true, attempt, ...last, waited_ms: Date.now() - startedAt }, 200);
        else settle({ ok: false, error: "timeout", waited_ms: timeoutMs }, 408);
      }, timeoutMs);
    });
  }

  // ── GET /chat/status ─────────────────────────────────────────────────────────
  if (route === "GET /chat/status") {
    const now = Date.now();
    const sinceLastSend = now - lastSendTime;
    const sinceActivity = lastActivityTime > lastSendTime
      ? now - lastActivityTime   // file edits happened after send
      : sinceLastSend;           // no file edits yet — use send time
    const responding =
      lastSendTime === 0
        ? false
        : sinceLastSend < MIN_WAIT_MS || sinceActivity < INACTIVITY_MS;
    return json(res, 200, {
      responding,
      ms_since_send: sinceLastSend,
      ms_since_activity: sinceActivity,
      min_wait_ms: MIN_WAIT_MS,
      inactivity_ms: INACTIVITY_MS,
    });
  }

  // ── POST /chat/send ──────────────────────────────────────────────────────────
  if (route === "POST /chat/send") {
    const message = body.message as string | undefined;
    if (!message) return json(res, 400, { error: "message is required" });

    // If caller already knows the composerId, use it directly (no scanning)
    const sinceMs    = (body.since_ms    as number | undefined) ?? 0;
    const composerId = body.composer_id  as string | undefined;
    const before = countUserMessages(sinceMs, composerId);
    const userCountBefore = Math.max(0, before.count);

    // Write message to clipboard
    await vscode.env.clipboard.writeText(message);

    // Paste into existing chat input (no new chat opened)
    await vscode.commands.executeCommand("glass.focusInput");
    await new Promise((r) => setTimeout(r, 350));
    await vscode.commands.executeCommand("glass.osEditSelectAll");
    await vscode.commands.executeCommand("glass.osEditPaste");
    await new Promise((r) => setTimeout(r, 250));

    // Press Enter ONCE and wait for real transcript confirmation.
    // Only retry if after a long wait there is still no new user message
    // (meaning the Enter genuinely failed, not just was slow).
    // This prevents double-sends caused by premature retries.
    const MAX_ATTEMPTS = 3;
    const CONFIRM_TIMEOUT_MS = 60_000; // 60s — generous enough for slow transcript writes

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await sendEnterKey();
      log(`Send attempt ${attempt}: waiting for transcript confirmation (up to ${CONFIRM_TIMEOUT_MS / 1000}s)...`);

      const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const after = countUserMessages(sinceMs, composerId ?? undefined);
        if (after.count > userCountBefore) {
          lastSendTime = Date.now();
          lastActivityTime = Date.now();
          log(`Send confirmed on attempt ${attempt} (user msgs: ${userCountBefore} → ${after.count})`);
          return json(res, 200, {
            ok: true, message, attempt,
            confirmed: true,
            composerId: after.composerId,
            workspace: getWorkspaceName(),
          });
        }
      }
      // Only reach here if Enter truly had no effect after 60s
      if (attempt < MAX_ATTEMPTS) {
        log(`Attempt ${attempt} unconfirmed, retrying...`);
        // Re-paste before retrying Enter (input might have been cleared)
        await vscode.env.clipboard.writeText(message);
        await vscode.commands.executeCommand("glass.focusInput");
        await new Promise((r) => setTimeout(r, 300));
        await vscode.commands.executeCommand("glass.osEditSelectAll");
        await vscode.commands.executeCommand("glass.osEditPaste");
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    return json(res, 500, { ok: false, message, confirmed: false, error: "Send not confirmed after 3 attempts" });
  }

  // ── GET /model/current ───────────────────────────────────────────────────────
  if (route === "GET /model/current") {
    const config = vscode.workspace.getConfiguration();
    // Scan all settings for anything that looks like a model slug
    const allKeys = [
      "cursor.chat.defaultModel", "cursor.chat.model", "cursor.defaultModel",
      "cursorai.defaultModel", "cursorai.chat.model", "cursorai.modelSlug",
      "glass.modelSlug", "github.copilot.chat.defaultModel",
    ];
    const found: Record<string, unknown> = {};
    for (const key of allKeys) {
      const val = config.get(key);
      if (val !== undefined && val !== null && val !== "") found[key] = val;
    }
    return json(res, 200, { settings: found, hint: "Use POST /model/picker to open the model selector UI" });
  }

  // ── POST /model/set ──────────────────────────────────────────────────────────
  if (route === "POST /model/set") {
    const model = body.model as string | undefined;
    if (!model) return json(res, 400, { error: "model is required" });

    // Try Cursor's native model switch commands
    const switchCmds = [
      "cursorai.action.switchToModelSlug",
      "cursorai.action.switchToModel",
      "glass.cursorai.action.switchToModelSlug",
    ];
    const result = await tryCommands(switchCmds, model);
    return json(res, result.ok ? 200 : 500, { model, ...result });
  }

  // ── POST /model/picker ────────────────────────────────────────────────────────
  if (route === "POST /model/picker") {
    const result = await tryCommands([
      "glass.openModelPicker",
      "composer.openModelToggle",
      "cmdk.togglePromptBarModel",
    ]);
    return json(res, result.ok ? 200 : 500, result);
  }

  // ── POST /command ─────────────────────────────────────────────────────────────
  if (route === "POST /command") {
    const command = body.command as string | undefined;
    if (!command) return json(res, 400, { error: "command is required" });
    const args = body.args as unknown[] | undefined;

    try {
      const result = await vscode.commands.executeCommand(command, ...(args ?? []));
      return json(res, 200, { ok: true, command, result: result ?? null });
    } catch (err) {
      return json(res, 500, { ok: false, command, error: String(err) });
    }
  }

  // ── POST /editor/open ─────────────────────────────────────────────────────────
  if (route === "POST /editor/open") {
    const filePath = body.path as string | undefined;
    const line = body.line as number | undefined;
    if (!filePath) return json(res, 400, { error: "path is required" });

    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    if (line !== undefined) {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }

    return json(res, 200, { ok: true, path: filePath, line });
  }

  // ── GET /editor/state ─────────────────────────────────────────────────────────
  if (route === "GET /editor/state") {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return json(res, 200, { activeEditor: null });

    const sel = editor.selection;
    const selectedText = editor.document.getText(sel);

    return json(res, 200, {
      activeEditor: {
        path: editor.document.uri.fsPath,
        language: editor.document.languageId,
        line: sel.active.line + 1,
        column: sel.active.character + 1,
        selectedText: selectedText || null,
        isDirty: editor.document.isDirty,
      },
      openEditors: vscode.window.visibleTextEditors.map((e) => ({
        path: e.document.uri.fsPath,
        language: e.document.languageId,
      })),
    });
  }

  // ── GET /diagnostics ──────────────────────────────────────────────────────────
  if (route === "GET /diagnostics") {
    const all = vscode.languages.getDiagnostics();
    const result = all
      .filter(([, diags]) => diags.length > 0)
      .map(([uri, diags]) => ({
        file: uri.fsPath,
        diagnostics: diags.map((d) => ({
          severity: ["Error", "Warning", "Information", "Hint"][d.severity],
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          message: d.message,
          source: d.source,
          code: d.code,
        })),
      }));
    return json(res, 200, { count: result.reduce((n, r) => n + r.diagnostics.length, 0), files: result });
  }

  return json(res, 404, { error: `Unknown route: ${method} ${path}` });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function tryCommands(
  commands: string[],
  args?: unknown
): Promise<{ ok: boolean; command?: string; tried: string[]; error?: string }> {
  const tried: string[] = [];
  for (const cmd of commands) {
    tried.push(cmd);
    try {
      await vscode.commands.executeCommand(cmd, ...(args ? [args] : []));
      return { ok: true, command: cmd, tried };
    } catch {
      // try next
    }
  }
  return { ok: false, tried, error: `None of the tried commands succeeded: ${commands.join(", ")}` };
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  const payload = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  res.writeHead(status, { "Content-Length": payload.length });
  res.end(payload);
}

function log(msg: string) {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function showStatus() {
  const port = actualPort;
  outputChannel.show();
  outputChannel.appendLine(`\nStatus: server running on http://127.0.0.1:${port}`);
  outputChannel.appendLine(`Available endpoints:`);
  outputChannel.appendLine(`  GET  /status`);
  outputChannel.appendLine(`  GET  /commands?filter=<text>`);
  outputChannel.appendLine(`  GET  /editor/state`);
  outputChannel.appendLine(`  GET  /diagnostics`);
  outputChannel.appendLine(`  GET  /model/current`);
  outputChannel.appendLine(`  POST /chat/open   { mode?: "chat"|"composer"|"agent", message? }`);
  outputChannel.appendLine(`  POST /chat/send   { message }`);
  outputChannel.appendLine(`  POST /model/set    { model }`);
  outputChannel.appendLine(`  POST /model/picker (opens the model selector UI)`);
  outputChannel.appendLine(`  POST /editor/open  { path, line? }`);
  outputChannel.appendLine(`  POST /command     { command, args? }`);
}
