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

const execAsync = promisify(exec);

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

function readRegistry(): Record<string, { workspace: string; pid: number; startedAt: number }> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const path = join(home, ".vscode-mcp-bridge", "registry.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
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
