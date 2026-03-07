import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../config/index.js";
import type { ModelProfile, OpenPocketConfig } from "../types.js";
import {
  agentConfigPath,
  agentRootDir,
  agentStateDir,
  agentWorkspaceDir,
  agentsRootDir,
  defaultConfigPath,
  ensureDir,
  managerModelTemplatePath,
  managerRegistryPath,
  nowIso,
  openpocketHome,
  resolvePath,
} from "../utils/paths.js";
import { computeTargetFingerprint } from "./target-fingerprint.js";

export interface ManagerModelTemplate {
  defaultModel: string;
  models: Record<string, ModelProfile>;
  capturedAt: string;
}

export interface ManagerAgentRecord {
  id: string;
  kind: "default" | "managed";
  configPath: string;
  workspaceDir: string;
  stateDir: string;
  rootDir: string;
  dashboardPort: number;
  targetFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagerRegistry {
  version: 1;
  defaultAgentId: string;
  agents: Record<string, ManagerAgentRecord>;
}

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

function normalizeAgentId(id: string): string {
  return id.trim().toLowerCase();
}

export function assertValidAgentId(id: string): string {
  const normalized = normalizeAgentId(id);
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(normalized)) {
    throw new Error(
      "Agent id must match ^[a-z0-9][a-z0-9_-]{0,47}$.",
    );
  }
  return normalized;
}

function defaultAgentRecord(): ManagerAgentRecord {
  const cfg = loadConfig(defaultConfigPath());
  const now = nowIso();
  return {
    id: "default",
    kind: "default",
    configPath: cfg.configPath,
    workspaceDir: cfg.workspaceDir,
    stateDir: cfg.stateDir,
    rootDir: openpocketHome(),
    dashboardPort: cfg.dashboard.port,
    targetFingerprint: computeTargetFingerprint(cfg),
    createdAt: now,
    updatedAt: now,
  };
}

function mergeDefaultRecord(existing: ManagerAgentRecord | null): ManagerAgentRecord {
  const base = defaultAgentRecord();
  if (!existing) {
    return base;
  }
  return {
    ...existing,
    ...base,
    createdAt: existing.createdAt || base.createdAt,
    updatedAt: nowIso(),
  };
}

function ensureRegistryFile(): ManagerRegistry {
  ensureDir(agentsRootDir());
  const registryPath = managerRegistryPath();
  const existing = readJsonFile<ManagerRegistry>(registryPath, "manager registry");
  const defaultRecord = mergeDefaultRecord(existing?.agents?.default ?? null);
  const registry: ManagerRegistry = {
    version: 1,
    defaultAgentId: existing?.defaultAgentId || "default",
    agents: {
      ...(existing?.agents ?? {}),
      default: defaultRecord,
    },
  };
  writeJsonFile(registryPath, registry);
  return registry;
}

function ensureModelTemplateFile(): ManagerModelTemplate {
  const templatePath = managerModelTemplatePath();
  const existing = readJsonFile<ManagerModelTemplate>(templatePath, "manager model template");
  if (existing?.defaultModel && existing.models && Object.keys(existing.models).length > 0) {
    return existing;
  }
  const cfg = loadConfig(defaultConfigPath());
  const template: ManagerModelTemplate = {
    defaultModel: cfg.defaultModel,
    models: JSON.parse(JSON.stringify(cfg.models)) as Record<string, ModelProfile>,
    capturedAt: nowIso(),
  };
  writeJsonFile(templatePath, template);
  return template;
}

export function loadManagerRegistry(): ManagerRegistry {
  ensureModelTemplateFile();
  return ensureRegistryFile();
}

export function saveManagerRegistry(registry: ManagerRegistry): void {
  writeJsonFile(managerRegistryPath(), registry);
}

export function loadManagerModelTemplate(): ManagerModelTemplate {
  return ensureModelTemplateFile();
}

export function ensureManagerModelTemplateFromConfig(
  config: OpenPocketConfig,
  options: { overwrite?: boolean } = {},
): ManagerModelTemplate {
  const templatePath = managerModelTemplatePath();
  const existing = readJsonFile<ManagerModelTemplate>(templatePath, "manager model template");
  if (existing && !options.overwrite) {
    return existing;
  }
  const template: ManagerModelTemplate = {
    defaultModel: config.defaultModel,
    models: JSON.parse(JSON.stringify(config.models)) as Record<string, ModelProfile>,
    capturedAt: nowIso(),
  };
  writeJsonFile(templatePath, template);
  return template;
}

export function listManagerAgents(): ManagerAgentRecord[] {
  return Object.values(loadManagerRegistry().agents).sort((a, b) => a.id.localeCompare(b.id));
}

export function getManagerAgent(agentId: string): ManagerAgentRecord {
  const normalized = assertValidAgentId(agentId);
  const registry = loadManagerRegistry();
  const record = registry.agents[normalized];
  if (!record) {
    throw new Error(`Unknown agent: ${normalized}`);
  }
  return record;
}

export function findManagerAgentByConfigPath(configPath: string): ManagerAgentRecord | null {
  const resolved = resolvePath(configPath);
  for (const record of listManagerAgents()) {
    if (resolvePath(record.configPath) === resolved) {
      return record;
    }
  }
  return null;
}

