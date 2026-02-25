import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { OpenPocketConfig, SessionStorageConfig } from "../types.js";
import { ensureDir, nowForFilename, nowIso, timeString, todayString } from "../utils/paths.js";
import { loadWorkspaceTemplate } from "./workspace-templates.js";
import type {
  SessionBackend,
  SessionCreatePayload,
  SessionEventPayload,
  SessionFinalizePayload,
  SessionStepPayload,
  SessionStepTraceDetails,
} from "../agent/session-backend.js";
import { SessionMarkdownBackend } from "../agent/session-markdown-backend.js";
import { SessionOpenclawStoreBackend } from "../agent/session-openclaw-store-backend.js";
import { SessionPiTreeJsonlBackend } from "../agent/session-pi-tree-jsonl-backend.js";

export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_PROFILE_ONBOARDING_FILENAME = "PROFILE_ONBOARDING.json";
export const DEFAULT_BARE_SESSION_RESET_PROMPT_FILENAME = "BARE_SESSION_RESET_PROMPT.md";
export const DEFAULT_TASK_PROGRESS_REPORTER_FILENAME = "TASK_PROGRESS_REPORTER.md";
export const DEFAULT_TASK_OUTCOME_REPORTER_FILENAME = "TASK_OUTCOME_REPORTER.md";

const WORKSPACE_STATE_DIRNAME = ".openpocket";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;

type WorkspaceOnboardingState = {
  version: typeof WORKSPACE_STATE_VERSION;
  bootstrapSeededAt?: string;
  onboardingCompletedAt?: string;
};

const CORE_TEMPLATE_FILES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_TASK_PROGRESS_REPORTER_FILENAME,
  DEFAULT_TASK_OUTCOME_REPORTER_FILENAME,
  DEFAULT_BARE_SESSION_RESET_PROMPT_FILENAME,
  DEFAULT_PROFILE_ONBOARDING_FILENAME,
] as const;

const BRAND_NEW_SENTINEL_FILES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
] as const;

function readTextIfExists(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function writeFileIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    return false;
  }
  fs.writeFileSync(filePath, content, "utf-8");
  return true;
}

function resolveWorkspaceStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}

function readWorkspaceOnboardingState(statePath: string): WorkspaceOnboardingState {
  if (!fs.existsSync(statePath)) {
    return { version: WORKSPACE_STATE_VERSION };
  }
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown;
      onboardingCompletedAt?: unknown;
    };
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt:
        typeof parsed.bootstrapSeededAt === "string" ? parsed.bootstrapSeededAt : undefined,
      onboardingCompletedAt:
        typeof parsed.onboardingCompletedAt === "string" ? parsed.onboardingCompletedAt : undefined,
    };
  } catch {
    return { version: WORKSPACE_STATE_VERSION };
  }
}

