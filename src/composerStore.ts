import { DatabaseSync } from "node:sqlite";
import { join } from "path";

export interface ComposerData {
  fullConversationHeadersOnly: { bubbleId: string; type?: number }[];
  status: string;
}

export interface BubbleData {
  text: string;
  type: number;
}

/** Default path to Cursor's global state.vscdb, per-OS. */
export function defaultStateDbPath(): string {
  const platform = process.platform;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  // linux and other POSIX
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(configHome, "Cursor", "User", "globalStorage", "state.vscdb");
}

/** Pure parse of a `composerData:<id>` row's JSON text. Unit-testable without SQLite. */
export function parseComposerData(raw: string | null | undefined): ComposerData | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const headers = Array.isArray(obj.fullConversationHeadersOnly) ? obj.fullConversationHeadersOnly : [];
  const status = typeof obj.status === "string" ? obj.status : "";
  return {
    fullConversationHeadersOnly: headers as { bubbleId: string; type?: number }[],
    status,
  };
}

/** Pure parse of a `bubbleId:<composerId>:<bubbleId>` row's JSON text. */
export function parseBubbleData(raw: string | null | undefined): BubbleData | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  return {
    text: typeof obj.text === "string" ? obj.text : "",
    type: typeof obj.type === "number" ? obj.type : 0,
  };
}

/** Pure detection: is this composer's generation finished? */
export function isCompleted(data: ComposerData | null): boolean {
  return data?.status === "completed";
}

/** Pure detection: has the reply count grown past a baseline? */
export function hasNewReply(data: ComposerData | null, sinceCount: number): boolean {
  return !!data && data.fullConversationHeadersOnly.length > sinceCount;
}

let cachedDb: DatabaseSync | null = null;
let cachedDbPath: string | null = null;

function getDb(dbPath: string): DatabaseSync {
  if (cachedDb && cachedDbPath === dbPath) return cachedDb;
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      // ignore
    }
  }
  cachedDb = new DatabaseSync(dbPath, { readOnly: true });
  cachedDbPath = dbPath;
  return cachedDb;
}

function readKey(dbPath: string, key: string): string | null {
  const db = getDb(dbPath);
  const stmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const row = stmt.get(key) as { value?: string | Buffer } | undefined;
  if (!row || row.value === undefined) return null;
  return typeof row.value === "string" ? row.value : row.value.toString("utf8");
}

/** Read a composer's full conversation header list and status from state.vscdb. */
export function readComposerData(composerId: string, dbPath: string = defaultStateDbPath()): ComposerData | null {
  const raw = readKey(dbPath, `composerData:${composerId}`);
  return parseComposerData(raw);
}

/** Read a single bubble's text and message type from state.vscdb. */
export function readBubble(
  composerId: string,
  bubbleId: string,
  dbPath: string = defaultStateDbPath()
): BubbleData | null {
  const raw = readKey(dbPath, `bubbleId:${composerId}:${bubbleId}`);
  return parseBubbleData(raw);
}

/**
 * Return the composerId of the most recently created `composerData:*` row,
 * or null if none exist. Used to detect a brand-new composer/agent tab after
 * a send when no `composer_id` is already known.
 *
 * NOTE: this relies on SQLite's implicit rowid ordering approximating insert
 * recency. It is a best-effort heuristic — the CDP send path itself does not
 * expose the composerId it created, so this needs live-Cursor verification
 * (see design.md Testing Strategy: Integration/E2E rows, manual).
 */
export function findNewestComposerId(dbPath: string = defaultStateDbPath()): string | null {
  const db = getDb(dbPath);
  const stmt = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY rowid DESC LIMIT 1");
  const row = stmt.get() as { key?: string } | undefined;
  if (!row?.key) return null;
  return row.key.slice("composerData:".length);
}

/**
 * Poll until a composerId newer than `baselineComposerId` appears, or
 * timeoutMs elapses. Returns the new composerId.
 */
export async function waitForNewComposerId(
  baselineComposerId: string | null,
  timeoutMs: number,
  dbPath: string = defaultStateDbPath(),
  pollIntervalMs = 1_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = findNewestComposerId(dbPath);
    if (current && current !== baselineComposerId) return current;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a new composer tab to appear`);
}

/**
 * Poll state.vscdb until the conversation has a new reply and status is
 * "completed", or timeoutMs elapses. Returns the text of the last non-empty
 * assistant (type !== 2, i.e. not a user bubble) bubble. Never uses fs.watch.
 */
export async function waitForReply(
  composerId: string,
  sinceCount: number,
  timeoutMs: number,
  dbPath: string = defaultStateDbPath(),
  pollIntervalMs = 1_500
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = readComposerData(composerId, dbPath);
    if (hasNewReply(data, sinceCount) && isCompleted(data)) {
      const headers = data!.fullConversationHeadersOnly;
      for (let i = headers.length - 1; i >= 0; i--) {
        const h = headers[i];
        if (h.type !== 2) continue; // only type 2 (assistant) bubbles carry the final reply
        const bubble = readBubble(composerId, h.bubbleId, dbPath);
        if (bubble && bubble.text.trim()) return bubble.text;
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a completed reply on composer ${composerId}`);
}
