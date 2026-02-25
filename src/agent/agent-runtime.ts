import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type {
  AgentProgressUpdate,
  AgentRunResult,
  AgentAction,
  HumanAuthDecision,
  HumanAuthCapability,
  HumanAuthRequest,
  UserDecisionRequest,
  UserDecisionResponse,
  UserInputRequest,
  UserInputResponse,
  OpenPocketConfig,
  ModelProfile,
  SkillInfo,
  ScreenSnapshot,
} from "../types.js";
import { getModelProfile, resolveModelAuth } from "../config/index.js";
import { WorkspaceStore } from "../memory/workspace.js";
import { ScreenshotStore } from "../memory/screenshot-store.js";
import { sleep } from "../utils/time.js";
import { nowIso } from "../utils/paths.js";
import { AdbRuntime } from "../device/adb-runtime.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import { AutoArtifactBuilder, type StepTrace } from "../skills/auto-artifact-builder.js";
import { SkillLoader } from "../skills/skill-loader.js";
import { ScriptExecutor } from "../tools/script-executor.js";
import { CodingExecutor } from "../tools/coding-executor.js";
import { MemoryExecutor } from "../tools/memory-executor.js";
import { Agent, type AgentMessage, type AgentTool, type AgentEvent, type AgentOptions } from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage as PiAssistantMessage,
  type Message as PiMessage,
  type TextContent as PiTextContent,
  type ImageContent as PiImageContent,
  type Model as PiModel,
  type Api as PiApi,
  type SimpleStreamOptions as PiSimpleStreamOptions,
  streamSimple,
} from "@mariozechner/pi-ai";
import { buildPiAiModel } from "./model-client.js";
import { buildSystemPrompt, buildUserPrompt, type SystemPromptMode } from "./prompts.js";
import { CHAT_TOOLS, TOOL_METAS, toolNameToActionType, type ToolMeta } from "./tools.js";
import { normalizeAction } from "./actions.js";
import { runRuntimeAttempt } from "./runtime/attempt.js";
import { runRuntimeTask } from "./runtime/run.js";
import type { RunTaskRequest } from "./runtime/types.js";
import { scaleCoordinates, drawDebugMarker } from "../utils/image-scale.js";

const AUTO_PERMISSION_DIALOG_PACKAGES = [
  "permissioncontroller",
  "packageinstaller",
];

const PERMISSION_APPROVE_TEXT_HINTS = [
  "while using",
  "only this time",
  "allow all the time",
  "allow",
  "continue",
  "ok",
  "yes",
  "grant",
  "permit",
];

const PERMISSION_DENY_TEXT_HINTS = [
  "don't allow",
  "dont allow",
  "deny",
  "not now",
  "cancel",
  "no",
];

const PERMISSION_APPROVE_ID_HINTS = [
  "allow",
  "grant",
  "positive",
  "continue",
  "button1",
];

const PERMISSION_DENY_ID_HINTS = [
  "deny",
  "negative",
  "cancel",
  "dont_allow",
  "button2",
  "button3",
];

const SYSTEM_PROMPT_CONTEXT_FILES = [
  "AGENTS.md",
  "BOOTSTRAP.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "MEMORY.md",
  "TASK_PROGRESS_REPORTER.md",
  "TASK_OUTCOME_REPORTER.md",
] as const;
const SYSTEM_PROMPT_CONTEXT_HOOK_FILE = path.join(".openpocket", "bootstrap-context-hook.md");
const SYSTEM_PROMPT_MAX_CHARS_PER_FILE = 20_000;
/** Default total char budget. Overridden by config.agent.contextBudgetChars at runtime. */
const SYSTEM_PROMPT_MAX_CHARS_TOTAL_DEFAULT = 150_000;
const ACTION_TYPE_TO_TOOL_NAME = new Map<string, string>(
  TOOL_METAS.map((meta) => [toolNameToActionType(meta.name), meta.name]),
);
const CODING_TOOL_NAMES = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);
const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
const WORKSPACE_TOOL_NAMES = new Set([...CODING_TOOL_NAMES, ...MEMORY_TOOL_NAMES]);

type WorkspacePromptFileReport = {
  fileName: string;
  originalChars: number;
  includedChars: number;
  truncated: boolean;
  included: boolean;
  missing: boolean;
  /** True when the file was skipped because the total char budget was exhausted. */
  budgetExhausted: boolean;
  snippet: string;
};

export type WorkspacePromptContextReport = {
  maxCharsPerFile: number;
  maxCharsTotal: number;
  totalIncludedChars: number;
  files: WorkspacePromptFileReport[];
  hookApplied: boolean;
  source: "estimate" | "run";
  generatedAt: string;
  promptMode: SystemPromptMode;
  systemPrompt: {
    chars: number;
    workspaceContextChars: number;
    nonWorkspaceChars: number;
  };
  skills: {
    promptChars: number;
    entries: Array<{
      name: string;
      source: "workspace" | "local" | "bundled";
      path: string;
      blockChars: number;
    }>;
    activePromptChars: number;
    activeEntries: Array<{
      name: string;
      source: "workspace" | "local" | "bundled";
      path: string;
      reason: string;
      score: number;
      blockChars: number;
      truncated: boolean;
    }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      schemaChars: number;
      propertiesCount: number | null;
    }>;
  };
};

type DelegationApplyResult = {
  message: string;
  templateHint: string | null;
  action?: AgentAction | null;
  oauthTyped?: {
    username: boolean;
    password: boolean;
  };
};

type PermissionDialogNode = {
  text: string;
  contentDesc: string;
  resourceId: string;
  className: string;
  clickable: boolean;
  enabled: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type CredentialInputNode = {
  resourceId: string;
  className: string;
  hint: string;
  password: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type OauthCredentialCache = {
  username: string;
  password: string;
  updatedAtMs: number;
};

type ResolvedTapElementContext = {
  id: string;
  label: string;
  className: string;
  clickable: boolean;
  center: { x: number; y: number };
  scaledCenter: { x: number; y: number };
  bounds: { left: number; top: number; right: number; bottom: number };
  scaledBounds: { left: number; top: number; right: number; bottom: number };
};

type SnapshotObservation = {
  app: string;
  uiHash: string;
  labels: string[];
};

// ---------------------------------------------------------------------------
// Screen observation custom message type for pi-agent-core
// ---------------------------------------------------------------------------

interface ScreenObservationMessage {
  role: "screenObservation";
  snapshot: ScreenSnapshot;
  /** Recent previous snapshots for multi-frame visual context (max 2). */
  recentSnapshots: ScreenSnapshot[];
  stepIndex: number;
  screenshotPath: string | null;
  timestamp: number;
}

// Extend pi-agent-core's CustomAgentMessages via declaration merging
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    screenObservation: ScreenObservationMessage;
  }
}

/** Mutable state shared across tool execute closures during a single runTask invocation. */
interface PhoneAgentRunContext {
  task: string;
  profileKey: string;
  profile: ModelProfile;
  session: { id: string; path: string };
  stepCount: number;
  maxSteps: number;
  latestSnapshot: ScreenSnapshot | null;
  /** Rolling window of recent snapshots for multi-frame visual context. */
  recentSnapshotWindow: ScreenSnapshot[];
  lastScreenshotPath: string | null;
  history: string[];
  traces: StepTrace[];
  finishMessage: string | null;
  failMessage: string | null;
  stopRequested: () => boolean;
  lastAutoPermissionAllowAtMs: number;
  launchablePackages: string[];
  effectivePromptMode: SystemPromptMode;
  systemPrompt: string;
  onHumanAuth?: (request: HumanAuthRequest) => Promise<HumanAuthDecision> | HumanAuthDecision;
  onUserDecision?: (request: UserDecisionRequest) => Promise<UserDecisionResponse> | UserDecisionResponse;
  onUserInput?: (request: UserInputRequest) => Promise<UserInputResponse> | UserInputResponse;
  onProgress?: (update: AgentProgressUpdate) => Promise<void> | void;
}

type AgentLike = Pick<Agent, "followUp" | "subscribe" | "prompt" | "waitForIdle"> & {
  abort?: () => void;
};
type AgentFactory = (options: AgentOptions) => AgentLike;

export interface AgentRuntimeOptions {
  agentFactory?: AgentFactory;
}

export class AgentRuntime {
  private readonly config: OpenPocketConfig;
  private readonly workspace: WorkspaceStore;
  private readonly emulator: EmulatorManager;
  private readonly adb: AdbRuntime;
  private readonly skillLoader: SkillLoader;
  private readonly autoArtifactBuilder: AutoArtifactBuilder;
  private readonly scriptExecutor: ScriptExecutor;
  private readonly codingExecutor: CodingExecutor;
  private readonly memoryExecutor: MemoryExecutor;
  private readonly screenshotStore: ScreenshotStore;
  private busy = false;
  private stopRequested = false;
  private currentTask: string | null = null;
  private currentTaskStartedAtMs: number | null = null;
  private lastSystemPromptReport: WorkspacePromptContextReport | null = null;
  private lastResolvedTapElementContext: ResolvedTapElementContext | null = null;
  private delegatedOauthCredentials: OauthCredentialCache | null = null;
  private readonly agentFactory: AgentFactory;

  constructor(config: OpenPocketConfig, options?: AgentRuntimeOptions) {
    this.config = config;
    this.workspace = new WorkspaceStore(config);
    this.emulator = new EmulatorManager(config);
    this.adb = new AdbRuntime(config, this.emulator);
    this.skillLoader = new SkillLoader(config);
    this.autoArtifactBuilder = new AutoArtifactBuilder(config);
    this.scriptExecutor = new ScriptExecutor(config);
    this.codingExecutor = new CodingExecutor(config);
    this.memoryExecutor = new MemoryExecutor(config);
    this.screenshotStore = new ScreenshotStore(
      config.screenshots.directory,
      config.screenshots.maxCount,
    );
    this.agentFactory = options?.agentFactory ?? ((agentOptions: AgentOptions) => new Agent(agentOptions));
  }

  isBusy(): boolean {
    return this.busy;
  }

  getCurrentTask(): string | null {
    return this.currentTask;
  }

  getCurrentTaskRuntimeMs(): number | null {
    if (!this.currentTaskStartedAtMs) {
      return null;
    }
    return Math.max(0, Date.now() - this.currentTaskStartedAtMs);
  }

  listSkills(): SkillInfo[] {
    return this.skillLoader.loadAll();
  }

