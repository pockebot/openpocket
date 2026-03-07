import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function openpocketHome(): string {
  const value = process.env.OPENPOCKET_HOME?.trim();
  if (value) {
    return path.resolve(value);
  }
  return path.resolve(path.join(os.homedir(), ".openpocket"));
}

export function defaultConfigPath(): string {
  return path.join(openpocketHome(), "config.json");
}

export function defaultWorkspaceDir(): string {
  return path.join(openpocketHome(), "workspace");
}

export function defaultStateDir(): string {
  return path.join(openpocketHome(), "state");
}

export function managerDir(): string {
  return path.join(openpocketHome(), "manager");
}

export function managerRegistryPath(): string {
  return path.join(managerDir(), "registry.json");
}

export function managerModelTemplatePath(): string {
  return path.join(managerDir(), "model-template.json");
}

export function managerPortsPath(): string {
  return path.join(managerDir(), "ports.json");
}

export function agentsRootDir(): string {
  return path.join(openpocketHome(), "agents");
}

export function agentRootDir(agentId: string): string {
  return path.join(agentsRootDir(), agentId);
}

export function agentConfigPath(agentId: string): string {
  return path.join(agentRootDir(agentId), "config.json");
}

export function agentWorkspaceDir(agentId: string): string {
  return path.join(agentRootDir(agentId), "workspace");
}

export function agentStateDir(agentId: string): string {
  return path.join(agentRootDir(agentId), "state");
}

export function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function resolvePath(value: string): string {
  if (value.startsWith("~")) {
    return path.resolve(path.join(os.homedir(), value.slice(1)));
  }
  return path.resolve(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowForFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function todayString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function timeString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
