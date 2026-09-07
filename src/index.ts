#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile, mkdir, rm, readdir, stat, rename } from "fs/promises";
import { existsSync, statSync, readFileSync } from "fs";
import { join, resolve, relative, dirname, basename, extname } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { request as httpRequest } from "http";
import { fileURLToPath } from "url";
import * as cdp from "./cdp.js";
import * as composerStore from "./composerStore.js";

const execAsync = promisify(exec);

const CURSOR_CDP_PORT = Number(process.env.CURSOR_CDP_PORT ?? 9222);

// ─── bridge helper ───────────────────────────────────────────────────────────

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

const server = new Server(
  { name: "vscode-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ─── helpers ────────────────────────────────────────────────────────────────

function resolveWorkspacePath(filePath: string, workspaceRoot?: string): string {
  if (filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)) return filePath;
  const base = workspaceRoot ?? process.cwd();
  return resolve(join(base, filePath));
}

async function readFileLines(
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<string> {
  if (startLine === undefined && endLine === undefined) {
    return readFile(filePath, "utf-8");
  }
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let lineNum = 1;
  for await (const line of rl) {
    if (startLine === undefined || lineNum >= startLine) {
      if (endLine === undefined || lineNum <= endLine) lines.push(line);
      else break;
    }
    lineNum++;
  }
  return lines.join("\n");
}

async function searchInFiles(
  dir: string,
  pattern: string,
  options: { glob?: string; ignoreCase?: boolean; maxResults?: number }
): Promise<Array<{ file: string; line: number; content: string }>> {
  const results: Array<{ file: string; line: number; content: string }> = [];
  const max = options.maxResults ?? 100;
  const regex = new RegExp(pattern, options.ignoreCase ? "i" : "");

  async function walk(current: string) {
    if (results.length >= max) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= max) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (options.glob && !matchGlob(entry.name, options.glob)) continue;
        try {
          const content = await readFile(full, "utf-8");
          const lines = content.split("\n");
          lines.forEach((line, idx) => {
            if (results.length < max && regex.test(line)) {
              results.push({ file: full, line: idx + 1, content: line.trim() });
            }
          });
        } catch {
          // skip binary files
        }
      }
    }
  }

  await walk(dir);
  return results;
}

