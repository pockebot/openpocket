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

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
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
  const parsed = readJsonFile<ManagerPorts>(filePath);
  const ports: ManagerPorts = {
    version: 1,
    managerDashboardPort: normalizePort(parsed?.managerDashboardPort, DEFAULT_MANAGER_DASHBOARD_PORT),
    relayHubPort: normalizePort(parsed?.relayHubPort, DEFAULT_RELAY_HUB_PORT),
  };
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(ports, null, 2)}\n`, "utf-8");
  return ports;
}

export function saveManagerPorts(ports: ManagerPorts): void {
  const filePath = managerPortsPath();
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(ports, null, 2)}\n`, "utf-8");
}
