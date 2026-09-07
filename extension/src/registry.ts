import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

type RegistryEntry = { workspace: string; pid: number; startedAt: number };
type Registry = Record<string, RegistryEntry>;

export function registryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".cursor-bridge", "registry.json");
}

function readRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Registry;
  } catch {
    return {};
  }
}

function writeRegistry(data: Registry): void {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

export function writeRegistryEntry(port: number, workspace: string, pid: number): void {
  const data = readRegistry();
  data[String(port)] = { workspace, pid, startedAt: Date.now() };
  writeRegistry(data);
}

export function removeRegistryEntry(port: number): void {
  if (!existsSync(registryPath())) return;
  const data = readRegistry();
  delete data[String(port)];
  writeRegistry(data);
}