export function nextAvailableDashboardPort(): number {
  const reserved = new Set<number>();
  for (const record of listManagerAgents()) {
    if (Number.isFinite(record.dashboardPort) && record.dashboardPort > 0) {
      reserved.add(Math.round(record.dashboardPort));
    }
  }
  let candidate = 51889;
  while (reserved.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

export function managerAgentPaths(agentId: string): {
  rootDir: string;
  configPath: string;
  workspaceDir: string;
  stateDir: string;
} {
  const normalized = assertValidAgentId(agentId);
  if (normalized === "default") {
    const cfg = loadConfig(defaultConfigPath());
    return {
      rootDir: openpocketHome(),
      configPath: cfg.configPath,
      workspaceDir: cfg.workspaceDir,
      stateDir: cfg.stateDir,
    };
  }
  return {
    rootDir: agentRootDir(normalized),
    configPath: agentConfigPath(normalized),
    workspaceDir: agentWorkspaceDir(normalized),
    stateDir: agentStateDir(normalized),
  };
}

export function registerManagedAgent(input: {
  agentId: string;
  config: OpenPocketConfig;
  rootDir?: string;
  dashboardPort?: number;
}): ManagerAgentRecord {
  const normalized = assertValidAgentId(input.agentId);
  const registry = loadManagerRegistry();
  const existing = registry.agents[normalized] ?? null;
  const now = nowIso();
  const record: ManagerAgentRecord = {
    id: normalized,
    kind: normalized === "default" ? "default" : "managed",
    configPath: input.config.configPath,
    workspaceDir: input.config.workspaceDir,
    stateDir: input.config.stateDir,
    rootDir: input.rootDir ?? (normalized === "default" ? openpocketHome() : agentRootDir(normalized)),
    dashboardPort: input.dashboardPort ?? input.config.dashboard.port,
    targetFingerprint: computeTargetFingerprint(input.config),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  registry.agents[normalized] = record;
  saveManagerRegistry(registry);
  return record;
}

export function deleteManagedAgent(agentId: string): ManagerAgentRecord {
  const normalized = assertValidAgentId(agentId);
  if (normalized === "default") {
    throw new Error("The default agent cannot be deleted.");
  }
  const registry = loadManagerRegistry();
  const record = registry.agents[normalized];
  if (!record) {
    throw new Error(`Unknown agent: ${normalized}`);
  }
  delete registry.agents[normalized];
  saveManagerRegistry(registry);
  return record;
}

export function assertTargetFingerprintAvailable(targetFingerprint: string, owningAgentId: string): void {
  const normalizedOwner = assertValidAgentId(owningAgentId);
  for (const record of listManagerAgents()) {
    if (record.id === normalizedOwner) {
      continue;
    }
    if (record.targetFingerprint === targetFingerprint) {
      throw new Error(
        `Target '${targetFingerprint}' is already bound to agent '${record.id}'.`,
      );
    }
  }
}

export function cloneBaseAgentConfig(source: OpenPocketConfig, agentId: string): OpenPocketConfig {
  const normalized = assertValidAgentId(agentId);
  const paths = managerAgentPaths(normalized);
  const template = loadManagerModelTemplate();
  const cloned = JSON.parse(JSON.stringify(source)) as OpenPocketConfig;
  cloned.projectName = normalized === "default" ? source.projectName : `${source.projectName} (${normalized})`;
  cloned.workspaceDir = paths.workspaceDir;
  cloned.stateDir = paths.stateDir;
  cloned.sessionStorage.storePath = path.join(paths.workspaceDir, "sessions", "sessions.json");
  cloned.screenshots.directory = path.join(paths.stateDir, "screenshots");
  cloned.cron.jobsFile = path.join(paths.workspaceDir, "cron", "jobs.json");
  cloned.dashboard.port = nextAvailableDashboardPort();
  cloned.humanAuth.localRelayStateFile = path.join(paths.stateDir, "human-auth-relay", "requests.json");
  cloned.defaultModel = template.defaultModel;
  cloned.models = JSON.parse(JSON.stringify(template.models)) as Record<string, ModelProfile>;
  cloned.agent.deviceId = null;
  cloned.target.adbEndpoint = "";
  cloned.target.cloudProvider = "";
  cloned.channels = {
    defaults: {
      dmPolicy: cloned.channels?.defaults?.dmPolicy ?? "pairing",
      groupPolicy: cloned.channels?.defaults?.groupPolicy ?? "disabled",
    },
  };
  if (cloned.pairing) {
    cloned.pairing = {
      ...cloned.pairing,
      stateDir: path.join(paths.stateDir, "pairing"),
    };
  }
  cloned.humanAuth.relayBaseUrl = "";
  cloned.humanAuth.publicBaseUrl = "";
  cloned.configPath = paths.configPath;
  return cloned;
}

export function removeAgentFilesystem(record: ManagerAgentRecord): void {
  if (record.kind !== "managed") {
    return;
  }
  fs.rmSync(record.rootDir, { recursive: true, force: true });
}
