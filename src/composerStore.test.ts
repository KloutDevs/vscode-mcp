import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseComposerData,
  parseBubbleData,
  isCompleted,
  hasNewReply,
  readComposerData,
  readBubble,
  waitForReply,
  extractComposersForWorkspace,
} from "./composerStore.js";

// ─── pure parsing tests (no I/O) ─────────────────────────────────────────────

test("parseComposerData extracts headers and status from valid JSON", () => {
  const raw = JSON.stringify({
    fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 }],
    status: "completed",
  });
  assert.deepEqual(parseComposerData(raw), {
    fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 }],
    status: "completed",
  });
});

test("parseComposerData returns null for null/undefined input", () => {
  assert.equal(parseComposerData(null), null);
  assert.equal(parseComposerData(undefined), null);
});

test("parseComposerData returns null for malformed JSON", () => {
  assert.equal(parseComposerData("{not json"), null);
});

test("parseComposerData defaults missing fields safely", () => {
  assert.deepEqual(parseComposerData("{}"), { fullConversationHeadersOnly: [], status: "" });
});

test("parseBubbleData extracts text and type", () => {
  const raw = JSON.stringify({ text: "hello world", type: 2 });
  assert.deepEqual(parseBubbleData(raw), { text: "hello world", type: 2 });
});

test("parseBubbleData returns null for malformed JSON", () => {
  assert.equal(parseBubbleData("nope"), null);
});

test("isCompleted detects status:completed", () => {
  assert.equal(isCompleted({ fullConversationHeadersOnly: [], status: "completed" }), true);
  assert.equal(isCompleted({ fullConversationHeadersOnly: [], status: "generating" }), false);
  assert.equal(isCompleted(null), false);
});

test("hasNewReply detects a grown header count", () => {
  const data = { fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }], status: "completed" };
  assert.equal(hasNewReply(data, 1), true);
  assert.equal(hasNewReply(data, 2), false);
  assert.equal(hasNewReply(null, 0), false);
});

// ─── fixture state.vscdb tests (real SQLite, never the user's live DB) ───────

function withFixtureDb<T>(seed: (db: DatabaseSync) => void, fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "vscode-mcp-composerstore-test-"));
  const dbPath = join(dir, "state.vscdb");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  seed(db);
  db.close();
  try {
    return fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readComposerData reads a fixture row by composerId", () => {
  withFixtureDb(
    (db) => {
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        "composerData:composer-1",
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "b1", type: 2 }], status: "completed" })
      );
    },
    (dbPath) => {
      const data = readComposerData("composer-1", dbPath);
      assert.deepEqual(data, {
        fullConversationHeadersOnly: [{ bubbleId: "b1", type: 2 }],
        status: "completed",
      });
    }
  );
});

test("readComposerData returns null when the key is absent", () => {
  withFixtureDb(
    () => {},
    (dbPath) => {
      assert.equal(readComposerData("missing-composer", dbPath), null);
    }
  );
});

test("readBubble reads a fixture bubble row", () => {
  withFixtureDb(
    (db) => {
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        "bubbleId:composer-1:b1",
        JSON.stringify({ text: "final reply text", type: 2 })
      );
    },
    (dbPath) => {
      assert.deepEqual(readBubble("composer-1", "b1", dbPath), { text: "final reply text", type: 2 });
    }
  );
});

test("waitForReply resolves with the last type:2 bubble text once status is completed", async () => {
  await withFixtureDb(
    (db) => {
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        "composerData:composer-2",
        JSON.stringify({
          fullConversationHeadersOnly: [
            { bubbleId: "u1", type: 1 },
            { bubbleId: "a1", type: 2 },
          ],
          status: "completed",
        })
      );
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        "bubbleId:composer-2:a1",
        JSON.stringify({ text: "the agent's reply", type: 2 })
      );
    },
    async (dbPath) => {
      const text = await waitForReply("composer-2", 0, 5_000, dbPath, 50);
      assert.equal(text, "the agent's reply");
    }
  );
});

test("waitForReply rejects on timeout when status never reaches completed", async () => {
  await withFixtureDb(
    (db) => {
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        "composerData:composer-3",
        JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: "u1", type: 1 }], status: "generating" })
      );
    },
    async (dbPath) => {
      await assert.rejects(() => waitForReply("composer-3", 0, 150, dbPath, 50), /Timed out/);
    }
  );
});

test("extractComposersForWorkspace filters by workspace folder basename", () => {
  const headers = JSON.stringify({
    allComposers: [
      {
        composerId: "a1",
        name: "Chat A",
        lastUpdatedAt: 111,
        unifiedMode: "agent",
        workspaceIdentifier: { uri: { fsPath: "/Users/nahuel/Desktop/cursor-bridge" } },
      },
      {
        composerId: "a2",
        name: "Chat B",
        lastUpdatedAt: 222,
        unifiedMode: "chat",
        workspaceIdentifier: { uri: { fsPath: "/Users/nahuel/Desktop/nexus-mcp" } },
      },
    ],
  });
  const result = extractComposersForWorkspace(headers, "cursor-bridge");
  assert.deepEqual(result, [
    { composerId: "a1", name: "Chat A", lastUpdatedAt: 111, unifiedMode: "agent" },
  ]);
});

test("extractComposersForWorkspace returns empty array for null/malformed input", () => {
  assert.deepEqual(extractComposersForWorkspace(null, "cursor-bridge"), []);
  assert.deepEqual(extractComposersForWorkspace("not json", "cursor-bridge"), []);
  assert.deepEqual(extractComposersForWorkspace(JSON.stringify({}), "cursor-bridge"), []);
});
