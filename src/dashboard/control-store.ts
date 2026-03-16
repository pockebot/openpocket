import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { OpenPocketConfig } from "../types.js";
import { ensureDir, nowIso } from "../utils/paths.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface OnboardingStateFile {
  updatedAt: string;
  consentAcceptedAt: string | null;
  modelProfile: string | null;
  modelProvider: string | null;
  modelConfiguredAt: string | null;
  apiKeyEnv: string | null;
  apiKeySource: "env" | "config" | null;
  apiKeyConfiguredAt: string | null;
  emulatorStartedAt: string | null;
  gmailLoginConfirmedAt: string | null;
  playStoreDetected: boolean | null;
}

export interface PromptFileEntry {
  id: string;
  title: string;
  path: string;
}

export interface MenuBarPermissionSettings {
  allowLocalStorageView: boolean;
  storageDirectoryPath: string;
  allowedSubpaths: string[];
  allowedExtensions: string[];
}

export interface MenuBarControlSettings {
  updatedAt: string;
  permission: MenuBarPermissionSettings;
  promptFiles: PromptFileEntry[];
}

export interface DashboardPaths {
  onboardingPath: string;
  controlPanelPath: string;
}

export function dashboardPaths(config: OpenPocketConfig): DashboardPaths {
  return {
    onboardingPath: path.join(config.stateDir, "onboarding.json"),
    controlPanelPath: path.join(config.stateDir, "control-panel.json"),
  };
}

function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    if (!text.trim()) {
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function providerLabel(baseUrl: string): string {
  const lower = baseUrl.toLowerCase();
  if (lower.includes("api.openai.com")) {
    return "OpenAI";
  }
  if (lower.includes("openrouter.ai")) {
    return "OpenRouter";
  }
  if (lower.includes("generativelanguage.googleapis.com") || lower.includes("googleapis.com")) {
    return "Google AI Studio";
  }
  if (lower.includes("api.z.ai") || lower.includes("bigmodel.cn")) {
    return "Z.AI (GLM)";
  }
  if (lower.includes("api.kimi.com")) {
    return "Kimi Code";
  }
  if (lower.includes("moonshot.cn") || lower.includes("moonshot.ai")) {
    return "Moonshot AI";
  }
  if (lower.includes("api.deepseek.com")) {
    return "DeepSeek";
  }
  if (lower.includes("/api/v2/apps/gui-owl/gui_agent_server")) {
    return "Aliyun UI Agent (Mobile)";
  }
  if (lower.includes("dashscope.aliyuncs.com")) {
    return "Qwen (DashScope)";
  }
  if (lower.includes("api.minimax.io") || lower.includes("api.minimaxi.com")) {
    return "MiniMax";
  }
  if (lower.includes("volces.com") || lower.includes("volcengine.com")) {
    return "Volcano Engine";
  }
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return "";
    }
  })();
  return host || "custom";
}

export function defaultOnboardingState(): OnboardingStateFile {
  return {
    updatedAt: nowIso(),
    consentAcceptedAt: null,
    modelProfile: null,
    modelProvider: null,
    modelConfiguredAt: null,
    apiKeyEnv: null,
    apiKeySource: null,
    apiKeyConfiguredAt: null,
    emulatorStartedAt: null,
    gmailLoginConfirmedAt: null,
    playStoreDetected: null,
  };
}

export function defaultPromptEntries(workspaceDir: string): PromptFileEntry[] {
  const files = [
    { id: "agents", title: "AGENTS", fileName: "AGENTS.md" },
    { id: "soul", title: "SOUL", fileName: "SOUL.md" },
    { id: "user", title: "USER", fileName: "USER.md" },
    { id: "identity", title: "IDENTITY", fileName: "IDENTITY.md" },
    { id: "tools", title: "TOOLS", fileName: "TOOLS.md" },
    { id: "heartbeat", title: "HEARTBEAT", fileName: "HEARTBEAT.md" },
    { id: "memory", title: "MEMORY", fileName: "MEMORY.md" },
    { id: "bootstrap", title: "BOOTSTRAP", fileName: "BOOTSTRAP.md" },
    { id: "progress-reporter", title: "PROGRESS REPORTER", fileName: "TASK_PROGRESS_REPORTER.md" },
    { id: "outcome-reporter", title: "OUTCOME REPORTER", fileName: "TASK_OUTCOME_REPORTER.md" },
    { id: "session-reset", title: "SESSION RESET", fileName: "BARE_SESSION_RESET_PROMPT.md" },
  ];
  return files.map((file) => ({
    id: file.id,
    title: file.title,
    path: path.join(workspaceDir, file.fileName),
  }));
}