function matchGlob(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

async function findFiles(
  dir: string,
  pattern: string,
  maxResults = 200
): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string) {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (matchGlob(entry.name, pattern)) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

// ─── tool definitions ────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. Optionally specify a line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to workspace root)" },
        start_line: { type: "number", description: "First line to read (1-indexed, inclusive)" },
        end_line: { type: "number", description: "Last line to read (1-indexed, inclusive)" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write or overwrite a file with new content. Creates parent directories automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Content to write" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact string in a file. The old_string must appear exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        old_string: { type: "string", description: "Exact text to find and replace" },
        new_string: { type: "string", description: "Text to replace it with" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a given path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
        recursive: { type: "boolean", description: "Whether to list recursively (default false)" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "create_directory",
    description: "Create a directory (and all parent directories).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to create" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_path",
    description: "Delete a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path to delete" },
        recursive: { type: "boolean", description: "Required true to delete non-empty directories" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "move_path",
    description: "Move or rename a file or directory.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "search_files",
    description: "Search for a regex pattern inside files. Returns matching lines with file and line number.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to search in" },
        pattern: { type: "string", description: "Regex pattern to search for" },
        file_glob: { type: "string", description: "Glob to filter files (e.g. '*.ts')" },
        ignore_case: { type: "boolean", description: "Case-insensitive search" },
        max_results: { type: "number", description: "Max results to return (default 100)" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["directory", "pattern"],
    },
  },
  {
    name: "find_files",
    description: "Find files by name glob pattern (e.g. '*.ts', 'index.*').",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Directory to search in" },
        pattern: { type: "string", description: "Glob pattern for filename (e.g. '*.ts')" },
        max_results: { type: "number", description: "Max results to return (default 200)" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["directory", "pattern"],
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command in the given working directory. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
        cwd: { type: "string", description: "Working directory (defaults to workspace root or cwd)" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 30000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "get_workspace_info",
    description: "Get information about the current workspace: root directory, platform, Node version, git status summary.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
    },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file or directory (size, modification time, type).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path" },
        workspace_root: { type: "string", description: "Workspace root directory (optional)" },
      },
      required: ["path"],
    },
  },

  // ── Cursor bridge tools (require the cursor-mcp-bridge extension running) ──
  {
    name: "cursor_list_workspaces",
    description: "Discover all open Cursor windows via the CDP debug port (/json/list). Returns each window's title and CDP page ID. Use when multiple Cursor projects are open simultaneously. Requires Cursor launched with --remote-debugging-port (see CURSOR_CDP_PORT).",
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
    description: "Send a message via CDP trusted input to a Cursor window/tab and block until the agent's response is marked \"completed\" in state.vscdb (no HTTP polling, no fs.watch). On first call pass page_id from cursor_list_workspaces; after that pass composer_id for targeted, session-isolated delivery to a specific agent tab.",
    inputSchema: {
      type: "object",
      properties: {
        page_id:     { type: "string", description: "CDP page ID from cursor_list_workspaces — identifies the target Cursor window" },
        message:     { type: "string", description: "Message to send" },
        composer_id: { type: "string", description: "Composer ID from a previous cursor_send/cursor_send_and_wait call — targets a specific agent tab" },
        timeout_ms:  { type: "number", description: "Safety-valve timeout in ms (default 300000)" },
      },
      required: ["page_id", "message"],
    },
  },
  {
    name: "cursor_send",
    description: "Send a message via CDP trusted input to a Cursor window/tab and return as soon as it's delivered (no waiting for Cursor's reply). On first call pass page_id from cursor_list_workspaces; after that pass composer_id for targeted, session-isolated delivery to a specific agent tab.",
    inputSchema: {
      type: "object",
      properties: {
        page_id:     { type: "string", description: "CDP page ID from cursor_list_workspaces — identifies the target Cursor window" },
        message:     { type: "string", description: "Message to send" },
        composer_id: { type: "string", description: "Composer ID returned by a previous cursor_send call — use this for all messages after the first, to target a specific agent tab" },
      },
      required: ["page_id", "message"],
    },
  },
  {
    name: "cursor_read_chat",
    description: "Read the conversation history of a Cursor agent session directly from state.vscdb (no HTTP call to the extension). Pass composer_id for direct, unambiguous access to a specific tab.",
    inputSchema: {
      type: "object",
      properties: {
        composer_id: { type: "string", description: "Composer ID from cursor_send response" },
      },
      required: ["composer_id"],
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
];

// ─── tool handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "read_file": {
        const filePath = resolveWorkspacePath(a.path as string, a.workspace_root as string | undefined);
        const content = await readFileLines(
          filePath,
          a.start_line as number | undefined,
          a.end_line as number | undefined
        );
        return { content: [{ type: "text", text: content }] };
      }

      case "write_file": {
        const filePath = resolveWorkspacePath(a.path as string, a.workspace_root as string | undefined);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, a.content as string, "utf-8");
        return { content: [{ type: "text", text: `Written: ${filePath}` }] };
      }

      case "edit_file": {
        const filePath = resolveWorkspacePath(a.path as string, a.workspace_root as string | undefined);
        const original = await readFile(filePath, "utf-8");
        const oldStr = a.old_string as string;
        const idx = original.indexOf(oldStr);
        if (idx === -1) throw new Error("old_string not found in file");
        const lastIdx = original.lastIndexOf(oldStr);
        if (idx !== lastIdx) throw new Error("old_string appears more than once — be more specific");
        const updated = original.slice(0, idx) + (a.new_string as string) + original.slice(idx + oldStr.length);
        await writeFile(filePath, updated, "utf-8");
        return { content: [{ type: "text", text: `Edited: ${filePath}` }] };
      }

      case "list_directory": {
        const dirPath = resolveWorkspacePath(a.path as string, a.workspace_root as string | undefined);
        const recursive = (a.recursive as boolean | undefined) ?? false;

        async function listDir(dir: string, prefix = ""): Promise<string[]> {
          const entries = await readdir(dir, { withFileTypes: true });
          const lines: string[] = [];
          for (const e of entries) {
            const marker = e.isDirectory() ? "/" : "";
            lines.push(`${prefix}${e.name}${marker}`);
            if (recursive && e.isDirectory()) {
              lines.push(...await listDir(join(dir, e.name), `${prefix}${e.name}/`));
            }
          }
          return lines;
        }

        const lines = await listDir(dirPath);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "create_directory": {
        const dirPath = resolveWorkspacePath(a.path as string, a.workspace_root as string | undefined);
        await mkdir(dirPath, { recursive: true });
        return { content: [{ type: "text", text: `Created: ${dirPath}` }] };
      }

      case "delete_path": {
        const delPath = resolveWorkspacePath(a.path as string, a.workspace_root as string | undefined);
        await rm(delPath, { recursive: (a.recursive as boolean | undefined) ?? false });
        return { content: [{ type: "text", text: `Deleted: ${delPath}` }] };
      }

      case "move_path": {
        const src = resolveWorkspacePath(a.source as string, a.workspace_root as string | undefined);
        const dst = resolveWorkspacePath(a.destination as string, a.workspace_root as string | undefined);
        await mkdir(dirname(dst), { recursive: true });
        await rename(src, dst);
        return { content: [{ type: "text", text: `Moved: ${src} → ${dst}` }] };
      }

      case "search_files": {
        const dir = resolveWorkspacePath(a.directory as string, a.workspace_root as string | undefined);
        const results = await searchInFiles(dir, a.pattern as string, {
          glob: a.file_glob as string | undefined,
          ignoreCase: (a.ignore_case as boolean | undefined) ?? false,
          maxResults: (a.max_results as number | undefined) ?? 100,
        });
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No matches found." }] };
        }
        const text = results
          .map((r) => `${r.file}:${r.line}: ${r.content}`)
          .join("\n");
        return { content: [{ type: "text", text: text }] };
      }

      case "find_files": {
        const dir = resolveWorkspacePath(a.directory as string, a.workspace_root as string | undefined);
        const files = await findFiles(dir, a.pattern as string, (a.max_results as number | undefined) ?? 200);
        if (files.length === 0) {
          return { content: [{ type: "text", text: "No files found." }] };
        }
        return { content: [{ type: "text", text: files.join("\n") }] };
      }

      case "run_command": {
        const cwd = (a.cwd as string | undefined) ?? process.cwd();
        const timeout = (a.timeout_ms as number | undefined) ?? 30000;
        try {
          const { stdout, stderr } = await execAsync(a.command as string, { cwd, timeout });
          const out = [
            stdout && `STDOUT:\n${stdout}`,
            stderr && `STDERR:\n${stderr}`,
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text", text: out || "(no output)" }] };
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const out = [
            e.stdout && `STDOUT:\n${e.stdout}`,
            e.stderr && `STDERR:\n${e.stderr}`,
            `ERROR: ${e.message}`,
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text", text: out }], isError: true };
        }
      }

      case "get_workspace_info": {
        const root = (a.workspace_root as string | undefined) ?? process.cwd();
        let gitBranch = "N/A";
        let gitStatus = "N/A";
        try {
          const { stdout: branch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: root });
          gitBranch = branch.trim();
          const { stdout: status } = await execAsync("git status --short", { cwd: root });
          gitStatus = status.trim() || "clean";
        } catch {
          // not a git repo
        }
        const info = {
          workspace_root: root,
          platform: process.platform,
          node_version: process.version,
          git_branch: gitBranch,
          git_status: gitStatus,
        };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "get_file_info": {
        const filePath = resolveWorkspacePath(a.path as string, a.workspace_root as string | undefined);
        if (!existsSync(filePath)) throw new Error(`Path does not exist: ${filePath}`);
        const s = statSync(filePath);
        const info = {
          path: filePath,
          type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
          size_bytes: s.size,
          modified: s.mtime.toISOString(),
          created: s.birthtime.toISOString(),
          extension: s.isFile() ? extname(basename(filePath)) : null,
        };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      // ── Cursor bridge tools ───────────────────────────────────────────────

      case "cursor_list_workspaces": {
        const pages = await cdp.listPages(CURSOR_CDP_PORT);
        const results = pages.map((p) => ({ page_id: p.pageId, title: p.title }));
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
        const pageId = a.page_id as string;
        const message = a.message as string;
        const timeoutMs = (a.timeout_ms as number | undefined) ?? 300_000;
        let composerId = a.composer_id as string | undefined;
        const startedAt = Date.now();

        try {
          let sinceCount = 0;
          if (composerId) {
            const before = composerStore.readComposerData(composerId);
            sinceCount = before?.fullConversationHeadersOnly.length ?? 0;
            await cdp.sendMessage(CURSOR_CDP_PORT, pageId, message);
          } else {
            const baseline = composerStore.findNewestComposerId();
            await cdp.sendMessage(CURSOR_CDP_PORT, pageId, message);
            composerId = await composerStore.waitForNewComposerId(baseline, timeoutMs);
            sinceCount = 0;
          }

          const text = await composerStore.waitForReply(composerId, sinceCount, timeoutMs);
          return {
            content: [{
              type: "text",
              text: `**Cursor** (${Date.now() - startedAt}ms, composer_id: ${composerId}):\n\n${text}`,
            }],
          };
        } catch (err: unknown) {
          const message2 = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message2}` }], isError: true };
        }
      }

      case "cursor_send": {
        const pageId = a.page_id as string;
        const message = a.message as string;
        let composerId = a.composer_id as string | undefined;

        try {
          if (composerId) {
            await cdp.sendMessage(CURSOR_CDP_PORT, pageId, message);
          } else {
            const baseline = composerStore.findNewestComposerId();
            await cdp.sendMessage(CURSOR_CDP_PORT, pageId, message);
            composerId = await composerStore.waitForNewComposerId(baseline, 30_000);
          }
          return { content: [{ type: "text", text: JSON.stringify({ confirmed: true, composer_id: composerId, page_id: pageId }) }] };
        } catch (err: unknown) {
          const message2 = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message2}` }], isError: true };
        }
      }

      case "cursor_read_chat": {
        const composerId = a.composer_id as string;
        const data = composerStore.readComposerData(composerId);
        if (!data) {
          return { content: [{ type: "text", text: `Error: no conversation found for composer ${composerId}` }], isError: true };
        }
        const messages = data.fullConversationHeadersOnly
          .map((h) => {
            const bubble = composerStore.readBubble(composerId, h.bubbleId);
            return bubble ? { type: bubble.type, text: bubble.text } : null;
          })
          .filter((m): m is { type: number; text: string } => m !== null && m.text.length > 0);
        return { content: [{ type: "text", text: JSON.stringify({ composerId, status: data.status, count: messages.length, messages }, null, 2) }] };
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// ─── start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("vscode-mcp server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
