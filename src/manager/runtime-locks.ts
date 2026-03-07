import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureDir, nowIso, openpocketHome } from "../utils/paths.js";

export interface GatewayRuntimeLock {
  agentId: string;
  pid: number;
  configPath: string;
  targetFingerprint: string;
  startedAt: string;
  updatedAt: string;
  dashboardAddress: string | null;
}

interface TargetRuntimeLock {
  agentId: string;
  pid: number;
  configPath: string;
  targetFingerprint: string;
  startedAt: string;
  updatedAt: string;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, payload: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function gatewayRuntimeLockPath(stateDir: string): string {
  return path.join(stateDir, "runtime", "gateway.lock.json");
}

function targetRuntimeLocksDir(): string {
  return path.join(openpocketHome(), "manager", "locks", "targets");
}

function targetRuntimeLockPath(targetFingerprint: string): string {
  const fileName = `${crypto.createHash("sha1").update(targetFingerprint).digest("hex")}.json`;
  return path.join(targetRuntimeLocksDir(), fileName);
}

export function readGatewayRuntimeLock(stateDir: string): GatewayRuntimeLock | null {
  const lockPath = gatewayRuntimeLockPath(stateDir);
  const parsed = readJsonFile<GatewayRuntimeLock>(lockPath);
  if (!parsed) {
    return null;
  }
  if (!isPidAlive(parsed.pid)) {
    fs.rmSync(lockPath, { force: true });
    return null;
  }
  return parsed;
}

export function acquireGatewayRuntimeLock(input: {
  agentId: string;
  stateDir: string;
  configPath: string;
  targetFingerprint: string;
  dashboardAddress?: string | null;
}): GatewayRuntimeLock {
  const lockPath = gatewayRuntimeLockPath(input.stateDir);
  const existing = readGatewayRuntimeLock(input.stateDir);
  if (existing && existing.pid !== process.pid) {
    throw new Error(
      `Gateway for agent '${input.agentId}' is already running (pid ${existing.pid}).`,
    );
  }

  const now = nowIso();
  const payload: GatewayRuntimeLock = {
    agentId: input.agentId,
    pid: process.pid,
    configPath: input.configPath,
    targetFingerprint: input.targetFingerprint,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    dashboardAddress: input.dashboardAddress ?? existing?.dashboardAddress ?? null,
  };
  writeJsonFile(lockPath, payload);
  return payload;
}

export function updateGatewayRuntimeLock(stateDir: string, patch: { dashboardAddress?: string | null }): void {
  const existing = readGatewayRuntimeLock(stateDir);
  if (!existing || existing.pid !== process.pid) {
    return;
  }
  writeJsonFile(gatewayRuntimeLockPath(stateDir), {
    ...existing,
    updatedAt: nowIso(),
    dashboardAddress: patch.dashboardAddress ?? existing.dashboardAddress,
  });
}

export function releaseGatewayRuntimeLock(stateDir: string): void {
  const lockPath = gatewayRuntimeLockPath(stateDir);
  const parsed = readJsonFile<GatewayRuntimeLock>(lockPath);
  if (!parsed) {
    return;
  }
  if (parsed.pid !== process.pid && isPidAlive(parsed.pid)) {
    return;
  }
  fs.rmSync(lockPath, { force: true });
}

export function readTargetRuntimeLock(targetFingerprint: string): TargetRuntimeLock | null {
  const lockPath = targetRuntimeLockPath(targetFingerprint);
  const parsed = readJsonFile<TargetRuntimeLock>(lockPath);
  if (!parsed) {
    return null;
  }
  if (!isPidAlive(parsed.pid)) {
    fs.rmSync(lockPath, { force: true });
    return null;
  }
  return parsed;
}

export function acquireTargetRuntimeLock(input: {
  agentId: string;
  configPath: string;
  targetFingerprint: string;
}): TargetRuntimeLock {
  const lockPath = targetRuntimeLockPath(input.targetFingerprint);
  const existing = readTargetRuntimeLock(input.targetFingerprint);
  if (existing && (existing.pid !== process.pid || existing.agentId !== input.agentId)) {
    throw new Error(
      `Target '${input.targetFingerprint}' is already in use by agent '${existing.agentId}' (pid ${existing.pid}).`,
    );
  }

  const now = nowIso();
  const payload: TargetRuntimeLock = {
    agentId: input.agentId,
    pid: process.pid,
    configPath: input.configPath,
    targetFingerprint: input.targetFingerprint,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  };
  writeJsonFile(lockPath, payload);
  return payload;
}

export function releaseTargetRuntimeLock(targetFingerprint: string): void {
  const lockPath = targetRuntimeLockPath(targetFingerprint);
  const parsed = readJsonFile<TargetRuntimeLock>(lockPath);
  if (!parsed) {
    return;
  }
  if (parsed.pid !== process.pid && isPidAlive(parsed.pid)) {
    return;
  }
  fs.rmSync(lockPath, { force: true });
}
