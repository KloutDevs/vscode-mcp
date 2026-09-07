import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface RegistryEntry {
  workspace: string;
  pid: number;
  startedAt: number;
}

export type Registry = Record<string, RegistryEntry>;

export function registryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".cursor-bridge", "registry.json");
}

export function readRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Registry;
  } catch {
    return {};
  }
}

/**
 * Find the extension's HTTP port whose registered workspace name matches a
 * CDP page title (Cursor titles a page after its workspace folder basename).
 */
export function findExtensionPort(workspaceTitle: string): number | undefined {
  const reg = readRegistry();
  for (const [portStr, entry] of Object.entries(reg)) {
    if (entry.workspace && workspaceTitle.includes(entry.workspace)) {
      return Number(portStr);
    }
  }
  return undefined;
}