function writeWorkspaceOnboardingState(
  statePath: string,
  state: WorkspaceOnboardingState,
): void {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function isWorkspaceOnboardingCompleted(workspaceDir: string): boolean {
  const statePath = resolveWorkspaceStatePath(workspaceDir);
  const state = readWorkspaceOnboardingState(statePath);
  return (
    typeof state.onboardingCompletedAt === "string"
    && state.onboardingCompletedAt.trim().length > 0
  );
}

export function markWorkspaceOnboardingCompleted(workspaceDir: string): void {
  const statePath = resolveWorkspaceStatePath(workspaceDir);
  const state = readWorkspaceOnboardingState(statePath);
  const timestamp = nowIso();
  const next: WorkspaceOnboardingState = {
    version: WORKSPACE_STATE_VERSION,
    bootstrapSeededAt: state.bootstrapSeededAt ?? timestamp,
    onboardingCompletedAt: timestamp,
  };
  writeWorkspaceOnboardingState(statePath, next);
}

export function ensureWorkspaceBootstrap(workspaceDir: string): void {
  ensureDir(workspaceDir);
  ensureDir(path.join(workspaceDir, "memory"));
  ensureDir(path.join(workspaceDir, "sessions"));
  ensureDir(path.join(workspaceDir, "skills"));
  ensureDir(path.join(workspaceDir, "scripts"));
  ensureDir(path.join(workspaceDir, "scripts", "runs"));
  ensureDir(path.join(workspaceDir, "cron"));

  const isBrandNewWorkspace = BRAND_NEW_SENTINEL_FILES.every(
    (name) => !fs.existsSync(path.join(workspaceDir, name)),
  );

  const templates: Record<string, string> = {};
  for (const name of [...CORE_TEMPLATE_FILES, DEFAULT_BOOTSTRAP_FILENAME]) {
    templates[name] = loadWorkspaceTemplate(name);
  }

  for (const name of CORE_TEMPLATE_FILES) {
    writeFileIfMissing(path.join(workspaceDir, name), templates[name]);
  }

  const statePath = resolveWorkspaceStatePath(workspaceDir);
  let state = readWorkspaceOnboardingState(statePath);
  let stateDirty = false;
  const markState = (next: Partial<WorkspaceOnboardingState>) => {
    state = { ...state, ...next };
    stateDirty = true;
  };

  const bootstrapPath = path.join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME);
  let bootstrapExists = fs.existsSync(bootstrapPath);

  if (!state.bootstrapSeededAt && bootstrapExists) {
    markState({ bootstrapSeededAt: nowIso() });
  }

  if (!state.onboardingCompletedAt && state.bootstrapSeededAt && !bootstrapExists) {
    markState({ onboardingCompletedAt: nowIso() });
  }

  if (!state.bootstrapSeededAt && !state.onboardingCompletedAt && !bootstrapExists) {
    const identityCurrent = readTextIfExists(
      path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME),
    ).trim();
    const userCurrent = readTextIfExists(path.join(workspaceDir, DEFAULT_USER_FILENAME)).trim();
    const identityTemplate = templates[DEFAULT_IDENTITY_FILENAME].trim();
    const userTemplate = templates[DEFAULT_USER_FILENAME].trim();

    const legacyOnboardingCompleted =
      !isBrandNewWorkspace
      && identityCurrent.length > 0
      && userCurrent.length > 0
      && (identityCurrent !== identityTemplate || userCurrent !== userTemplate);

    if (legacyOnboardingCompleted) {
      markState({ onboardingCompletedAt: nowIso() });
    } else {
      writeFileIfMissing(bootstrapPath, templates[DEFAULT_BOOTSTRAP_FILENAME]);
      bootstrapExists = fs.existsSync(bootstrapPath);
      if (bootstrapExists && !state.bootstrapSeededAt) {
        markState({ bootstrapSeededAt: nowIso() });
      }
    }
  }

  if (stateDirty) {
    writeWorkspaceOnboardingState(statePath, state);
  }

  const memoryReadme = path.join(workspaceDir, "memory", "README.md");
  if (!fs.existsSync(memoryReadme)) {
    fs.writeFileSync(memoryReadme, "# Daily Memory\n\nOne file per date.\n", "utf-8");
  }

  const skillsReadme = path.join(workspaceDir, "skills", "README.md");
  if (!fs.existsSync(skillsReadme)) {
    fs.writeFileSync(
      skillsReadme,
      "# Skills\n\nDrop skill markdown files (*.md) here. Workspace skills take highest priority.\n",
      "utf-8",
    );
  }

  const scriptsReadme = path.join(workspaceDir, "scripts", "README.md");
  if (!fs.existsSync(scriptsReadme)) {
    fs.writeFileSync(
      scriptsReadme,
      "# Scripts\n\nStore automation helper scripts here. Runtime execution logs are under scripts/runs/.\n",
      "utf-8",
    );
  }

  const cronReadme = path.join(workspaceDir, "cron", "README.md");
  if (!fs.existsSync(cronReadme)) {
    fs.writeFileSync(
      cronReadme,
      [
        "# Cron Jobs",
        "",
        "Edit `jobs.json` to configure scheduled tasks.",
        "",
        "Schema:",
        "- id: unique job id",
        "- name: display name",
        "- enabled: true/false",
        "- everySec: interval in seconds",
        "- task: natural-language task text",
        "- chatId: Telegram chat id (optional, nullable)",
        "- model: model profile id (optional, nullable)",
        "- runOnStartup: run immediately when gateway starts",
      ].join("\n"),
      "utf-8",
    );
  }

  const cronJobs = path.join(workspaceDir, "cron", "jobs.json");
  if (!fs.existsSync(cronJobs)) {
    fs.writeFileSync(
      cronJobs,
      `${JSON.stringify(
        {
          jobs: [
            {
              id: "heartbeat-status",
              name: "Hourly Status Check",
              enabled: false,
              everySec: 3600,
              task: "Open Settings and verify network connectivity status.",
              chatId: null,
              model: null,
              runOnStartup: false,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }
}

export interface SessionHandle {
  id: string;
  path: string;
  sessionKey?: string;
  reused?: boolean;
}

export interface SessionResetHandle {
  sessionId: string;
  sessionPath: string;
  previousSessionId?: string;
  previousSessionPath?: string;
}

type WorkspaceStoreConfig = Pick<OpenPocketConfig, "workspaceDir"> & {
  sessionStorage?: Partial<SessionStorageConfig>;
};

function resolveSessionStorePath(
  workspaceDir: string,
  sessionStorage?: Partial<SessionStorageConfig>,
): string {
  const candidate = typeof sessionStorage?.storePath === "string" ? sessionStorage.storePath.trim() : "";
  return candidate.length > 0
    ? candidate
    : path.join(workspaceDir, "sessions", "sessions.json");
}

function resolveSessionBackends(
  storePath: string,
  sessionStorage?: Partial<SessionStorageConfig>,
): SessionBackend[] {
  const backends: SessionBackend[] = [
    new SessionPiTreeJsonlBackend(),
    new SessionOpenclawStoreBackend(storePath),
  ];
  if (sessionStorage?.markdownLog !== false) {
    backends.push(new SessionMarkdownBackend());
  }
  return backends;
}

export class WorkspaceStore {
  private readonly workspaceDir: string;
  private readonly sessionStorePath: string;
  private readonly sessionBackends: SessionBackend[];

  constructor(config: WorkspaceStoreConfig) {
    this.workspaceDir = config.workspaceDir;
    ensureWorkspaceBootstrap(this.workspaceDir);
    this.sessionStorePath = resolveSessionStorePath(this.workspaceDir, config.sessionStorage);
    this.sessionBackends = resolveSessionBackends(this.sessionStorePath, config.sessionStorage);
  }

  createSession(
    task: string,
    modelProfile: string,
    modelName: string,
    options?: { sessionKey?: string },
  ): SessionHandle {
    const normalizedSessionKey = options?.sessionKey?.trim() || undefined;
    const existing = normalizedSessionKey
      ? SessionOpenclawStoreBackend.resolveExistingSession(this.sessionStorePath, normalizedSessionKey)
      : null;

    const id = existing?.sessionId ?? nowForFilename();
    const sessionPath = existing?.sessionPath ?? path.join(this.workspaceDir, "sessions", `session-${id}.jsonl`);
    const startedAt = nowIso();
    const payload: SessionCreatePayload = {
      sessionId: id,
      sessionPath,
      sessionKey: normalizedSessionKey,
      task,
      modelProfile,
      modelName,
      startedAt,
    };
    for (const backend of this.sessionBackends) {
      backend.create(payload);
    }
    return {
      id,
      path: sessionPath,
      sessionKey: normalizedSessionKey,
      reused: Boolean(existing),
    };
  }

  resetSession(sessionKey: string): SessionResetHandle | null {
    const normalizedSessionKey = String(sessionKey || "").trim();
    if (!normalizedSessionKey) {
      return null;
    }

    const sessionId = `${nowForFilename()}-${randomUUID().slice(0, 8)}`;
    const sessionPath = path.join(this.workspaceDir, "sessions", `session-${sessionId}.jsonl`);
    return SessionOpenclawStoreBackend.resetSession(this.sessionStorePath, normalizedSessionKey, {
      sessionId,
      sessionPath,
    });
  }

  appendStep(
    session: SessionHandle,
    stepNo: number,
    thought: string,
    actionJson: string,
    result: string,
    trace?: SessionStepTraceDetails,
  ): void {
    const payload: SessionStepPayload = {
      sessionId: session.id,
      sessionPath: session.path,
      sessionKey: session.sessionKey,
      stepNo,
      at: nowIso(),
      thought,
      actionJson,
      result,
      trace,
    };
    for (const backend of this.sessionBackends) {
      backend.appendStep(payload);
    }
  }

  appendEvent(
    session: SessionHandle,
    eventType: string,
    details?: Record<string, unknown>,
    text?: string,
  ): void {
    const payload: SessionEventPayload = {
      sessionId: session.id,
      sessionPath: session.path,
      sessionKey: session.sessionKey,
      at: nowIso(),
      eventType: String(eventType || "").trim() || "unknown",
      details,
      text,
    };
    for (const backend of this.sessionBackends) {
      backend.appendEvent(payload);
    }
  }

  finalizeSession(session: SessionHandle, ok: boolean, message: string): void {
    const payload: SessionFinalizePayload = {
      sessionId: session.id,
      sessionPath: session.path,
      sessionKey: session.sessionKey,
      status: ok ? "SUCCESS" : "FAILED",
      endedAt: nowIso(),
      message,
    };
    for (const backend of this.sessionBackends) {
      backend.finalize(payload);
    }
  }

  appendDailyMemory(modelProfile: string, task: string, ok: boolean, message: string): string {
    const date = todayString();
    const filePath = path.join(this.workspaceDir, "memory", `${date}.md`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, `# Memory ${date}\n\n`, "utf-8");
    }

    const status = ok ? "OK" : "FAIL";
    const compact = message.trim().replace(/\s+/g, " ").slice(0, 400);
    fs.appendFileSync(
      filePath,
      `- [${timeString()}] [${status}] [${modelProfile}] task: ${task} | result: ${compact}\n`,
      "utf-8",
    );
    return filePath;
  }
}