export function defaultControlSettings(config: OpenPocketConfig): MenuBarControlSettings {
  return {
    updatedAt: nowIso(),
    permission: {
      allowLocalStorageView: false,
      storageDirectoryPath: config.workspaceDir,
      allowedSubpaths: ["sessions", "memory", "skills", "scripts", "cron"],
      allowedExtensions: ["md", "json", "txt", "log", "sh"],
    },
    promptFiles: defaultPromptEntries(config.workspaceDir),
  };
}

export function loadOnboardingState(config: OpenPocketConfig): OnboardingStateFile {
  const filePath = dashboardPaths(config).onboardingPath;
  const raw = readJsonFile(filePath);
  if (!isObject(raw)) {
    return defaultOnboardingState();
  }

  const parsed: OnboardingStateFile = {
    updatedAt: String(raw.updatedAt ?? nowIso()),
    consentAcceptedAt: raw.consentAcceptedAt ? String(raw.consentAcceptedAt) : null,
    modelProfile: raw.modelProfile ? String(raw.modelProfile) : null,
    modelProvider: raw.modelProvider ? String(raw.modelProvider) : null,
    modelConfiguredAt: raw.modelConfiguredAt ? String(raw.modelConfiguredAt) : null,
    apiKeyEnv: raw.apiKeyEnv ? String(raw.apiKeyEnv) : null,
    apiKeySource:
      raw.apiKeySource === "env" || raw.apiKeySource === "config"
        ? raw.apiKeySource
        : null,
    apiKeyConfiguredAt: raw.apiKeyConfiguredAt ? String(raw.apiKeyConfiguredAt) : null,
    emulatorStartedAt: raw.emulatorStartedAt ? String(raw.emulatorStartedAt) : null,
    gmailLoginConfirmedAt: raw.gmailLoginConfirmedAt ? String(raw.gmailLoginConfirmedAt) : null,
    playStoreDetected:
      raw.playStoreDetected === true || raw.playStoreDetected === false
        ? raw.playStoreDetected
        : null,
  };

  return parsed;
}

export function saveOnboardingState(config: OpenPocketConfig, state: OnboardingStateFile): void {
  const filePath = dashboardPaths(config).onboardingPath;
  writeJsonFile(filePath, state);
}

function normalizePromptFiles(items: unknown[], workspaceDir: string): PromptFileEntry[] {
  const seen = new Set<string>();
  const output: PromptFileEntry[] = [];

  for (const item of items) {
    if (!isObject(item)) {
      continue;
    }
    const rawPath = String(item.path ?? "").trim();
    if (!rawPath) {
      continue;
    }

    let id = String(item.id ?? "").trim();
    if (!id || seen.has(id)) {
      id = `prompt-${crypto.randomUUID()}`;
    }

    const titleRaw = String(item.title ?? "").trim();
    const title = titleRaw || path.basename(rawPath, path.extname(rawPath));

    seen.add(id);
    output.push({ id, title, path: rawPath });
  }

  if (output.length === 0) {
    return defaultPromptEntries(workspaceDir);
  }
  return output;
}

export function loadControlSettings(config: OpenPocketConfig): MenuBarControlSettings {
  const filePath = dashboardPaths(config).controlPanelPath;
  const raw = readJsonFile(filePath);
  if (!isObject(raw)) {
    return defaultControlSettings(config);
  }

  const rawPermission = isObject(raw.permission) ? raw.permission : {};
  const defaultPermission = defaultControlSettings(config).permission;
  const permission: MenuBarPermissionSettings = {
    allowLocalStorageView: Boolean(rawPermission.allowLocalStorageView ?? defaultPermission.allowLocalStorageView),
    storageDirectoryPath:
      String(rawPermission.storageDirectoryPath ?? "").trim() || defaultPermission.storageDirectoryPath,
    allowedSubpaths: Array.isArray(rawPermission.allowedSubpaths)
      ? rawPermission.allowedSubpaths.map((v) => String(v).trim()).filter(Boolean)
      : defaultPermission.allowedSubpaths,
    allowedExtensions: Array.isArray(rawPermission.allowedExtensions)
      ? rawPermission.allowedExtensions.map((v) => String(v).trim().toLowerCase()).filter(Boolean)
      : defaultPermission.allowedExtensions,
  };

  const promptFiles = Array.isArray(raw.promptFiles)
    ? normalizePromptFiles(raw.promptFiles, config.workspaceDir)
    : defaultPromptEntries(config.workspaceDir);

  return {
    updatedAt: String(raw.updatedAt ?? nowIso()),
    permission,
    promptFiles,
  };
}

export function saveControlSettings(config: OpenPocketConfig, settings: MenuBarControlSettings): void {
  const filePath = dashboardPaths(config).controlPanelPath;
  writeJsonFile(filePath, settings);
}