  async captureManualScreenshot(): Promise<string> {
    const snapshot = await this.adb.captureScreenSnapshot(this.config.agent.deviceId);
    return this.screenshotStore.save(
      Buffer.from(snapshot.screenshotBase64, "base64"),
      {
        sessionId: "manual",
        step: 0,
        currentApp: snapshot.currentApp,
      },
    );
  }

  stopCurrentTask(): boolean {
    if (!this.busy) {
      return false;
    }
    this.stopRequested = true;
    return true;
  }

  resetSession(sessionKey: string): { sessionId: string; sessionPath: string } | null {
    return this.workspace.resetSession(sessionKey);
  }

  private async safeReturnToHome(): Promise<void> {
    if (!this.config.agent.returnHomeOnTaskEnd) {
      return;
    }

    try {
      const result = await this.adb.executeAction(
        { type: "keyevent", keycode: "KEYCODE_HOME", reason: "task_end_default_reset" },
        this.config.agent.deviceId,
      );
      if (this.config.agent.verbose) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][task-end] ${result}`);
      }
    } catch (error) {
      if (this.config.agent.verbose) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][task-end] failed to return home: ${(error as Error).message}`);
      }
    }
  }

  private readJsonArtifact(artifactPath: string): Record<string, unknown> | null {
    try {
      const raw = fs.readFileSync(artifactPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private clipWithHeadTail(input: string, limit: number): { snippet: string; truncated: boolean } {
    if (input.length <= limit) {
      return { snippet: input, truncated: false };
    }
    const marker = "\n...[truncated: middle content omitted]...\n";
    // When the limit is too small to fit marker + meaningful content, fall back
    // to a simple head truncation so the output is still useful.
    if (limit < marker.length + 100) {
      return {
        snippet: input.slice(0, Math.max(0, limit)).trimEnd(),
        truncated: true,
      };
    }
    const budget = limit - marker.length;
    const headChars = Math.ceil(budget * 0.6);
    const tailChars = budget - headChars;
    const head = input.slice(0, headChars).trimEnd();
    const tail = tailChars > 0 ? input.slice(-tailChars).trimStart() : "";
    return {
      snippet: `${head}${marker}${tail}`,
      truncated: true,
    };
  }

  private buildWorkspacePromptContext(): { text: string; report: WorkspacePromptContextReport } {
    const blocks: string[] = [];
    const reports: WorkspacePromptFileReport[] = [];
    const totalBudget = this.config.agent.contextBudgetChars || SYSTEM_PROMPT_MAX_CHARS_TOTAL_DEFAULT;
    let remaining = totalBudget;
    let hookApplied = false;

    const hookPath = path.join(this.config.workspaceDir, SYSTEM_PROMPT_CONTEXT_HOOK_FILE);
    const hookRaw = fs.existsSync(hookPath)
      ? (() => {
        try {
          return fs.readFileSync(hookPath, "utf-8");
        } catch {
          return "";
        }
      })()
      : "";
    const hookNormalized = hookRaw.replace(/\r\n/g, "\n").trim();
    if (hookNormalized && remaining > 256) {
      const hookLimit = Math.min(SYSTEM_PROMPT_MAX_CHARS_PER_FILE, remaining);
      const clipped = this.clipWithHeadTail(hookNormalized, hookLimit);
      blocks.push(`### BOOTSTRAP_CONTEXT_HOOK\n${clipped.snippet}`);
      reports.push({
        fileName: "BOOTSTRAP_CONTEXT_HOOK",
        originalChars: hookNormalized.length,
        includedChars: clipped.snippet.length,
        truncated: clipped.truncated,
        included: true,
        missing: false,
        budgetExhausted: false,
        snippet: clipped.snippet,
      });
      remaining -= clipped.snippet.length;
      hookApplied = true;
    }

    for (const name of SYSTEM_PROMPT_CONTEXT_FILES) {
      if (remaining <= 256) {
        reports.push({
          fileName: name,
          originalChars: 0,
          includedChars: 0,
          truncated: false,
          included: false,
          missing: false,
          budgetExhausted: true,
          snippet: "",
        });
        continue;
      }
      const filePath = path.join(this.config.workspaceDir, name);
      if (!fs.existsSync(filePath)) {
        reports.push({
          fileName: name,
          originalChars: 0,
          includedChars: 0,
          truncated: false,
          included: false,
          missing: true,
          budgetExhausted: false,
          snippet: "",
        });
        continue;
      }

      let raw = "";
      try {
        raw = fs.readFileSync(filePath, "utf-8");
      } catch {
        reports.push({
          fileName: name,
          originalChars: 0,
          includedChars: 0,
          truncated: false,
          included: false,
          missing: true,
          budgetExhausted: false,
          snippet: "",
        });
        continue;
      }

      const normalized = raw.replace(/\r\n/g, "\n").trim();
      if (!normalized) {
        reports.push({
          fileName: name,
          originalChars: 0,
          includedChars: 0,
          truncated: false,
          included: false,
          missing: false,
          budgetExhausted: false,
          snippet: "",
        });
        continue;
      }

      const perFileLimit = Math.min(SYSTEM_PROMPT_MAX_CHARS_PER_FILE, remaining);
      const clipped = this.clipWithHeadTail(normalized, perFileLimit);
      blocks.push(`### ${name}\n${clipped.snippet}`);
      reports.push({
        fileName: name,
        originalChars: normalized.length,
        includedChars: clipped.snippet.length,
        truncated: clipped.truncated,
        included: true,
        missing: false,
        budgetExhausted: false,
        snippet: clipped.snippet,
      });
      remaining -= clipped.snippet.length;
    }

    const text = blocks.length === 0
      ? ""
      : [
        "Instruction priority inside workspace context: AGENTS.md > BOOTSTRAP.md > SOUL.md > other files.",
        ...blocks,
      ].join("\n\n");

    const baseReport = {
      maxCharsPerFile: SYSTEM_PROMPT_MAX_CHARS_PER_FILE,
      maxCharsTotal: totalBudget,
      totalIncludedChars: reports.reduce((sum, item) => sum + item.includedChars, 0),
      files: reports,
      hookApplied,
    };

    return {
      text,
      report: {
        ...baseReport,
        source: "estimate",
        generatedAt: nowIso(),
        promptMode: "full",
        systemPrompt: {
          chars: 0,
          workspaceContextChars: text.length,
          nonWorkspaceChars: 0,
        },
        skills: {
          promptChars: 0,
          entries: [],
          activePromptChars: 0,
          activeEntries: [],
        },
        tools: {
          listChars: 0,
          schemaChars: 0,
          entries: [],
        },
      },
    };
  }

  private buildToolPromptReport(): WorkspacePromptContextReport["tools"] {
    const entries = CHAT_TOOLS.map((tool) => {
      const schemaChars = JSON.stringify(tool.function.parameters).length;
      const properties = tool.function.parameters.properties;
      const propertiesCount = properties && typeof properties === "object"
        ? Object.keys(properties).length
        : null;
      return {
        name: tool.function.name,
        summaryChars: (tool.function.description || "").trim().length,
        schemaChars,
        propertiesCount,
      };
    });

    const listText = CHAT_TOOLS
      .map((tool) => `- ${tool.function.name}: ${tool.function.description}`)
      .join("\n");
    return {
      listChars: listText.length,
      schemaChars: entries.reduce((sum, item) => sum + item.schemaChars, 0),
      entries,
    };
  }

  private buildSystemPromptReport(params: {
    source: "estimate" | "run";
    promptMode: SystemPromptMode;
    systemPrompt: string;
    skillsSummary: string;
    activeSkillsPrompt?: string;
    activeSkillsEntries?: Array<{
      name: string;
      source: "workspace" | "local" | "bundled";
      path: string;
      reason: string;
      score: number;
      blockChars: number;
      truncated: boolean;
    }>;
    workspaceReport: WorkspacePromptContextReport;
  }): WorkspacePromptContextReport {
    const skillsEntries = this.skillLoader.summaryEntries().map((entry) => ({
      name: entry.skill.name,
      source: entry.skill.source,
      path: entry.skill.path,
      blockChars: entry.line.length,
    }));
    const workspaceContextChars = params.workspaceReport.files
      .reduce((sum, file) => sum + file.includedChars, 0);
    const tools = this.buildToolPromptReport();
    return {
      ...params.workspaceReport,
      source: params.source,
      generatedAt: nowIso(),
      promptMode: params.promptMode,
      systemPrompt: {
        chars: params.systemPrompt.length,
        workspaceContextChars,
        nonWorkspaceChars: Math.max(0, params.systemPrompt.length - workspaceContextChars),
      },
      skills: {
        promptChars: params.skillsSummary.length,
        entries: skillsEntries,
        activePromptChars: (params.activeSkillsPrompt ?? "").length,
        activeEntries: params.activeSkillsEntries ?? [],
      },
      tools,
    };
  }

  getWorkspacePromptContextReport(): WorkspacePromptContextReport {
    if (this.lastSystemPromptReport) {
      return this.lastSystemPromptReport;
    }
    const skillContext = this.skillLoader.buildPromptContextForTask("");
    const workspacePromptContext = this.buildWorkspacePromptContext();
    const promptMode = this.config.agent.systemPromptMode;
    const systemPrompt = buildSystemPrompt(skillContext.summaryText, workspacePromptContext.text, {
      mode: promptMode,
      activeSkillsText: skillContext.activePromptText,
    });
    return this.buildSystemPromptReport({
      source: "estimate",
      promptMode,
      systemPrompt,
      skillsSummary: skillContext.summaryText,
      activeSkillsPrompt: skillContext.activePromptText,
      activeSkillsEntries: skillContext.activeEntries.map((entry) => ({
        name: entry.skill.name,
        source: entry.skill.source,
        path: entry.skill.path,
        reason: entry.reason,
        score: entry.score,
        blockChars: entry.contentChars,
        truncated: entry.truncated,
      })),
      workspaceReport: workspacePromptContext.report,
    });
  }

  private isImageArtifactPath(artifactPath: string): boolean {
    const ext = path.extname(artifactPath).toLowerCase();
    return [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".gif"].includes(ext);
  }

  private extractDelegatedText(artifactJson: Record<string, unknown> | null): string | null {
    if (!artifactJson) {
      return null;
    }
    const value = artifactJson.value;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    return null;
  }

  private extractDelegatedTextFromDecisionMessage(message: string): string | null {
    const raw = String(message || "").trim();
    if (!raw) {
      return null;
    }

    const normalized = raw.toLowerCase();
    if (
      normalized.startsWith("approved by ") ||
      normalized.startsWith("rejected by ") ||
      normalized === "approved from web link." ||
      normalized === "rejected from web link."
    ) {
      return null;
    }

    const explicitCode = raw.match(/\b\d{4,10}\b/);
    if (explicitCode?.[0]) {
      return explicitCode[0];
    }

    if (/^[A-Za-z0-9._-]{4,32}$/.test(raw)) {
      return raw;
    }
    return null;
  }

  private extractDelegatedGeo(
    artifactJson: Record<string, unknown> | null,
  ): { lat: number; lon: number } | null {
    if (!artifactJson) {
      return null;
    }
    const lat = Number(artifactJson.lat);
    const lon = Number(artifactJson.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    return { lat, lon };
  }

  private extractDelegatedCredentials(
    artifactJson: Record<string, unknown> | null,
  ): { username: string; password: string } | null {
    if (!artifactJson) {
      return null;
    }
    if (String(artifactJson.kind ?? "") !== "credentials") {
      return null;
    }
    const usernameRaw = artifactJson.username;
    const passwordRaw = artifactJson.password;
    const username = typeof usernameRaw === "string" ? usernameRaw.trim() : "";
    const password = typeof passwordRaw === "string" ? passwordRaw : "";
    if (!username && !password) {
      return null;
    }
    return { username, password };
  }

  private getCachedOauthCredentials(maxAgeMs = 15 * 60 * 1000): { username: string; password: string } | null {
    const cache = this.delegatedOauthCredentials;
    if (!cache) {
      return null;
    }
    if (Date.now() - cache.updatedAtMs > maxAgeMs) {
      this.delegatedOauthCredentials = null;
      return null;
    }
    return {
      username: cache.username,
      password: cache.password,
    };
  }

  private putCachedOauthCredentials(username: string, password: string): void {
    const current = this.delegatedOauthCredentials;
    const mergedUsername = username || current?.username || "";
    const mergedPassword = password || current?.password || "";
    if (!mergedUsername && !mergedPassword) {
      this.delegatedOauthCredentials = null;
      return;
    }
    this.delegatedOauthCredentials = {
      username: mergedUsername,
      password: mergedPassword,
      updatedAtMs: Date.now(),
    };
  }

  private clearCachedOauthCredentials(): void {
    this.delegatedOauthCredentials = null;
  }

  private async applyLocationDelegation(lat: number, lon: number): Promise<DelegationApplyResult> {
    const deviceId = this.adb.resolveDeviceId(this.config.agent.deviceId);
    this.emulator.runAdb(
      [
        "-s",
        deviceId,
        "emu",
        "geo",
        "fix",
        String(lon),
        String(lat),
      ],
      20_000,
    );
    return {
      message: `delegated location injected lat=${lat.toFixed(6)} lon=${lon.toFixed(6)}`,
      templateHint: "location_injected_continue_flow",
    };
  }

  private async applyTextDelegation(text: string): Promise<DelegationApplyResult> {
    const result = await this.adb.executeAction(
      {
        type: "type",
        text,
        reason: "human_auth_delegate_text",
      },
      this.config.agent.deviceId,
    );
    return {
      message: `delegated text typed (${text.length} chars): ${result}`,
      templateHint: "text_typed_continue_flow",
    };
  }

  private credentialHintScore(node: CredentialInputNode, target: "username" | "password"): number {
    const resource = this.normalizePermissionUiText(node.resourceId);
    const hint = this.normalizePermissionUiText(node.hint);
    const className = this.normalizePermissionUiText(node.className);
    const combined = `${resource} ${hint} ${className}`;

    if (target === "password") {
      let score = 0;
      if (node.password) {
        score += 140;
      }
      if (combined.includes("password") || combined.includes("passcode") || combined.includes("pwd")) {
        score += 110;
      }
      return score;
    }

    let score = 0;
    if (!node.password) {
      score += 20;
    }
    if (
      combined.includes("username") ||
      combined.includes("user name") ||
      combined.includes("email") ||
      combined.includes("account") ||
      combined.includes("phone")
    ) {
      score += 120;
    }
    return score;
  }

  private pickCredentialInputNode(
    nodes: CredentialInputNode[],
    target: "username" | "password",
    exclude: CredentialInputNode | null,
  ): CredentialInputNode | null {
    const filtered = nodes.filter((node) => node !== exclude);
    if (filtered.length === 0) {
      return null;
    }
    const scored = filtered
      .map((node) => ({
        node,
        score: this.credentialHintScore(node, target),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.node.top !== b.node.top) {
          return a.node.top - b.node.top;
        }
        return a.node.left - b.node.left;
      });
    if ((scored[0]?.score ?? 0) > 0) {
      return scored[0]?.node ?? null;
    }
    if (target === "password") {
      const passwordNode = filtered.find((node) => node.password);
      if (passwordNode) {
        return passwordNode;
      }
      return filtered[filtered.length - 1] ?? null;
    }
    const textNode = filtered.find((node) => !node.password);
    if (textNode) {
      return textNode;
    }
    return null;
  }

  private async tapCredentialNode(
    node: CredentialInputNode,
    reason: string,
  ): Promise<void> {
    const tapX = Math.max(0, Math.round((node.left + node.right) / 2));
    const tapY = Math.max(0, Math.round((node.top + node.bottom) / 2));
    await this.adb.executeAction(
      {
        type: "tap",
        x: tapX,
        y: tapY,
        reason,
      },
      this.config.agent.deviceId,
    );
    await sleep(120);
  }

  private async applyCredentialDelegation(
    username: string,
    password: string,
  ): Promise<DelegationApplyResult> {
    const deviceId = this.resolveDelegationDeviceId();
    const uiDumpXml = this.captureUiDumpXml(deviceId);
    const nodes = this.parseCredentialInputNodes(uiDumpXml);
    let focusedUsernameNode: CredentialInputNode | null = null;

    let typedUsername = false;
    let typedPassword = false;

    if (username) {
      focusedUsernameNode = this.pickCredentialInputNode(nodes, "username", null);
      if (focusedUsernameNode) {
        await this.tapCredentialNode(focusedUsernameNode, "human_auth_focus_username");
        await this.adb.executeAction(
          {
            type: "type",
            text: username,
            reason: "human_auth_delegate_username",
          },
          this.config.agent.deviceId,
        );
        typedUsername = true;
      }
    }

    if (password) {
      const passwordNode = this.pickCredentialInputNode(nodes, "password", focusedUsernameNode);
      if (passwordNode) {
        await this.tapCredentialNode(passwordNode, "human_auth_focus_password");
        await this.adb.executeAction(
          {
            type: "type",
            text: password,
            reason: "human_auth_delegate_password",
          },
          this.config.agent.deviceId,
        );
        typedPassword = true;
      }
    }

    // Keep oauth credentials cached for split-screen sign-in (username -> next -> password).
    this.putCachedOauthCredentials(username, password);
    if (typedPassword) {
      // Once password has been typed on-device, clear cache to reduce credential lifetime.
      this.clearCachedOauthCredentials();
    }

    // Redact credential details from logs — only report typed/deferred fields.
    const typed: string[] = [];
    const deferred: string[] = [];
    if (username) {
      if (typedUsername) {
        typed.push("username");
      } else {
        deferred.push("username");
      }
    }
    if (password) {
      if (typedPassword) {
        typed.push("password");
      } else {
        deferred.push("password");
      }
    }
    const messageParts: string[] = [];
    if (typed.length > 0) {
      messageParts.push(`delegated credentials typed: ${typed.join(" + ")}`);
    }
    if (deferred.length > 0) {
      messageParts.push(`deferred for next oauth step: ${deferred.join(" + ")}`);
    }
    if (messageParts.length === 0) {
      messageParts.push("no credential input fields detected for delegation");
    }

    return {
      message: messageParts.join(" ; "),
      templateHint: "oauth_credentials_typed_continue_flow",
      oauthTyped: {
        username: typedUsername,
        password: typedPassword,
      },
    };
  }

  private async applyImageDelegation(artifactPath: string): Promise<DelegationApplyResult> {
    const deviceId = this.adb.resolveDeviceId(this.config.agent.deviceId);
    const ext = path.extname(artifactPath).toLowerCase() || ".jpg";
    const remoteName = `openpocket-human-auth-${Date.now()}${ext}`;
    const remotePath = `/sdcard/Download/${remoteName}`;
    this.emulator.runAdb(
      [
        "-s",
        deviceId,
        "push",
        artifactPath,
        remotePath,
      ],
      30_000,
    );
    try {
      this.emulator.runAdb(
        [
          "-s",
          deviceId,
          "shell",
          "am",
          "broadcast",
          "-a",
          "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
          "-d",
          `file://${remotePath}`,
        ],
        15_000,
      );
    } catch {
      // Media scan broadcast is best-effort.
    }
    return {
      message: `delegated image pushed to ${remotePath}`,
      templateHint:
        `gallery_import_template: tap app upload/attach/gallery entry, open Downloads, select ${remoteName}, then confirm.`,
    };
  }

  private normalizePermissionUiText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[’‘`´]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  private parseUiNodeAttributes(attributesRaw: string): Record<string, string> {
    const out: Record<string, string> = {};
    const attrRe = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
    let match = attrRe.exec(attributesRaw);
    while (match) {
      const key = match[1];
      const value = match[2] ?? "";
      out[key] = value;
      match = attrRe.exec(attributesRaw);
    }
    return out;
  }

  private parseBounds(boundsRaw: string): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null {
    const match = boundsRaw.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (!match) {
      return null;
    }
    const left = Number(match[1]);
    const top = Number(match[2]);
    const right = Number(match[3]);
    const bottom = Number(match[4]);
    if (![left, top, right, bottom].every((value) => Number.isFinite(value))) {
      return null;
    }
    if (right <= left || bottom <= top) {
      return null;
    }
    return { left, top, right, bottom };
  }

  private parsePermissionDialogNodes(uiDumpXml: string): PermissionDialogNode[] {
    const nodes: PermissionDialogNode[] = [];
    const nodeRe = /<node\s+([^>]*?)\/>/g;
    let match = nodeRe.exec(uiDumpXml);
    while (match) {
      const attrs = this.parseUiNodeAttributes(match[1] ?? "");
      const parsedBounds = this.parseBounds(String(attrs.bounds ?? "").trim());
      if (!parsedBounds) {
        match = nodeRe.exec(uiDumpXml);
        continue;
      }
      nodes.push({
        text: String(attrs.text ?? ""),
        contentDesc: String(attrs["content-desc"] ?? ""),
        resourceId: String(attrs["resource-id"] ?? ""),
        className: String(attrs.class ?? ""),
        clickable: String(attrs.clickable ?? "").toLowerCase() === "true",
        enabled: String(attrs.enabled ?? "").toLowerCase() !== "false",
        left: parsedBounds.left,
        top: parsedBounds.top,
        right: parsedBounds.right,
        bottom: parsedBounds.bottom,
      });
      match = nodeRe.exec(uiDumpXml);
    }
    return nodes;
  }

  private parseCredentialInputNodes(uiDumpXml: string): CredentialInputNode[] {
    const nodes: CredentialInputNode[] = [];
    const nodeRe = /<node\s+([^>]*?)\/>/g;
    let match = nodeRe.exec(uiDumpXml);
    while (match) {
      const attrs = this.parseUiNodeAttributes(match[1] ?? "");
      const className = String(attrs.class ?? "");
      const classNormalized = this.normalizePermissionUiText(className);
      const parsedBounds = this.parseBounds(String(attrs.bounds ?? "").trim());
      if (!parsedBounds || !classNormalized.includes("edittext")) {
        match = nodeRe.exec(uiDumpXml);
        continue;
      }
      const enabled = String(attrs.enabled ?? "").toLowerCase() !== "false";
      if (!enabled) {
        match = nodeRe.exec(uiDumpXml);
        continue;
      }
      nodes.push({
        resourceId: String(attrs["resource-id"] ?? ""),
        className,
        hint: String(attrs.hint ?? attrs.text ?? attrs["content-desc"] ?? ""),
        password: String(attrs.password ?? "").toLowerCase() === "true",
        left: parsedBounds.left,
        top: parsedBounds.top,
        right: parsedBounds.right,
        bottom: parsedBounds.bottom,
      });
      match = nodeRe.exec(uiDumpXml);
    }
    nodes.sort((a, b) => {
      if (a.top !== b.top) {
        return a.top - b.top;
      }
      return a.left - b.left;
    });
    return nodes;
  }

  private captureUiDumpXml(deviceId: string): string {
    // Use a unique temp file per call to avoid race conditions when the agent loop
    // and a human-auth credential delegation run concurrently.
    const dumpFile = `/sdcard/openpocket-uidump-${Date.now()}.xml`;
    let uiDumpXml = "";
    try {
      this.emulator.runAdb(
        ["-s", deviceId, "shell", "uiautomator", "dump", dumpFile],
        15_000,
      );
      uiDumpXml = this.emulator.runAdb(
        ["-s", deviceId, "shell", "cat", dumpFile],
        15_000,
      );
      // Clean up temp file on device.
      try {
        this.emulator.runAdb(["-s", deviceId, "shell", "rm", "-f", dumpFile], 5_000);
      } catch {
        // Best-effort cleanup.
      }
      if (!uiDumpXml.includes("<hierarchy")) {
        uiDumpXml = this.emulator.runAdb(
          ["-s", deviceId, "shell", "cat", "/sdcard/window_dump.xml"],
          15_000,
        );
      }
    } catch {
      uiDumpXml = "";
    }
    return uiDumpXml;
  }

  private modelInputDirForSession(sessionId: string): string {
    const dir = path.join(this.config.workspaceDir, "sessions", "model-inputs", `session-${sessionId}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private saveModelInputArtifacts(params: {
    sessionId: string;
    step: number;
    task: string;
    profileModel: string;
    promptMode: SystemPromptMode;
    systemPrompt: string;
    userPrompt: string;
    snapshot: {
      currentApp: string;
      width: number;
      height: number;
      scaledWidth: number;
      scaledHeight: number;
      capturedAt: string;
      screenshotBase64: string;
      somScreenshotBase64: string | null;
      uiElements: unknown[];
    };
    history: string[];
  }): void {
    try {
      const dir = this.modelInputDirForSession(params.sessionId);
      const stepTag = String(params.step).padStart(3, "0");
      const systemPromptPath = path.join(dir, "system-prompt.txt");
      if (!fs.existsSync(systemPromptPath)) {
        fs.writeFileSync(systemPromptPath, `${params.systemPrompt}\n`, "utf-8");
      }
      const userPromptPath = path.join(dir, `step-${stepTag}-user-prompt.txt`);
      fs.writeFileSync(userPromptPath, `${params.userPrompt}\n`, "utf-8");

      const rawPngPath = path.join(dir, `step-${stepTag}-raw.png`);
      fs.writeFileSync(rawPngPath, Buffer.from(params.snapshot.screenshotBase64, "base64"));

      const somPngPath = params.snapshot.somScreenshotBase64
        ? path.join(dir, `step-${stepTag}-som.png`)
        : null;
      if (somPngPath && params.snapshot.somScreenshotBase64) {
        fs.writeFileSync(somPngPath, Buffer.from(params.snapshot.somScreenshotBase64, "base64"));
      }

      const meta = {
        step: params.step,
        task: params.task,
        model: params.profileModel,
        promptMode: params.promptMode,
        systemPromptPath,
        userPromptPath,
        imagePaths: {
          raw: rawPngPath,
          som: somPngPath,
        },
        snapshot: {
          currentApp: params.snapshot.currentApp,
          width: params.snapshot.width,
          height: params.snapshot.height,
          scaledWidth: params.snapshot.scaledWidth,
          scaledHeight: params.snapshot.scaledHeight,
          capturedAt: params.snapshot.capturedAt,
          uiElementsCount: Array.isArray(params.snapshot.uiElements) ? params.snapshot.uiElements.length : 0,
          uiElements: params.snapshot.uiElements,
        },
        historyTail: params.history.slice(-8),
      };
      fs.writeFileSync(
        path.join(dir, `step-${stepTag}-input.json`),
        `${JSON.stringify(meta, null, 2)}\n`,
        "utf-8",
      );
    } catch {
      // Debug artifact persistence is best-effort; do not break task execution.
    }
  }

  private resolveTapElementAction(
    action: AgentAction,
    snapshot: {
      uiElements: Array<{
        id: string;
        text: string;
        contentDesc: string;
        resourceId: string;
        className: string;
        clickable: boolean;
        center: { x: number; y: number };
        scaledCenter: { x: number; y: number };
        bounds: { left: number; top: number; right: number; bottom: number };
        scaledBounds: { left: number; top: number; right: number; bottom: number };
      }>;
    },
  ): AgentAction {
    this.lastResolvedTapElementContext = null;
    if (action.type !== "tap_element") {
      return action;
    }
    const target = snapshot.uiElements.find((item) => item.id === action.elementId);
    if (!target) {
      return {
        type: "wait",
        durationMs: 500,
        reason: `tap_element target not found: ${action.elementId}`,
      };
    }
    const label = target.text || target.contentDesc || target.resourceId || target.className || "(unlabeled)";
    this.lastResolvedTapElementContext = {
      id: target.id,
      label,
      className: target.className,
      clickable: target.clickable,
      center: target.center,
      scaledCenter: target.scaledCenter,
      bounds: target.bounds,
      scaledBounds: target.scaledBounds,
    };
    return {
      type: "tap",
      x: target.scaledCenter.x,
      y: target.scaledCenter.y,
      reason: action.reason
        ? `${action.reason} [resolved:${action.elementId}]`
        : `resolved tap_element ${action.elementId}`,
    };
  }

  private scorePermissionNodeCandidate(node: PermissionDialogNode, approved: boolean): number {
    if (!node.enabled) {
      return 0;
    }

    const combined = this.normalizePermissionUiText(
      [node.text, node.contentDesc].filter(Boolean).join(" "),
    );
    const idNormalized = this.normalizePermissionUiText(node.resourceId);
    const textHints = approved ? PERMISSION_APPROVE_TEXT_HINTS : PERMISSION_DENY_TEXT_HINTS;
    const idHints = approved ? PERMISSION_APPROVE_ID_HINTS : PERMISSION_DENY_ID_HINTS;
    let score = 0;

    for (const hint of textHints) {
      if (combined.includes(hint)) {
        score = Math.max(score, hint === "allow" ? 80 : 120);
      }
    }
    for (const hint of idHints) {
      if (idNormalized.includes(hint)) {
        score = Math.max(score, 90);
      }
    }
    if (!node.clickable && !node.className.toLowerCase().includes("button")) {
      score = Math.max(0, score - 40);
    }
    return score;
  }

  private observeSnapshotState(snapshot: {
    currentApp: string;
    screenshotBase64?: string;
    uiElements?: Array<{
      text: string;
      contentDesc: string;
      resourceId: string;
      className: string;
      clickable: boolean;
      scaledBounds: { left: number; top: number; right: number; bottom: number };
    }>;
  }): SnapshotObservation {
    const uiElements = Array.isArray(snapshot.uiElements) ? snapshot.uiElements : [];
    const tuples = uiElements
      .map((item) => {
        const label = (item.text || item.contentDesc || item.resourceId || item.className || "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          label,
          className: item.className || "",
          clickable: Boolean(item.clickable),
          bounds: item.scaledBounds,
        };
      })
      .sort((a, b) => {
        if (a.bounds.top !== b.bounds.top) return a.bounds.top - b.bounds.top;
        if (a.bounds.left !== b.bounds.left) return a.bounds.left - b.bounds.left;
        return a.label.localeCompare(b.label);
      });

    const labels = tuples
      .map((item) => item.label)
      .filter(Boolean)
      .slice(0, 6);

    const uiHash = (() => {
      if (typeof snapshot.screenshotBase64 === "string" && snapshot.screenshotBase64.trim()) {
        return createHash("sha1")
          .update(Buffer.from(snapshot.screenshotBase64, "base64"))
          .digest("hex")
          .slice(0, 12);
      }
      const hashInput = JSON.stringify({
        app: snapshot.currentApp,
        nodes: tuples.slice(0, 80),
      });
      return createHash("sha1").update(hashInput).digest("hex").slice(0, 12);
    })();
    return {
      app: snapshot.currentApp || "unknown",
      uiHash,
      labels,
    };
  }

  private observeQuickSnapshotState(observation: { currentApp: string; screenshotHash: string }): SnapshotObservation {
    return {
      app: observation.currentApp || "unknown",
      uiHash: observation.screenshotHash || "unknown",
      labels: [],
    };
  }

  private buildStateDeltaLine(before: SnapshotObservation, after: SnapshotObservation, actionType: string): string {
    const changed = before.uiHash !== after.uiHash || before.app !== after.app;
    const note = changed ? "state_changed" : "no_visible_change";
    return [
      `state_delta changed=${changed}`,
      `action=${actionType}`,
      `app=${before.app}->${after.app}`,
      `ui=${before.uiHash}->${after.uiHash}`,
      `labels_before=${JSON.stringify(before.labels)}`,
      `labels_after=${JSON.stringify(after.labels)}`,
      `note=${note}`,
    ].join(" ");
  }

  private computePostActionDelayMs(action: AgentAction, executionResult: string): number {
    const baseDelayMs = Math.max(0, Math.round(this.config.agent.loopDelayMs || 0));
    if (baseDelayMs <= 0 || action.type === "wait") {
      return 0;
    }

    const stateChanged = /state_delta changed=true/i.test(executionResult);
    if (stateChanged) {
      return Math.min(baseDelayMs, 400);
    }

    if (action.type === "shell" || action.type === "keyevent") {
      return Math.min(baseDelayMs, 500);
    }
    return baseDelayMs;
  }

  private pickPermissionDialogNode(
    nodes: PermissionDialogNode[],
    approved: boolean,
  ): PermissionDialogNode | null {
    if (nodes.length === 0) {
      return null;
    }

    const scored = nodes
      .map((node) => ({
        node,
        score: this.scorePermissionNodeCandidate(node, approved),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (approved) {
          if (b.node.right !== a.node.right) {
            return b.node.right - a.node.right;
          }
          return b.node.bottom - a.node.bottom;
        }
        if (a.node.left !== b.node.left) {
          return a.node.left - b.node.left;
        }
        return b.node.bottom - a.node.bottom;
      });

    if (scored.length > 0) {
      return scored[0]?.node ?? null;
    }

    const actionable = nodes.filter(
      (node) => node.enabled && (node.clickable || node.className.toLowerCase().includes("button")),
    );
    if (actionable.length === 0) {
      return null;
    }
    const maxTop = Math.max(...actionable.map((node) => node.top));
    const row = actionable.filter((node) => node.top >= maxTop - 160);
    if (row.length === 0) {
      return null;
    }
    row.sort((a, b) => {
      if (approved) {
        return b.right - a.right;
      }
      return a.left - b.left;
    });
    return row[0] ?? null;
  }

  private resolveDelegationDeviceId(): string {
    const adbLike = this.adb as unknown as {
      resolveDeviceId?: (preferred?: string | null) => string;
    };
    if (typeof adbLike.resolveDeviceId === "function") {
      return adbLike.resolveDeviceId(this.config.agent.deviceId);
    }
    try {
      const status = this.emulator.status();
      if (status.bootedDevices.length > 0) {
        return status.bootedDevices[0];
      }
      if (status.devices.length > 0) {
        return status.devices[0];
      }
    } catch {
      // Ignore status probe failure in tests/mocks.
    }
    return this.config.agent.deviceId || "emulator-5554";
  }

  private isPermissionDialogApp(currentApp: string): boolean {
    const normalized = String(currentApp || "").toLowerCase();
    return AUTO_PERMISSION_DIALOG_PACKAGES.some((token) => normalized.includes(token));
  }

  private async applyPermissionDialogDecision(
    capability: HumanAuthCapability,
    decision: HumanAuthDecision,
    currentApp: string,
    source: "human_auth" | "auto_vm" = "human_auth",
  ): Promise<DelegationApplyResult | null> {
    if (decision.status === "timeout") {
      return null;
    }
    const shouldHandle =
      capability === "permission" || this.isPermissionDialogApp(currentApp);
    if (!shouldHandle) {
      return null;
    }

    const deviceId = this.resolveDelegationDeviceId();
    const uiDumpXml = this.captureUiDumpXml(deviceId);

    const nodes = this.parsePermissionDialogNodes(uiDumpXml);
    const targetNode = this.pickPermissionDialogNode(nodes, decision.approved);
    if (!targetNode) {
      return {
        message: `permission dialog decision recorded (${decision.status}), but no actionable button was detected`,
        templateHint: null,
        action: null,
      };
    }

    const tapX = Math.max(0, Math.round((targetNode.left + targetNode.right) / 2));
    const tapY = Math.max(0, Math.round((targetNode.top + targetNode.bottom) / 2));
    const label =
      targetNode.text.trim() ||
      targetNode.contentDesc.trim() ||
      targetNode.resourceId.trim() ||
      "(unlabeled)";

    const reasonPrefix = source === "auto_vm" ? "auto_vm_permission" : "human_auth_permission";
    const tapAction: AgentAction = {
      type: "tap",
      x: tapX,
      y: tapY,
      reason: decision.approved ? `${reasonPrefix}_approve` : `${reasonPrefix}_reject`,
    };
    await this.adb.executeAction(
      tapAction,
      this.config.agent.deviceId,
    );
    await sleep(300);

    return {
      message: `permission dialog ${decision.approved ? "approve" : "reject"} tapped (${tapX}, ${tapY}) label="${label}"`,
      templateHint: null,
      action: tapAction,
    };
  }

  private async autoApprovePermissionDialog(currentApp: string): Promise<DelegationApplyResult | null> {
    if (!this.isPermissionDialogApp(currentApp)) {
      return null;
    }
    const decision: HumanAuthDecision = {
      requestId: "auto-vm-permission",
      approved: true,
      status: "approved",
      message: "Auto-approved by virtual-device permission policy.",
      decidedAt: nowIso(),
      artifactPath: null,
    };
    return this.applyPermissionDialogDecision(
      "permission",
      decision,
      currentApp,
      "auto_vm",
    );
  }

  private async applyHumanDelegation(
    capability: HumanAuthCapability,
    decision: HumanAuthDecision,
    currentApp: string,
  ): Promise<DelegationApplyResult | null> {
    const messages: string[] = [];
    let templateHint: string | null = null;

    const permissionDecision = await this.applyPermissionDialogDecision(capability, decision, currentApp);
    if (permissionDecision) {
      messages.push(permissionDecision.message);
      if (permissionDecision.templateHint) {
        templateHint = permissionDecision.templateHint;
      }
    }

    if (!decision.approved || !decision.artifactPath) {
      if (
        decision.approved &&
        !decision.artifactPath &&
        capability === "oauth"
      ) {
        const cachedCredentials = this.getCachedOauthCredentials();
        if (cachedCredentials) {
          const reused = await this.applyCredentialDelegation(
            cachedCredentials.username,
            cachedCredentials.password,
          );
          messages.push(reused.message);
          if (reused.templateHint) {
            templateHint = reused.templateHint;
          }
        }
      }
      if (
        decision.approved &&
        !decision.artifactPath &&
        (capability === "sms" || capability === "2fa" || capability === "qr" || capability === "voice")
      ) {
        const fallbackText = this.extractDelegatedTextFromDecisionMessage(decision.message);
        if (fallbackText) {
          const typed = await this.applyTextDelegation(fallbackText);
          messages.push(typed.message);
          if (typed.templateHint) {
            templateHint = typed.templateHint;
          }
        }
      }
      if (messages.length === 0) {
        return null;
      }
      return {
        message: messages.join(" ; "),
        templateHint,
      };
    }
    if (!fs.existsSync(decision.artifactPath)) {
      messages.push(`delegation artifact not found: ${decision.artifactPath}`);
      return {
        message: messages.join(" ; "),
        templateHint,
      };
    }

    try {
      const artifactJson = this.readJsonArtifact(decision.artifactPath);
      // Immediately delete credential artifacts from disk to avoid plaintext password lingering.
      if (artifactJson?.kind === "credentials") {
        try {
          fs.unlinkSync(decision.artifactPath);
        } catch {
          // Best-effort cleanup; file may already be removed.
        }
      }
      let artifactResult: DelegationApplyResult | null = null;

      if (capability === "location") {
        const geo = this.extractDelegatedGeo(artifactJson);
        if (geo) {
          artifactResult = await this.applyLocationDelegation(geo.lat, geo.lon);
        }
      }

      // Credential delegation: match by oauth capability OR by artifact kind=credentials.
      if (!artifactResult && (capability === "oauth" || artifactJson?.kind === "credentials")) {
        const credentials = this.extractDelegatedCredentials(artifactJson);
        if (credentials) {
          artifactResult = await this.applyCredentialDelegation(credentials.username, credentials.password);
        }
      }

      if (!artifactResult && (capability === "sms" || capability === "2fa" || capability === "qr" || capability === "voice")) {
        const text = this.extractDelegatedText(artifactJson);
        if (text) {
          artifactResult = await this.applyTextDelegation(text);
        }
      }

      if (!artifactResult && (artifactJson?.kind === "text" || artifactJson?.kind === "qr_text")) {
        const text = this.extractDelegatedText(artifactJson);
        if (text) {
          artifactResult = await this.applyTextDelegation(text);
        }
      }

      if (!artifactResult && this.isImageArtifactPath(decision.artifactPath)) {
        artifactResult = await this.applyImageDelegation(decision.artifactPath);
      }

      if (!artifactResult) {
        artifactResult = {
          message: `delegation artifact stored at ${decision.artifactPath}`,
          templateHint: null,
        };
      }
      messages.push(artifactResult.message);
      if (artifactResult.templateHint) {
        templateHint = artifactResult.templateHint;
      }
      return {
        message: messages.join(" ; "),
        templateHint,
      };
    } catch (error) {
      messages.push(`delegation apply failed: ${(error as Error).message}`);
      return {
        message: messages.join(" ; "),
        templateHint,
      };
    }
  }

  // =========================================================================
  // Phone-use tool execution — called from AgentTool.execute closures
  // =========================================================================

  /** Execute a phone-use action and return a text result string.
   *  Handles coordinate scaling, tap_element resolution, state delta, etc. */
  private async executePhoneAction(
    action: AgentAction,
    ctx: PhoneAgentRunContext,
  ): Promise<string> {
    const snapshot = ctx.latestSnapshot!;

    // Resolve tap_element to coordinates
    action = this.resolveTapElementAction(action, snapshot);

    // Debug screenshot overlay before scaling
    if (
      this.config.screenshots.saveStepScreenshots &&
      (action.type === "tap" || action.type === "swipe")
    ) {
      try {
        const buf = Buffer.from(snapshot.screenshotBase64, "base64");
        const annotated = await drawDebugMarker(buf, action);
        this.screenshotStore.save(annotated, {
          sessionId: ctx.session.id,
          step: ctx.stepCount,
          currentApp: `${snapshot.currentApp}-debug`,
        });
      } catch { /* best-effort */ }
    }

    // Scale coordinates back to device resolution
    if (action.type === "tap") {
      const s = scaleCoordinates(action.x, action.y, snapshot.scaleX, snapshot.scaleY, snapshot.width, snapshot.height);
      action = { ...action, x: s.x, y: s.y };
    } else if (action.type === "swipe") {
      const p1 = scaleCoordinates(action.x1, action.y1, snapshot.scaleX, snapshot.scaleY, snapshot.width, snapshot.height);
      const p2 = scaleCoordinates(action.x2, action.y2, snapshot.scaleX, snapshot.scaleY, snapshot.width, snapshot.height);
      action = { ...action, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }

    let executionResult = "";
    let stateDeltaLine = "";
    try {
      if (action.type === "run_script") {
        const sr = await this.scriptExecutor.execute(action.script, action.timeoutSec);
        executionResult = [
          `run_script exitCode=${sr.exitCode} timedOut=${sr.timedOut}`,
          `runDir=${sr.runDir}`,
          sr.stdout ? `stdout=${sr.stdout}` : "",
          sr.stderr ? `stderr=${sr.stderr}` : "",
        ].filter(Boolean).join("\n");
      } else if (["read", "write", "edit", "apply_patch", "exec", "process"].includes(action.type)) {
        executionResult = await this.codingExecutor.execute(action);
      } else if (action.type === "memory_search" || action.type === "memory_get") {
        executionResult = this.memoryExecutor.execute(action);
      } else {
        executionResult = await this.adb.executeAction(action, this.config.agent.deviceId);
      }
      // State delta observation
      const deltaTypes = new Set(["tap", "swipe", "type", "keyevent", "launch_app", "shell"]);
      if (deltaTypes.has(action.type)) {
        try {
          const before = this.observeSnapshotState(snapshot);
          const adbWithQuickObservation = this.adb as AdbRuntime & {
            captureQuickObservation?: (
              preferred?: string | null,
              modelName?: string,
            ) => Promise<{ currentApp: string; screenshotHash: string }>;
          };
          let afterState: SnapshotObservation;
          if (typeof adbWithQuickObservation.captureQuickObservation === "function") {
            const quick = await adbWithQuickObservation.captureQuickObservation(
              this.config.agent.deviceId,
              ctx.profile.model,
            );
            afterState = this.observeQuickSnapshotState(quick);
          } else {
            const after = await this.adb.captureScreenSnapshot(this.config.agent.deviceId, ctx.profile.model);
            afterState = this.observeSnapshotState(after);
          }
          stateDeltaLine = this.buildStateDeltaLine(before, afterState, action.type);
        } catch { /* best-effort */ }
      }
    } catch (error) {
      executionResult = `Action execution error: ${(error as Error).message}`;
    }

    if (this.lastResolvedTapElementContext) {
      const m = this.lastResolvedTapElementContext;
      executionResult += `\ntap_mark id=${m.id} label=${JSON.stringify(m.label)} class=${m.className || "unknown"} clickable=${m.clickable} center=(${m.center.x},${m.center.y}) scaled_center=(${m.scaledCenter.x},${m.scaledCenter.y})`;
    }
    if (stateDeltaLine) {
      executionResult += `\n${stateDeltaLine}`;
    }
    return executionResult;
  }

  // =========================================================================
  // Build AgentTool[] for pi-agent-core Agent
  // =========================================================================

  private buildPhoneAgentTools(
    ctx: PhoneAgentRunContext,
    runtime: AgentRuntime,
    toolMetas: ToolMeta[] = TOOL_METAS,
  ): AgentTool<any>[] {
    const tools: AgentTool<any>[] = [];

    for (const meta of toolMetas) {
      const toolName = meta.name;
      tools.push({
        name: meta.name,
        label: meta.name,
        description: meta.description,
        parameters: meta.parameters,
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          if (ctx.finishMessage || ctx.failMessage || ctx.stopRequested()) {
            const skipMsg = ctx.finishMessage
              ? "Run already finished; skipping extra tool call."
              : ctx.failMessage
                ? `Run already failed; skipping extra tool call: ${ctx.failMessage}`
                : "Stop requested; skipping extra tool call.";
            return { content: [{ type: "text" as const, text: skipMsg }], details: { skipped: true } };
          }
          if (ctx.stepCount >= ctx.maxSteps) {
            ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
            return { content: [{ type: "text" as const, text: ctx.failMessage }], details: { skipped: true } };
          }

          const thought = typeof params.thought === "string" ? params.thought : "";
          const actionType = toolNameToActionType(toolName);
          const { thought: _t, ...actionArgs } = params;
          const action: AgentAction = normalizeAction({ type: actionType, ...actionArgs });
          ctx.stepCount += 1;
          const step = ctx.stepCount;
          const snapshot = ctx.latestSnapshot;
          const stepStartedAtMs = Date.now();
          const stepStartedAtHr = process.hrtime.bigint();
          const stepStartedAt = nowIso();
          const buildStepTrace = (
            currentApp: string,
            status: "ok" | "error" = "ok",
          ) => {
            const endedAt = nowIso();
            const elapsedNs = process.hrtime.bigint() - stepStartedAtHr;
            let durationMs = Number(elapsedNs / 1_000_000n);
            if (elapsedNs > 0n && durationMs === 0) {
              durationMs = 1;
            }
            if (!Number.isFinite(durationMs) || durationMs < 0) {
              durationMs = Math.max(0, Date.parse(endedAt) - stepStartedAtMs);
            }
            return {
              actionType: action.type,
              currentApp,
              startedAt: stepStartedAt,
              endedAt,
              durationMs,
              status,
            };
          };

          if (!snapshot && action.type !== "finish") {
            const msg = "No screen snapshot available for tool execution.";
            ctx.failMessage = msg;
            runtime.workspace.appendStep(
              ctx.session,
              step,
              thought,
              JSON.stringify(action, null, 2),
              msg,
              buildStepTrace("unknown", "error"),
            );
            ctx.traces.push({ step, action, result: msg, thought, currentApp: "unknown" });
            return { content: [{ type: "text" as const, text: msg }], details: {} };
          }

            // eslint-disable-next-line no-console
          console.log(`[OpenPocket][step ${step}] tool=${toolName} action=${action.type}`);

          // ---- finish ----
          if (action.type === "finish") {
            ctx.finishMessage = action.message || "Task completed.";
            const resultText = `FINISH: ${ctx.finishMessage}`;
            runtime.workspace.appendStep(
              ctx.session,
              step,
              thought,
              JSON.stringify(action, null, 2),
              resultText,
              buildStepTrace(snapshot?.currentApp ?? "unknown", "ok"),
            );
            ctx.traces.push({ step, action, result: resultText, thought, currentApp: snapshot?.currentApp ?? "unknown" });
            ctx.history.push(`step ${step}: action=finish message=${ctx.finishMessage}`);
            return { content: [{ type: "text" as const, text: resultText }], details: {} };
          }

          // ---- request_human_auth ----
          if (action.type === "request_human_auth") {
            const permOnly = action.capability === "permission";
            const onVmDialog = snapshot ? runtime.isPermissionDialogApp(snapshot.currentApp) : false;
            const currentApp = snapshot?.currentApp ?? "unknown";

            // Auto-approve VM permission dialogs
            if (onVmDialog || permOnly) {
              if (onVmDialog) {
                const auto = await runtime.autoApprovePermissionDialog(snapshot!.currentApp);
                if (auto?.action?.type === "tap") ctx.lastAutoPermissionAllowAtMs = Date.now();
              }
              if (permOnly) {
                const msg = "permission auto-approved locally (VM policy)";
                runtime.workspace.appendStep(
                  ctx.session,
                  step,
                  thought,
                  JSON.stringify(action, null, 2),
                  msg,
                  buildStepTrace(snapshot?.currentApp ?? "unknown", "ok"),
                );
                ctx.traces.push({ step, action, result: msg, thought, currentApp: snapshot?.currentApp ?? "unknown" });
                ctx.history.push(`step ${step}: action=request_human_auth(permission) auto_approved`);
                return { content: [{ type: "text" as const, text: msg }], details: {} };
              }
            }

            // Reuse cached oauth credentials on split Google sign-in pages.
            // If password is already cached from previous step, skip a second human-auth prompt.
            if (action.capability === "oauth") {
              const cachedOauth = runtime.getCachedOauthCredentials();
              if (cachedOauth?.password) {
                const syntheticDecision: HumanAuthDecision = {
                  requestId: "oauth-cached",
                  approved: true,
                  status: "approved",
                  message: "Approved using cached oauth credentials from prior step.",
                  decidedAt: nowIso(),
                  artifactPath: null,
                };
                const delegation = await runtime.applyHumanDelegation("oauth", syntheticDecision, currentApp);
                const delegationTemplate = delegation?.templateHint ?? null;
                const resultText = [
                  `Human auth ${syntheticDecision.status}: ${syntheticDecision.message}`,
                  delegation?.message ? `delegation=${delegation.message}` : "",
                  delegationTemplate ? `delegation_template=${delegationTemplate}` : "",
                ].filter(Boolean).join("\n");
                runtime.workspace.appendStep(
                  ctx.session,
                  step,
                  thought,
                  JSON.stringify(action, null, 2),
                  resultText,
                  buildStepTrace(currentApp, "ok"),
                );
                ctx.traces.push({ step, action, result: resultText, thought, currentApp });
                ctx.history.push("step " + step + ": action=request_human_auth decision=approved(cached_oauth)");
                if (delegationTemplate) {
                  ctx.history.push(`delegation_template ${delegationTemplate}`);
                }
                return { content: [{ type: "text" as const, text: resultText }], details: {} };
              }
            }

            if (!ctx.onHumanAuth) {
              const msg = `Human authorization required (${action.capability}), but no handler configured.`;
              ctx.failMessage = msg;
              runtime.workspace.appendStep(
                ctx.session,
                step,
                thought,
                JSON.stringify(action, null, 2),
                msg,
                buildStepTrace(currentApp, "error"),
              );
              ctx.traces.push({ step, action, result: msg, thought, currentApp });
              return { content: [{ type: "text" as const, text: msg }], details: {} };
            }

            let decision: HumanAuthDecision;
            try {
              const requestedTimeoutSec = Number(
                action.timeoutSec ?? runtime.config.humanAuth.requestTimeoutSec,
              );
              const timeoutCapSec = Math.max(30, Math.round(runtime.config.humanAuth.requestTimeoutSec));
              const timeoutSec = Math.min(
                timeoutCapSec,
                Math.max(30, Math.round(Number.isFinite(requestedTimeoutSec) ? requestedTimeoutSec : timeoutCapSec)),
              );
              decision = await ctx.onHumanAuth({
                sessionId: ctx.session.id, sessionPath: ctx.session.path, task: ctx.task, step,
                capability: action.capability, instruction: action.instruction,
                reason: action.reason ?? thought,
                timeoutSec,
                currentApp, screenshotPath: ctx.lastScreenshotPath,
              });
            } catch (error) {
              decision = { requestId: "local-error", approved: false, status: "rejected", message: `Human auth error: ${(error as Error).message}`, decidedAt: nowIso(), artifactPath: null };
            }

            const delegation = await runtime.applyHumanDelegation(action.capability, decision, currentApp);
            const delegationTemplate = delegation?.templateHint ?? null;
            const resultText = [
              `Human auth ${decision.status}: ${decision.message}`,
              decision.artifactPath ? `human_artifact=${decision.artifactPath}` : "",
              delegation?.message ? `delegation=${delegation.message}` : "",
              delegationTemplate ? `delegation_template=${delegationTemplate}` : "",
            ].filter(Boolean).join("\n");
            runtime.workspace.appendStep(
              ctx.session,
              step,
              thought,
              JSON.stringify(action, null, 2),
              resultText,
              buildStepTrace(currentApp, decision.approved ? "ok" : "error"),
            );
            ctx.traces.push({ step, action, result: resultText, thought, currentApp });
            ctx.history.push(`step ${step}: action=request_human_auth decision=${decision.status}`);
            if (delegationTemplate) {
              ctx.history.push(`delegation_template ${delegationTemplate}`);
            }

            if (!decision.approved) {
              ctx.failMessage = `Human authorization ${decision.status}: ${decision.message}`;
            }
            return { content: [{ type: "text" as const, text: resultText }], details: {} };
          }

          // ---- request_user_decision ----
          if (action.type === "request_user_decision") {
            if (!ctx.onUserDecision) {
              const msg = "User decision required, but no handler configured.";
              ctx.failMessage = msg;
              runtime.workspace.appendStep(
                ctx.session,
                step,
                thought,
                JSON.stringify(action, null, 2),
                msg,
                buildStepTrace(snapshot?.currentApp ?? "unknown", "error"),
              );
              ctx.traces.push({ step, action, result: msg, thought, currentApp: snapshot?.currentApp ?? "unknown" });
              return { content: [{ type: "text" as const, text: msg }], details: {} };
            }
            let decision: UserDecisionResponse;
            try {
              decision = await ctx.onUserDecision({
                sessionId: ctx.session.id, sessionPath: ctx.session.path, task: ctx.task, step,
                question: action.question, options: action.options,
                timeoutSec: Math.max(20, action.timeoutSec ?? 300),
                currentApp: snapshot?.currentApp ?? "unknown", screenshotPath: ctx.lastScreenshotPath,
              });
            } catch (error) {
              const msg = `User decision failed: ${(error as Error).message}`;
              ctx.failMessage = msg;
              runtime.workspace.appendStep(
                ctx.session,
                step,
                thought,
                JSON.stringify(action, null, 2),
                msg,
                buildStepTrace(snapshot?.currentApp ?? "unknown", "error"),
              );
              ctx.traces.push({ step, action, result: msg, thought, currentApp: snapshot?.currentApp ?? "unknown" });
              return { content: [{ type: "text" as const, text: msg }], details: {} };
            }
            const normalizedSelected = String(decision.selectedOption || "").trim();
            const matchedOption = action.options.find(
              (item) => item.trim().toLowerCase() === normalizedSelected.toLowerCase(),
            );
            const selectedForLog = matchedOption || "[custom-input]";
            const selectedSource = matchedOption ? "listed_option" : "custom_input";
            const resultText =
              `user_decision selected="${selectedForLog}" source=${selectedSource} input_len=${String(decision.rawInput || "").length} at=${decision.resolvedAt}`;
            runtime.workspace.appendStep(
              ctx.session,
              step,
              thought,
              JSON.stringify(action, null, 2),
              resultText,
              buildStepTrace(snapshot?.currentApp ?? "unknown", "ok"),
            );
            ctx.traces.push({ step, action, result: resultText, thought, currentApp: snapshot?.currentApp ?? "unknown" });
            ctx.history.push(`step ${step}: action=request_user_decision selected=${selectedForLog}`);
            return { content: [{ type: "text" as const, text: resultText }], details: {} };
          }

          // ---- request_user_input ----
          if (action.type === "request_user_input") {
            if (!ctx.onUserInput) {
              const msg = "User input required, but no handler configured.";
              ctx.failMessage = msg;
              runtime.workspace.appendStep(
                ctx.session,
                step,
                thought,
                JSON.stringify(action, null, 2),
                msg,
                buildStepTrace(snapshot?.currentApp ?? "unknown", "error"),
              );
              ctx.traces.push({ step, action, result: msg, thought, currentApp: snapshot?.currentApp ?? "unknown" });
              return { content: [{ type: "text" as const, text: msg }], details: {} };
            }
            let response: UserInputResponse;
            try {
              response = await ctx.onUserInput({
                sessionId: ctx.session.id,
                sessionPath: ctx.session.path,
                task: ctx.task,
                step,
                question: action.question,
                placeholder: action.placeholder,
                timeoutSec: Math.max(20, action.timeoutSec ?? 300),
                currentApp: snapshot?.currentApp ?? "unknown",
                screenshotPath: ctx.lastScreenshotPath,
              });
            } catch (error) {
              const msg = `User input failed: ${(error as Error).message}`;
              ctx.failMessage = msg;
              runtime.workspace.appendStep(
                ctx.session,
                step,
                thought,
                JSON.stringify(action, null, 2),
                msg,
                buildStepTrace(snapshot?.currentApp ?? "unknown", "error"),
              );
              ctx.traces.push({ step, action, result: msg, thought, currentApp: snapshot?.currentApp ?? "unknown" });
              return { content: [{ type: "text" as const, text: msg }], details: {} };
            }
            const text = typeof response.text === "string" ? response.text : String(response.text ?? "");
            const resolvedAt = typeof response.resolvedAt === "string" && response.resolvedAt.trim()
              ? response.resolvedAt.trim()
              : nowIso();
            const logResultText = `user_input input_len=${text.length} at=${resolvedAt}`;
            const modelResultText = `user_input value=${JSON.stringify(text)} input_len=${text.length} at=${resolvedAt}`;
            runtime.workspace.appendStep(
              ctx.session,
              step,
              thought,
              JSON.stringify(action, null, 2),
              logResultText,
              buildStepTrace(snapshot?.currentApp ?? "unknown", "ok"),
            );
            ctx.traces.push({ step, action, result: logResultText, thought, currentApp: snapshot?.currentApp ?? "unknown" });
            ctx.history.push(`step ${step}: action=request_user_input input_len=${text.length}`);
            return { content: [{ type: "text" as const, text: modelResultText }], details: {} };
          }

          // ---- wait ----
          if (action.type === "wait") {
            const ms = action.durationMs ?? 1000;
            await sleep(ms);
            const resultText = `Waited ${ms}ms`;
            runtime.workspace.appendStep(
              ctx.session,
              step,
              thought,
              JSON.stringify(action, null, 2),
              resultText,
              buildStepTrace(snapshot?.currentApp ?? "unknown", "ok"),
            );
            ctx.traces.push({ step, action, result: resultText, thought, currentApp: snapshot?.currentApp ?? "unknown" });
            ctx.history.push(`step ${step}: action=wait duration=${ms}`);
            return { content: [{ type: "text" as const, text: resultText }], details: {} };
          }

          // ---- all other actions (tap, swipe, type, keyevent, launch_app, shell, run_script, read, write, edit, etc.) ----
          const executionResult = await runtime.executePhoneAction(action, ctx);
          const stepResult = ctx.lastScreenshotPath
            ? `${executionResult}\nlocal_screenshot=${ctx.lastScreenshotPath}`
            : executionResult;

          runtime.workspace.appendStep(
            ctx.session,
            step,
            thought,
            JSON.stringify(action, null, 2),
            stepResult,
            buildStepTrace(
              snapshot?.currentApp ?? "unknown",
              /action execution error:/i.test(executionResult) ? "error" : "ok",
            ),
          );
          ctx.traces.push({ step, action, result: stepResult, thought, currentApp: snapshot?.currentApp ?? "unknown" });
          ctx.history.push(`step ${step}: app=${snapshot?.currentApp ?? "unknown"} action=${action.type} result=${executionResult}`);

          if (runtime.config.agent.verbose) {
            // eslint-disable-next-line no-console
            console.log(`[OpenPocket][step ${step}] ${action.type}: ${executionResult}`);
          }

          // Progress callback
          if (ctx.onProgress && step % runtime.config.agent.progressReportInterval === 0) {
            try {
              await ctx.onProgress({
                step, maxSteps: ctx.maxSteps, currentApp: snapshot?.currentApp ?? "unknown",
                actionType: action.type, message: executionResult, thought, screenshotPath: ctx.lastScreenshotPath,
              });
            } catch { /* best-effort */ }
          }

          // Post-action delay (except wait which already slept)
          const postActionDelayMs = runtime.computePostActionDelayMs(action, executionResult);
          if (postActionDelayMs > 0) {
            await sleep(postActionDelayMs);
          }

          return { content: [{ type: "text" as const, text: stepResult }], details: {} };
        },
      });
    }
    return tools;
  }

  private shouldEnableWorkspaceToolsForTask(task: string): boolean {
    const normalized = String(task || "").toLowerCase();
    if (!normalized.trim()) {
      return false;
    }
    const keywordHints = [
      "code",
      "coding",
      "repo",
      "repository",
      "git",
      "commit",
      "branch",
      "pull request",
      "pr ",
      "file",
      "files",
      "folder",
      "directory",
      "workspace",
      "patch",
      "apply_patch",
      "read ",
      "write ",
      "edit ",
      "grep",
      "sed",
      "awk",
      "npm",
      "pnpm",
      "yarn",
      "tsc",
      "eslint",
      "prettier",
      "test",
      "lint",
      "build",
      "script",
      "shell command",
      "terminal",
      "agents.md",
      "identity.md",
      "user.md",
      "tools.md",
      "memory.md",
      "代码",
      "仓库",
      "分支",
      "提交",
      "文件",
      "目录",
      "工作区",
      "补丁",
      "脚本",
      "终端",
      "命令行",
      "读取",
      "写入",
      "编辑",
      "搜索文件",
      "构建",
      "测试",
      "格式化",
      "记忆",
      "历史记录",
    ];
    return keywordHints.some((hint) => normalized.includes(hint));
  }

  private resolveToolMetasForTask(task: string, allowSkillRead = false): ToolMeta[] {
    const workspaceToolsAllowed = this.shouldEnableWorkspaceToolsForTask(task);
    return TOOL_METAS.filter((meta) => {
      if (CODING_TOOL_NAMES.has(meta.name)) {
        if (!this.config.codingTools.enabled) {
          return false;
        }
        if (meta.name === "read") {
          return workspaceToolsAllowed || allowSkillRead;
        }
        return workspaceToolsAllowed;
      }
      if (MEMORY_TOOL_NAMES.has(meta.name)) {
        if (!this.config.memoryTools.enabled) {
          return false;
        }
        return workspaceToolsAllowed;
      }
      if (WORKSPACE_TOOL_NAMES.has(meta.name)) {
        return workspaceToolsAllowed;
      }
      if (meta.name === "run_script" && !this.config.scriptExecutor.enabled) {
        return false;
      }
      return true;
    });
  }

  private parseToolFallbackLiteral(raw: string): unknown {
    const value = raw.trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const inner = value.slice(1, -1);
      return inner
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, "\"")
        .replace(/\\'/g, "'")
        .replace(/\\n/g, "\n");
    }
    if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
      return Number(value);
    }
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    return value;
  }

  private collectAssistantText(message: PiAssistantMessage): string {
    const chunks: string[] = [];
    if (!Array.isArray(message.content)) {
      return "";
    }
    for (const item of message.content) {
      if (
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        chunks.push((item as { text: string }).text);
        continue;
      }
      if (
        item &&
        typeof item === "object" &&
        "content" in item &&
        typeof (item as { content?: unknown }).content === "string"
      ) {
        chunks.push((item as { content: string }).content);
        continue;
      }
      if (
        item &&
        typeof item === "object" &&
        "thinking" in item &&
        typeof (item as { thinking?: unknown }).thinking === "string"
      ) {
        chunks.push((item as { thinking: string }).thinking);
      }
    }
    return chunks.join("\n").trim();
  }

  private normalizeTextFallbackToolName(name: string): string | null {
    const normalized = name.trim().toLowerCase();
    if (TOOL_METAS.some((meta) => meta.name === normalized)) {
      return normalized;
    }
    if (normalized === "type") {
      return "type_text";
    }
    return ACTION_TYPE_TO_TOOL_NAME.get(normalized) ?? null;
  }

  private parseTextFallbackFromJson(text: string): { toolName: string; params: Record<string, unknown> } | null {
    const candidates: string[] = [];
    const fencedRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fencedMatch: RegExpExecArray | null;
    while ((fencedMatch = fencedRe.exec(text)) !== null) {
      if (fencedMatch[1]) {
        candidates.push(fencedMatch[1]);
      }
    }
    candidates.push(text);
    for (const candidate of candidates) {
      const trimmed = candidate.trim();
      if (!trimmed.includes("{") || !trimmed.includes("}")) {
        continue;
      }
      const firstBrace = trimmed.indexOf("{");
      const lastBrace = trimmed.lastIndexOf("}");
      if (firstBrace < 0 || lastBrace <= firstBrace) {
        continue;
      }
      const jsonSlice = trimmed.slice(firstBrace, lastBrace + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonSlice);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const actionRecord = parsed as Record<string, unknown>;
      if (typeof actionRecord.type !== "string") {
        continue;
      }
      const normalizedAction = normalizeAction(actionRecord);
      const toolName = ACTION_TYPE_TO_TOOL_NAME.get(normalizedAction.type);
      if (!toolName) {
        continue;
      }
      const { type: _ignoreType, ...actionArgs } = normalizedAction as Record<string, unknown> & { type: string };
      const thought =
        typeof actionRecord.thought === "string" && actionRecord.thought.trim()
          ? actionRecord.thought
          : "Parsed textual action fallback";
      return {
        toolName,
        params: { thought, ...actionArgs },
      };
    }
    return null;
  }

  private parseTextFallbackFromFunction(text: string): { toolName: string; params: Record<string, unknown> } | null {
    const candidates = [
      text.trim(),
      ...text.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean),
    ];
    const argRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[+-]?\d+(?:\.\d+)?|true|false|null)/g;
    for (const candidate of candidates) {
      const fnMatch = candidate.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
      if (!fnMatch) {
        continue;
      }
      const toolName = this.normalizeTextFallbackToolName(fnMatch[1]);
      if (!toolName) {
        continue;
      }
      const args: Record<string, unknown> = { thought: "Parsed textual tool call fallback" };
      const callStart = (fnMatch.index ?? 0) + fnMatch[0].length;
      const argText = candidate.slice(callStart);
      let match: RegExpExecArray | null;
      while ((match = argRe.exec(argText)) !== null) {
        args[match[1]] = this.parseToolFallbackLiteral(match[2]);
      }
      if (toolName === "finish" && typeof args.message !== "string") {
        const quoted = argText.match(/["']([^"']{0,200})/);
        args.message = quoted?.[1] ?? "Task completed.";
      }
      return { toolName, params: args };
    }
    return null;
  }

  private extractFinishMessageHint(text: string): string | null {
    const directMessage = text.match(/message\s*[:=]?\s*["']([^"'\n]{1,200})["']/i);
    if (directMessage?.[1]) {
      return directMessage[1].trim();
    }
    const finishQuoted = text.match(/finish[\s\S]{0,120}?["']([^"'\n]{1,200})["']/i);
    if (finishQuoted?.[1]) {
      return finishQuoted[1].trim();
    }
    return null;
  }

  private parseNarrativeFinishFallback(
    text: string,
    task?: string,
  ): { toolName: string; params: Record<string, unknown> } | null {
    const finishIntentRe =
      /\b(call\s+finish|should\s+finish|finish\s+the\s+task|complete\s+the\s+task|end\s+the\s+task)\b|完成任务|结束任务|应该结束|应当结束/i;
    if (!finishIntentRe.test(text)) {
      return null;
    }
    const message = this.extractFinishMessageHint(text)
      ?? this.extractFinishMessageHint(task ?? "")
      ?? "Task completed.";
    return {
      toolName: "finish",
      params: {
        thought: "Parsed narrative finish fallback",
        message,
      },
    };
  }

  private parseTextualToolFallback(
    message: PiAssistantMessage,
    task?: string,
  ): { toolName: string; params: Record<string, unknown> } | null {
    const text = this.collectAssistantText(message);
    if (!text) {
      return null;
    }
    const jsonFallback = this.parseTextFallbackFromJson(text);
    if (jsonFallback) {
      return jsonFallback;
    }
    const functionFallback = this.parseTextFallbackFromFunction(text);
    if (functionFallback) {
      return functionFallback;
    }
    return this.parseNarrativeFinishFallback(text, task);
  }

  // =========================================================================
  // runTask — powered by pi-agent-core Agent class
  // =========================================================================

  async runTask(
    task: string,
    modelName?: string,
    onProgress?: (update: AgentProgressUpdate) => Promise<void> | void,
    onHumanAuth?: (request: HumanAuthRequest) => Promise<HumanAuthDecision> | HumanAuthDecision,
    promptMode?: "full" | "minimal" | "none",
    onUserDecision?: (request: UserDecisionRequest) => Promise<UserDecisionResponse> | UserDecisionResponse,
    sessionKey?: string,
    onUserInput?: (request: UserInputRequest) => Promise<UserInputResponse> | UserInputResponse,
  ): Promise<AgentRunResult> {
    const hasSkillMatch = this.skillLoader.buildPromptContextForTask(task, {
      maxSummaryItems: 1,
      maxActiveSkills: 1,
      maxActiveSkillChars: 600,
      maxActiveTotalChars: 800,
    }).activeEntries.length > 0;
    const activeToolNames = this.resolveToolMetasForTask(task, hasSkillMatch).map((item) => item.name);
    const request: RunTaskRequest = {
      task,
      modelName,
      sessionKey,
      onProgress,
      onHumanAuth,
      promptMode,
      onUserDecision,
      availableToolNames: activeToolNames,
      onUserInput,
    };

    return runRuntimeTask(
      {
        isBusy: () => this.busy,
        beginRun: (activeTask) => {
          this.busy = true;
          this.stopRequested = false;
          this.currentTask = activeTask;
          this.currentTaskStartedAtMs = Date.now();
        },
        executeAttempt: async (attemptRequest) => runRuntimeAttempt(
          {
            config: this.config,
            workspace: this.workspace,
            adb: this.adb,
            skillLoader: this.skillLoader,
            autoArtifactBuilder: this.autoArtifactBuilder,
            screenshotStore: this.screenshotStore,
            agentFactory: this.agentFactory,
            getStopRequested: () => this.stopRequested,
            buildWorkspacePromptContext: () => this.buildWorkspacePromptContext(),
            buildSystemPromptReport: (params) => this.buildSystemPromptReport(params as {
              source: "estimate" | "run";
              promptMode: SystemPromptMode;
              systemPrompt: string;
              skillsSummary: string;
              activeSkillsPrompt?: string;
              activeSkillsEntries?: Array<{
                name: string;
                source: "workspace" | "local" | "bundled";
                path: string;
                reason: string;
                score: number;
                blockChars: number;
                truncated: boolean;
              }>;
              workspaceReport: WorkspacePromptContextReport;
            }),
            setLastSystemPromptReport: (report) => {
              this.lastSystemPromptReport = report as WorkspacePromptContextReport;
            },
            buildPhoneAgentTools: (ctx, availableToolNames) => {
              const toolMetas = Array.isArray(availableToolNames) && availableToolNames.length > 0
                ? TOOL_METAS.filter((meta) => availableToolNames.includes(meta.name))
                : TOOL_METAS;
              return this.buildPhoneAgentTools(ctx, this, toolMetas);
            },
            parseTextualToolFallback: (message, fallbackTask) => this.parseTextualToolFallback(message, fallbackTask),
            isPermissionDialogApp: (currentApp) => this.isPermissionDialogApp(currentApp),
            autoApprovePermissionDialog: (currentApp) => this.autoApprovePermissionDialog(currentApp),
            saveModelInputArtifacts: (params) => this.saveModelInputArtifacts(params),
          },
          attemptRequest,
        ),
        finalizeRun: async (shouldReturnHome) => {
          if (shouldReturnHome) {
            await this.safeReturnToHome();
          }
          this.clearCachedOauthCredentials();
          this.busy = false;
          this.currentTask = null;
          this.currentTaskStartedAtMs = null;
          this.stopRequested = false;
        },
      },
      request,
    );
  }
}
