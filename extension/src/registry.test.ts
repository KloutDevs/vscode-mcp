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
