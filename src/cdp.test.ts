import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAndMapPages } from "./cdp.js";

// NOTE: this file tests only the pure `/json/list` filtering/mapping logic.
// The actual CDP WebSocket send flow (listPages network call, sendMessage's
// Target.attachToTarget/Runtime.evaluate/Input.* dispatch) requires a live
// Cursor process with --remote-debugging-port and is NOT covered by an
// automated test here — it needs manual verification against a running
// Cursor instance (see design.md Testing Strategy: Integration/E2E rows).

test("filterAndMapPages keeps only type:page entries and maps id/title", () => {
  const raw = [
    { id: "abc123", title: "my-workspace — Cursor", type: "page" },
    { id: "def456", title: "DevTools", type: "background_page" },
    { id: "ghi789", title: "another-workspace — Cursor", type: "page" },
  ];
  const result = filterAndMapPages(raw);
  assert.deepEqual(result, [
    { pageId: "abc123", title: "my-workspace — Cursor" },
    { pageId: "ghi789", title: "another-workspace — Cursor" },
  ]);
});

test("filterAndMapPages returns an empty array when no page entries exist", () => {
  const raw = [{ id: "x", title: "worker", type: "service_worker" }];
  assert.deepEqual(filterAndMapPages(raw), []);
});

test("filterAndMapPages drops entries with a missing id even if type is page", () => {
  const raw = [{ title: "orphan", type: "page" }];
  assert.deepEqual(filterAndMapPages(raw), []);
});

test("filterAndMapPages defaults a missing title to an empty string", () => {
  const raw = [{ id: "abc", type: "page" }];
  assert.deepEqual(filterAndMapPages(raw), [{ pageId: "abc", title: "" }]);
});
