import * as vscode from "vscode";
import * as http from "http";
import { exec } from "child_process";
import * as fs from "fs";
import * as nodePath from "path";

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

function getTranscriptsDir(): string | null {
  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsPath) return null;
  const slug = wsPath.replace(/[:\\/]+/g, "-").replace(/^-/, "").replace(/-+/g, "-");
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return nodePath.join(userHome, ".cursor", "projects", slug, "agent-transcripts");
}

/** Count user messages in all transcripts created after sinceMs. Returns -1 if no file. */
function countUserMessages(sinceMs = 0): { count: number; composerId: string | null } {
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
  const userCount = lines.reduce((n, l) => {
    try { return JSON.parse(l).role === "user" ? n + 1 : n; } catch { return n; }
  }, 0);
  return { count: userCount, composerId: id };
}

function sendEnterKey(): Promise<void> {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "$wsh = New-Object -ComObject WScript.Shell; $wsh.AppActivate('Cursor'); Start-Sleep -Milliseconds 200; $wsh.SendKeys('{ENTER}')"`,
      () => resolve()
    );
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function startServer(context: vscode.ExtensionContext) {
  const port = vscode.workspace.getConfiguration("cursorMcpBridge").get<number>("port", 9421);

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

  server.listen(port, "127.0.0.1", () => {
    log(`Bridge listening on http://127.0.0.1:${port}`);
    statusBarItem.text = `$(radio-tower) MCP :${port}`;
    statusBarItem.tooltip = `Cursor MCP Bridge active on port ${port}`;
    statusBarItem.show();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    const msg = err.code === "EADDRINUSE"
      ? `Port ${port} already in use. Change cursorMcpBridge.port in settings.`
      : `Server error: ${err.message}`;
    log(msg);
    vscode.window.showErrorMessage(`MCP Bridge: ${msg}`);
    statusBarItem.text = `$(error) MCP Bridge error`;
    statusBarItem.show();
  });
}

function stopServer() {
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
      version: "1.1.0",
      port: vscode.workspace.getConfiguration("cursorMcpBridge").get("port", 8765),
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
    const sinceMs = Number(url.searchParams.get("since") ?? "0");
    const transcriptsDir = getTranscriptsDir();

    if (!transcriptsDir || !fs.existsSync(transcriptsDir)) {
      return json(res, 404, { error: `No transcripts dir found` });
    }

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
        error: sinceMs > 0
          ? `No transcripts after ${new Date(sinceMs).toISOString()} yet`
          : "No transcripts found",
        responding: true,
      });
    }

    const { id: composerId, jsonl: jsonlPath } = entries[0];
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

    // Snapshot current user-message count BEFORE sending
    const sinceMs = (body.since_ms as number | undefined) ?? 0;
    const before = countUserMessages(sinceMs);
    const userCountBefore = Math.max(0, before.count);

    // Write message to clipboard
    await vscode.env.clipboard.writeText(message);

    // Paste into existing chat input (no new chat opened)
    await vscode.commands.executeCommand("glass.focusInput");
    await new Promise((r) => setTimeout(r, 350));
    await vscode.commands.executeCommand("glass.osEditSelectAll");
    await vscode.commands.executeCommand("glass.osEditPaste");
    await new Promise((r) => setTimeout(r, 250));

    // Try Enter up to 3 times, confirming via transcript
    const MAX_ATTEMPTS = 3;
    const CONFIRM_TIMEOUT_MS = 15000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await sendEnterKey();
      log(`Send attempt ${attempt}: waiting for transcript confirmation...`);

      const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
      let confirmed = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const after = countUserMessages(sinceMs);
        if (after.count > userCountBefore) {
          confirmed = true;
          lastSendTime = Date.now();
          lastActivityTime = Date.now();
          log(`Send confirmed on attempt ${attempt} (user msgs: ${userCountBefore} → ${after.count})`);
          return json(res, 200, {
            ok: true, message, attempt,
            confirmed: true,
            composerId: after.composerId,
          });
        }
      }
      if (!confirmed && attempt < MAX_ATTEMPTS) {
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
  const port = vscode.workspace.getConfiguration("cursorMcpBridge").get<number>("port", 9421);
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
