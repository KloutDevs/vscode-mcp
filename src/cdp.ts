import { request as httpRequest } from "http";

export interface CdpPage {
  pageId: string;
  title: string;
}

interface CdpJsonListEntry {
  id?: string;
  title?: string;
  type?: string;
}

/** Fetch raw JSON from the CDP `/json/list` HTTP endpoint on the given port. */
function fetchJsonList(port: number): Promise<CdpJsonListEntry[]> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/json/list", method: "GET", timeout: 5_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(new Error(`Failed to parse CDP /json/list response: ${err}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/** Pure mapping/filtering logic — unit-testable without any network I/O. */
export function filterAndMapPages(entries: CdpJsonListEntry[]): CdpPage[] {
  return entries
    .filter((e) => e.type === "page")
    .map((e) => ({ pageId: e.id ?? "", title: e.title ?? "" }))
    .filter((p) => p.pageId !== "");
}

/**
 * Discover all open Cursor windows via CDP `/json/list`.
 * Throws a clear, actionable error if the debug port is unreachable —
 * never falls back to any other discovery mechanism.
 */
export async function listPages(port: number): Promise<CdpPage[]> {
  let raw: CdpJsonListEntry[];
  try {
    raw = await fetchJsonList(port);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach Cursor's CDP debug port ${port} (http://127.0.0.1:${port}/json/list): ${message}. ` +
        `Relaunch Cursor with --remote-debugging-port=${port} (or set CURSOR_CDP_PORT to match your launch flag).`
    );
  }
  return filterAndMapPages(raw);
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  sessionId?: string;
  error?: { message?: string };
}

/** Minimal CDP WebSocket RPC client for a single attached target session. */
class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (msg: CdpMessage) => void>();
  private sessionId: string | undefined;
  private ready: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener("open", () => resolveReady());
      this.ws.addEventListener("error", () => rejectReady(new Error(`WebSocket error connecting to ${wsUrl}`)));
    });
    this.ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  async waitOpen(): Promise<void> {
    await this.ready;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    return new Promise((resolveSend) => {
      const id = this.nextId++;
      this.pending.set(id, resolveSend);
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }

  async attach(targetId: string): Promise<void> {
    const attach = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const result = attach.result as { sessionId?: string } | undefined;
    if (!result?.sessionId) {
      throw new Error(`Target.attachToTarget did not return a sessionId for target ${targetId}`);
    }
    this.sessionId = result.sessionId;
  }

  close(): void {
    this.ws.close();
  }
}

const EDITOR_SELECTOR = ".aislash-editor-input";

/** JS expression evaluated in-page to focus the chat editor and report its bounding rect. */
function buildFocusExpression(selector: string): string {
  return `(() => {
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return { error: "not found" };
    editor.focus();
    const rect = editor.getBoundingClientRect();
    return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  })()`;
}

interface FocusResult {
  error?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

async function sendViaCdp(wsUrl: string, targetId: string, text: string): Promise<{ editorFound: boolean }> {
  const session = new CdpSession(wsUrl);
  try {
    await session.waitOpen();
    await session.attach(targetId);
    await session.send("Runtime.enable");
    await session.send("Input.enable");

    const focusResult = await session.send("Runtime.evaluate", {
      expression: buildFocusExpression(EDITOR_SELECTOR),
      returnByValue: true,
    });
    const evaluated = (focusResult.result as { result?: { value?: FocusResult } } | undefined)?.result?.value;

    if (!evaluated?.rect) {
      return { editorFound: false };
    }

    const { x, y, width, height } = evaluated.rect;
    const cx = x + width / 2;
    const cy = y + height / 2;

    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });

    await session.send("Input.insertText", { text });
    await new Promise((r) => setTimeout(r, 300));

    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });

    return { editorFound: true };
  } finally {
    session.close();
  }
}

/** Ask the extension's fixed-port HTTP bridge to create a new composer tab. */
function requestNewComposerTab(extensionPort: number): Promise<void> {
  return new Promise((resolveCall, reject) => {
    const payload = JSON.stringify({ command: "composer.createNewComposerTab" });
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: extensionPort,
        path: "/command",
        method: "POST",
        timeout: 10_000,
        headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload, "utf8") },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolveCall());
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout requesting composer.createNewComposerTab"));
    });
    req.write(payload, "utf8");
    req.end();
  });
}

/**
 * Send a chat message to a Cursor window via CDP trusted input events.
 * If no chat tab is open, requests one via the extension's fixed HTTP port
 * (`composer.createNewComposerTab`) and retries once.
 */
export async function sendMessage(
  port: number,
  pageId: string,
  text: string,
  options: { extensionPort?: number } = {}
): Promise<void> {
  const wsUrl = `ws://127.0.0.1:${port}/devtools/page/${pageId}`;
  const first = await sendViaCdp(wsUrl, pageId, text);
  if (first.editorFound) return;

  const extensionPort = options.extensionPort ?? 9421;
  await requestNewComposerTab(extensionPort);
  await new Promise((r) => setTimeout(r, 800));

  const second = await sendViaCdp(wsUrl, pageId, text);
  if (!second.editorFound) {
    throw new Error(
      `Could not locate chat input (${EDITOR_SELECTOR}) after requesting a new composer tab on page ${pageId}.`
    );
  }
}
