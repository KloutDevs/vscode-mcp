#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile, mkdir, rm, readdir, stat, rename } from "fs/promises";
import { existsSync, statSync } from "fs";
import { join, resolve, relative, dirname, basename, extname } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { request as httpRequest } from "http";

const execAsync = promisify(exec);

// ─── bridge helper ───────────────────────────────────────────────────────────

const BRIDGE_PORT = parseInt(process.env.MCP_BRIDGE_PORT ?? "9421", 10);

function bridgeCall(method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: BRIDGE_PORT,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
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
    name: "cursor_status",
    description: "Check if the Cursor MCP Bridge extension is running and get workspace info.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cursor_list_commands",
    description: "List Cursor/VS Code commands available in the IDE. Use filter to narrow results.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional keyword filter (e.g. 'chat', 'model', 'cursor')" },
      },
    },
  },
  {
    name: "cursor_open_chat",
    description: "Open a new chat, composer, or agent panel in Cursor.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["chat", "composer", "agent"],
          description: "Which panel to open (default: chat)",
        },
        message: { type: "string", description: "Optional initial message to send" },
      },
    },
  },
  {
    name: "cursor_send_message",
    description: "Open the Cursor chat and send a message (starts a new conversation).",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to send in the chat" },
      },
      required: ["message"],
    },
  },
  {
    name: "cursor_get_model",
    description: "Get the currently configured AI model in Cursor.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cursor_set_model",
    description: "Change the active AI model in Cursor (e.g. claude-sonnet-4-5, gpt-4o, gemini-pro).",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model identifier to set" },
      },
      required: ["model"],
    },
  },
  {
    name: "cursor_open_model_picker",
    description: "Open the model selector UI in Cursor so the user can pick a model visually.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cursor_send_and_wait",
    description: "Send a message to the current Cursor agent chat and wait (blocking) until Cursor finishes responding. Returns the full response text. Use since_ms from cursor_open_chat to scope to the current session.",
    inputSchema: {
      type: "object",
      properties: {
        message:    { type: "string", description: "Message to send" },
        since_ms:   { type: "number", description: "Unix ms timestamp — only look at transcripts created after this (use the value returned by cursor_open_chat)" },
        timeout_ms: { type: "number", description: "Max ms to wait for Cursor's response (default 300000 = 5 min)" },
      },
      required: ["message", "since_ms"],
    },
  },
  {
    name: "cursor_open_file",
    description: "Open a file in the Cursor editor, optionally jumping to a specific line.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path to open" },
        line: { type: "number", description: "Line number to jump to (1-indexed)" },
      },
      required: ["path"],
    },
  },
  {
    name: "cursor_editor_state",
    description: "Get the current editor state: active file, cursor position, selected text, open editors.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cursor_diagnostics",
    description: "Get all errors and warnings (diagnostics) from the IDE's language servers.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cursor_run_command",
    description: "Execute any VS Code / Cursor command by its ID. Use cursor_list_commands to discover IDs.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command ID (e.g. 'workbench.action.reloadWindow')" },
        args: { type: "array", description: "Optional arguments to pass to the command" },
      },
      required: ["command"],
    },
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

      case "cursor_status": {
        try {
          const result = await bridgeCall("GET", "/status");
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch {
          return {
            content: [{ type: "text", text: "Bridge not reachable. Make sure cursor-mcp-bridge extension is installed and Cursor is running." }],
            isError: true,
          };
        }
      }

      case "cursor_list_commands": {
        const filter = (a.filter as string | undefined) ?? "";
        const qs = filter ? `?filter=${encodeURIComponent(filter)}` : "";
        const result = await bridgeCall("GET", `/commands${qs}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_open_chat": {
        const openedAt = Date.now();
        const result = await bridgeCall("POST", "/chat/open", {
          mode: (a.mode as string | undefined) ?? "chat",
          message: a.message as string | undefined,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ...(result as object), since_ms: openedAt }, null, 2),
          }],
        };
      }

      case "cursor_send_message": {
        const result = await bridgeCall("POST", "/chat/send", { message: a.message as string });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_get_model": {
        const result = await bridgeCall("GET", "/model/current");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_set_model": {
        const result = await bridgeCall("POST", "/model/set", { model: a.model as string });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_open_model_picker": {
        const result = await bridgeCall("POST", "/model/picker");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_send_and_wait": {
        const result = await bridgeCall("POST", "/chat/send_and_wait", {
          message:    a.message as string,
          since_ms:   a.since_ms as number,
          timeout_ms: (a.timeout_ms as number | undefined) ?? 300_000,
        }) as { ok?: boolean; response?: string; text?: string; composerId?: string; error?: string; waited_ms?: number };

        if (!result.ok) {
          return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        }

        const response = result.text ?? result.response ?? "";
        return {
          content: [{
            type: "text",
            text: `**Cursor respondió** (waited ${result.waited_ms}ms):\n\n${response}`,
          }],
        };
      }

      case "cursor_open_file": {
        const result = await bridgeCall("POST", "/editor/open", {
          path: a.path as string,
          line: a.line as number | undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_editor_state": {
        const result = await bridgeCall("GET", "/editor/state");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_diagnostics": {
        const result = await bridgeCall("GET", "/diagnostics");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cursor_run_command": {
        const result = await bridgeCall("POST", "/command", {
          command: a.command as string,
          args: a.args as unknown[] | undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
