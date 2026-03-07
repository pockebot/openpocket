import fs from "node:fs";
import path from "node:path";

import { ensureDir, managerPortsPath } from "../utils/paths.js";

export interface ManagerPorts {
  version: 1;
  managerDashboardPort: number;
  relayHubPort: number;
}

const DEFAULT_MANAGER_DASHBOARD_PORT = 51880;
const DEFAULT_RELAY_HUB_PORT = 8787;

function readJsonFile<T>(filePath: string, label: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} JSON at ${filePath}: ${message}`);
  }
}

function writeJsonFile(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function normalizePort(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(65535, Math.round(parsed)));
}

export function loadManagerPorts(): ManagerPorts {
  const filePath = managerPortsPath();
  const parsed = readJsonFile<ManagerPorts>(filePath, "manager ports");
  const ports: ManagerPorts = {
    version: 1,
    managerDashboardPort: normalizePort(parsed?.managerDashboardPort, DEFAULT_MANAGER_DASHBOARD_PORT),
    relayHubPort: normalizePort(parsed?.relayHubPort, DEFAULT_RELAY_HUB_PORT),
  };
  writeJsonFile(filePath, ports);
  return ports;
}

export function saveManagerPorts(ports: ManagerPorts): void {
  writeJsonFile(managerPortsPath(), ports);
}
