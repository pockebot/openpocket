import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type {
  AgentProgressUpdate,
  AgentRunResult,
  AgentAction,
  BatchableAgentAction,
  ChannelMediaDeliveryResult,
  ChannelMediaRequest,
  CronTaskPlan,
  HumanAuthDecision,
  HumanAuthCapability,
  HumanAuthRequest,
  HumanAuthUiField,
  HumanAuthUiTemplate,
  UserDecisionRequest,
  UserDecisionResponse,
  UserInputRequest,
  UserInputResponse,
  TaskExecutionPlan,
  OpenPocketConfig,
  ModelProfile,
  SkillInfo,
  ScreenSnapshot,
} from "../types.js";
import { getModelProfile, resolveModelAuth } from "../config/index.js";
import { WorkspaceStore } from "../memory/workspace.js";
import { ScreenshotStore } from "../memory/screenshot-store.js";
import { sleep } from "../utils/time.js";
import { ensureDir, nowIso } from "../utils/paths.js";
import { AdbRuntime } from "../device/adb-runtime.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import { AutoArtifactBuilder, type StepTrace } from "../skills/auto-artifact-builder.js";
import { SkillLoader } from "../skills/skill-loader.js";
import { ScriptExecutor } from "../tools/script-executor.js";
import { CodingExecutor, LEGACY_CODING_EXECUTOR_DEPRECATION } from "../tools/coding-executor.js";
import { MemoryExecutor } from "../tools/memory-executor.js";
import { PiCodingToolsExecutor } from "./pi-coding-tools.js";
import { CronRegistry } from "../gateway/cron-registry.js";
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
import {
  appendTaskJournalSnapshot,
  readLatestTaskJournalSnapshot,
  type TaskJournalSnapshot,
} from "./journal/task-journal-store.js";
import { runRuntimeAttempt } from "./runtime/attempt.js";
import { runRuntimeTask } from "./runtime/run.js";
import type { RunTaskRequest } from "./runtime/types.js";
import { createPiSessionBridge } from "./pi-session-bridge.js";
import { scaleCoordinates, drawDebugMarker } from "../utils/image-scale.js";
import {
  PhoneUseCapabilityProbe,
  inferPaymentFieldSemantic,
  parsePaymentArtifactKey,
  type CapabilityProbeEvent,
  type PaymentFieldSemantic,
} from "../phone-use-util/index.js";

const AUTO_PERMISSION_DIALOG_PACKAGES = [
  "permissioncontroller",
  "packageinstaller",
];
const CAPABILITY_PROBE_HUMAN_AUTH_COOLDOWN_MS = 90_000;

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
const LEGACY_CODING_EXECUTOR_OPT_IN_HINT =
  `${LEGACY_CODING_EXECUTOR_DEPRECATION} ` +
  "If absolutely necessary during migration, set `agent.legacyCodingExecutor=true` temporarily.";
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

type CapabilityProbeApprovalRecord = {
  decision: HumanAuthDecision;
  delegationMessage: string | null;
  templateHint: string | null;
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

type PaymentInputNode = CredentialInputNode & {
  text: string;
  contentDesc: string;
};

type DelegatedPaymentField = {
  semantic: PaymentFieldSemantic;
  value: string;
  label: string;
  artifactKey: string;
  resourceIdHint: string;
};

type ResolvedTapElementContext = {
  id: string;
  label: string;
  text: string;
  contentDesc: string;
  resourceId: string;
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
  session: { id: string; path: string; reused?: boolean };
  stepCount: number;
  maxSteps: number;
  latestSnapshot: ScreenSnapshot | null;
  /** Rolling window of recent snapshots for multi-frame visual context. */
  recentSnapshotWindow: ScreenSnapshot[];
  lastScreenshotPath: string | null;
  lastSomScreenshotPath: string | null;
  lastRecentScreenshotPaths: string[];
  history: string[];
  traces: StepTrace[];
  finishMessage: string | null;
  failMessage: string | null;
  stopRequested: () => boolean;
  lastAutoPermissionAllowAtMs: number;
  launchablePackages: string[];
  taskExecutionPlan: TaskExecutionPlan | null;
  cronTaskPlan: CronTaskPlan | null;
  runtimeModel: {
    id: string;
    provider: string;
    api: string;
    baseUrl: string;
    authSource: "config" | "env" | "codex-cli-keychain" | "codex-cli-auth-json";
  };
  effectivePromptMode: SystemPromptMode;
  systemPrompt: string;
  onHumanAuth?: (request: HumanAuthRequest) => Promise<HumanAuthDecision> | HumanAuthDecision;
  onChannelMedia?: (request: ChannelMediaRequest) => Promise<ChannelMediaDeliveryResult> | ChannelMediaDeliveryResult;
  onUserDecision?: (request: UserDecisionRequest) => Promise<UserDecisionResponse> | UserDecisionResponse;
  onUserInput?: (request: UserInputRequest) => Promise<UserInputResponse> | UserInputResponse;
  onProgress?: (update: AgentProgressUpdate) => Promise<void> | void;
  lastScreenshotStartMs: number;
  lastScreenshotEndMs: number;
  lastModelInferenceStartMs: number;
  capabilityProbeApprovalByKey: Map<string, CapabilityProbeApprovalRecord>;
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
  private readonly piCodingToolsExecutor: PiCodingToolsExecutor;
  private readonly memoryExecutor: MemoryExecutor;
  private readonly screenshotStore: ScreenshotStore;
  private readonly capabilityProbe: PhoneUseCapabilityProbe;
  private readonly capabilityProbeAuthCooldownByKey = new Map<string, number>();
  private busy = false;
  private stopRequested = false;
  private currentTask: string | null = null;
  private currentTaskStartedAtMs: number | null = null;
  private lastSystemPromptReport: WorkspacePromptContextReport | null = null;
  private lastResolvedTapElementContext: ResolvedTapElementContext | null = null;
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
    this.piCodingToolsExecutor = new PiCodingToolsExecutor(config);
    this.memoryExecutor = new MemoryExecutor(config);
    this.screenshotStore = new ScreenshotStore(
      config.screenshots.directory,
      config.screenshots.maxCount,
    );
    this.capabilityProbe = new PhoneUseCapabilityProbe({
      adbRunner: {
        run: (deviceId: string, args: string[], timeoutMs?: number) => {
          return this.emulator.runAdb(["-s", deviceId, ...args], timeoutMs ?? 20_000);
        },
      },
    });
    this.agentFactory = options?.agentFactory ?? ((agentOptions: AgentOptions) => new Agent(agentOptions));
  }

  updateConfig(updated: OpenPocketConfig): void {
    (this as unknown as { config: OpenPocketConfig }).config = updated;
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

  startScreenAwakeHeartbeat(intervalMs?: number): void {
    const resolvedMs =
      intervalMs === undefined
        ? Math.max(1, Math.round(this.config.target.wakeupIntervalSec)) * 1000
        : intervalMs;
    this.adb.startScreenAwakeHeartbeat(this.config.agent.deviceId, resolvedMs);
  }

  stopScreenAwakeHeartbeat(): void {
    this.adb.stopScreenAwakeHeartbeat();
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

  private resolveWorkspaceTemplatePath(templatePathRaw: string): string | null {
    const templatePath = String(templatePathRaw || "").trim();
    if (!templatePath) {
      return null;
    }
    const workspaceRoot = path.resolve(this.config.workspaceDir);
    const absolutePath = path.isAbsolute(templatePath)
      ? path.resolve(templatePath)
      : path.resolve(workspaceRoot, templatePath);
    if (absolutePath === workspaceRoot) {
      return null;
    }
    const workspacePrefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
    if (!absolutePath.startsWith(workspacePrefix)) {
      return null;
    }
    return absolutePath;
  }

  private loadHumanAuthTemplateFromPath(templatePathRaw: string): HumanAuthUiTemplate {
    const absolutePath = this.resolveWorkspaceTemplatePath(templatePathRaw);
    if (!absolutePath) {
      throw new Error(`Invalid templatePath: ${templatePathRaw}`);
    }
    if (!absolutePath.toLowerCase().endsWith(".json")) {
      throw new Error(`templatePath must be a .json file: ${templatePathRaw}`);
    }
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Human auth template file not found: ${templatePathRaw}`);
    }
    const raw = fs.readFileSync(absolutePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Human auth template must be a JSON object: ${templatePathRaw}`);
    }
    return parsed as HumanAuthUiTemplate;
  }

  private resolveHumanAuthUiTemplate(
    inlineTemplate: HumanAuthUiTemplate | undefined,
    templatePath: string | undefined,
  ): HumanAuthUiTemplate | undefined {
    const hasInline = Boolean(inlineTemplate && typeof inlineTemplate === "object");
    const pathRaw = String(templatePath || "").trim();
    if (!pathRaw) {
      return hasInline ? inlineTemplate : undefined;
    }
    const loaded = this.loadHumanAuthTemplateFromPath(pathRaw);
    if (!hasInline) {
      return loaded;
    }
    return {
      ...loaded,
      ...inlineTemplate,
      style: {
        ...(loaded.style ?? {}),
        ...(inlineTemplate?.style ?? {}),
      },
      fields: Array.isArray(inlineTemplate?.fields)
        ? inlineTemplate?.fields
        : loaded.fields,
    };
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

  private runAdbForLocationStrategy(
    deviceId: string,
    args: string[],
    timeoutMs = 12_000,
  ): { ok: true; output: string } | { ok: false; error: string } {
    try {
      return {
        ok: true,
        output: this.emulator.runAdb(["-s", deviceId, ...args], timeoutMs),
      };
    } catch (error) {
      return {
        ok: false,
        error: (error as Error).message,
      };
    }
  }

  private extractMockLocationUid(errorText: string): string | null {
    const match = String(errorText || "").match(/\bfrom\s+(\d+)\b/i);
    if (!match?.[1]) {
      return null;
    }
    return match[1];
  }

  private tryInjectLocationViaCmdLocation(
    deviceId: string,
    lat: number,
    lon: number,
  ): { ok: true; detail: string } | { ok: false; detail: string } {
    this.runAdbForLocationStrategy(
      deviceId,
      ["shell", "cmd", "location", "set-location-enabled", "true"],
      8_000,
    );
    this.runAdbForLocationStrategy(
      deviceId,
      ["shell", "appops", "set", "shell", "android:mock_location", "allow"],
      8_000,
    );

    const locationArg = `${lat},${lon}`;
    const providers = ["gps", "network", "fused"];
    for (const provider of providers) {
      const addProvider = this.runAdbForLocationStrategy(
        deviceId,
        ["shell", "cmd", "location", "providers", "add-test-provider", provider],
        8_000,
      );
      if (!addProvider.ok) {
        const uid = this.extractMockLocationUid(addProvider.error);
        if (uid) {
          this.runAdbForLocationStrategy(
            deviceId,
            ["shell", "appops", "set", uid, "android:mock_location", "allow"],
            8_000,
          );
        }
      }

      this.runAdbForLocationStrategy(
        deviceId,
        ["shell", "cmd", "location", "providers", "set-test-provider-enabled", provider, "true"],
        8_000,
      );

      const setProviderLocationArgs = [
        "shell",
        "cmd",
        "location",
        "providers",
        "set-test-provider-location",
        provider,
        "--location",
        locationArg,
        "--accuracy",
        "3",
      ];
      let setProviderLocation = this.runAdbForLocationStrategy(deviceId, setProviderLocationArgs, 12_000);
      if (!setProviderLocation.ok) {
        const uid = this.extractMockLocationUid(setProviderLocation.error);
        if (uid) {
          this.runAdbForLocationStrategy(
            deviceId,
            ["shell", "appops", "set", uid, "android:mock_location", "allow"],
            8_000,
          );
          setProviderLocation = this.runAdbForLocationStrategy(deviceId, setProviderLocationArgs, 12_000);
        }
      }
      if (setProviderLocation.ok) {
        return {
          ok: true,
          detail: `cmd_location provider=${provider}`,
        };
      }
    }

    const directCommands: string[][] = [
      ["shell", "cmd", "location", "set-location", String(lat), String(lon)],
      ["shell", "cmd", "location", "set", String(lat), String(lon)],
    ];
    for (const command of directCommands) {
      const directSet = this.runAdbForLocationStrategy(deviceId, command, 10_000);
      if (directSet.ok) {
        return {
          ok: true,
          detail: `cmd_location direct=${command.slice(3, 5).join("_")}`,
        };
      }
    }

    return {
      ok: false,
      detail: "cmd_location failed to inject via providers/direct commands",
    };
  }

  private tryInjectLocationViaAppiumSettings(
    deviceId: string,
    lat: number,
    lon: number,
  ): { ok: true; detail: string } | { ok: false; detail: string } {
    const appiumSettingsPackage = "io.appium.settings";
    const packagePath = this.runAdbForLocationStrategy(
      deviceId,
      ["shell", "pm", "path", appiumSettingsPackage],
      8_000,
    );
    if (!packagePath.ok || !String(packagePath.output || "").includes("package:")) {
      return {
        ok: false,
        detail: "appium_settings package not installed",
      };
    }

    this.runAdbForLocationStrategy(
      deviceId,
      ["shell", "appops", "set", appiumSettingsPackage, "android:mock_location", "allow"],
      8_000,
    );

    const component = `${appiumSettingsPackage}/.LocationService`;
    const extras = [
      "--es",
      "longitude",
      String(lon),
      "--es",
      "latitude",
      String(lat),
      "--es",
      "accuracy",
      "3.0",
    ];
    let startService = this.runAdbForLocationStrategy(
      deviceId,
      ["shell", "am", "start-foreground-service", "-n", component, ...extras],
      12_000,
    );
    if (!startService.ok) {
      startService = this.runAdbForLocationStrategy(
        deviceId,
        ["shell", "am", "startservice", "-n", component, ...extras],
        12_000,
      );
    }
    if (!startService.ok) {
      return {
        ok: false,
        detail: "appium_settings service failed to start",
      };
    }
    return {
      ok: true,
      detail: "appium_settings location service",
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
      // Always persist a step-scoped system prompt snapshot for reliable post-run debugging.
      // Keep session-level file for backward compatibility and quick "latest prompt" lookup.
      const systemPromptPath = path.join(dir, `step-${stepTag}-system-prompt.txt`);
      fs.writeFileSync(systemPromptPath, `${params.systemPrompt}\n`, "utf-8");
      fs.writeFileSync(path.join(dir, "system-prompt.txt"), `${params.systemPrompt}\n`, "utf-8");
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
      text: target.text,
      contentDesc: target.contentDesc,
      resourceId: target.resourceId,
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

  private formatCapabilityProbeEvents(events: CapabilityProbeEvent[]): string {
    const detail = events
      .map((event) => {
        const confidence = Number.isFinite(event.confidence)
          ? event.confidence.toFixed(2)
          : "0.00";
        if (event.capability === "payment") {
          const fieldCount = event.paymentContext?.fieldCandidates?.length ?? 0;
          return `${event.capability}/${event.phase} pkg=${event.packageName} src=${event.source} fields=${fieldCount} conf=${confidence}`;
        }
        return `${event.capability}/${event.phase} pkg=${event.packageName} src=${event.source} conf=${confidence}`;
      })
      .join("; ");
    return `capability_probe count=${events.length} ${detail}`;
  }

  private dedupeCapabilityProbeEvents(events: CapabilityProbeEvent[]): CapabilityProbeEvent[] {
    const map = new Map<string, CapabilityProbeEvent>();
    for (const event of events) {
      const key = `${event.capability}|${event.phase}|${event.packageName.toLowerCase()}|${event.source}`;
      const existing = map.get(key);
      if (!existing || event.confidence > existing.confidence) {
        map.set(key, event);
      }
    }
    return [...map.values()];
  }

  private detectPermissionDialogCapabilityFromDump(
    dumpText: string,
  ): CapabilityProbeEvent["capability"] | null {
    const upper = String(dumpText || "").toUpperCase();
    if (!upper) {
      return null;
    }
    if (upper.includes("ANDROID.PERMISSION.CAMERA")) {
      return "camera";
    }
    if (upper.includes("ANDROID.PERMISSION.RECORD_AUDIO")) {
      return "microphone";
    }
    if (
      upper.includes("ANDROID.PERMISSION.ACCESS_FINE_LOCATION")
      || upper.includes("ANDROID.PERMISSION.ACCESS_COARSE_LOCATION")
    ) {
      return "location";
    }
    if (
      upper.includes("ANDROID.PERMISSION.READ_MEDIA_IMAGES")
      || upper.includes("ANDROID.PERMISSION.READ_EXTERNAL_STORAGE")
      || upper.includes("ANDROID.PERMISSION.WRITE_EXTERNAL_STORAGE")
    ) {
      return "photos";
    }
    return null;
  }

  private buildPermissionDialogCapabilityEvent(
    deviceId: string,
    foregroundPackage: string,
    previousPackage: string,
  ): CapabilityProbeEvent | null {
    if (!this.isPermissionDialogApp(foregroundPackage)) {
      return null;
    }
    const previous = String(previousPackage || "").trim();
    if (!previous || this.isPermissionDialogApp(previous)) {
      return null;
    }
    try {
      const dump = this.emulator.runAdb(
        ["-s", deviceId, "shell", "dumpsys", "activity", "top"],
        6_000,
      );
      const capability = this.detectPermissionDialogCapabilityFromDump(dump);
      if (!capability) {
        return null;
      }
      return {
        capability,
        phase: "requested",
        packageName: previous,
        source: "permission_dialog",
        observedAt: nowIso(),
        confidence: 0.96,
        evidence: `activity_top:${capability}`,
      };
    } catch {
      return null;
    }
  }

  private mapProbeCapabilityToHumanAuthCapability(
    capability: CapabilityProbeEvent["capability"],
  ): HumanAuthCapability | null {
    switch (capability) {
      case "camera":
        return "camera";
      case "microphone":
        return "microphone";
      case "location":
        return "location";
      case "photos":
        return "photos";
      case "payment":
        return "payment";
      default:
        return null;
    }
  }

  private buildCapabilityProbeInstruction(event: CapabilityProbeEvent): string {
    if (event.capability === "payment") {
      return `Secure payment input was detected in ${event.packageName}. Fill required payment/billing fields from your Human Phone and approve to delegate them to Agent Phone.`;
    }
    const target = event.capability === "photos" ? "photos" : event.capability;
    return `App ${event.packageName} requested ${target} access. Approve only if you want to delegate ${target} data from your Human Phone for this task step.`;
  }

  private paymentSemanticToUiFieldType(semantic: PaymentFieldSemantic): HumanAuthUiField["type"] {
    switch (semantic) {
      case "card_number":
        return "card-number";
      case "expiry":
        return "expiry";
      case "cvc":
        return "cvc";
      case "billing_email":
        return "email";
      default:
        return "text";
    }
  }

  private paymentFieldPlaceholder(semantic: PaymentFieldSemantic): string {
    switch (semantic) {
      case "card_number":
        return "e.g., 4111111111111111";
      case "expiry":
        return "e.g., 02/32";
      case "cvc":
        return "e.g., 182";
      case "postal_code":
        return "e.g., 94105";
      case "billing_email":
        return "e.g., name@example.com";
      case "billing_phone":
        return "e.g., +1 415 555 0123";
      default:
        return "";
    }
  }

  private buildPaymentProbeFields(event: CapabilityProbeEvent): HumanAuthUiField[] {
    const candidates = Array.isArray(event.paymentContext?.fieldCandidates)
      ? event.paymentContext?.fieldCandidates ?? []
      : [];
    if (candidates.length > 0) {
      return candidates.map((candidate) => ({
        id: candidate.artifactKey,
        artifactKey: candidate.artifactKey,
        label: candidate.label,
        type: this.paymentSemanticToUiFieldType(candidate.semantic),
        required: candidate.required,
        placeholder: this.paymentFieldPlaceholder(candidate.semantic),
        autocomplete: candidate.semantic === "card_number"
          ? "cc-number"
          : candidate.semantic === "expiry"
            ? "cc-exp"
            : candidate.semantic === "cvc"
              ? "cc-csc"
              : candidate.semantic === "billing_name" || candidate.semantic === "cardholder_name"
                ? "name"
                : candidate.semantic === "billing_email"
                  ? "email"
                  : candidate.semantic === "postal_code"
                    ? "postal-code"
                    : candidate.semantic === "billing_phone"
                      ? "tel"
                      : undefined,
      }));
    }
    return [
      {
        id: "payment_field__card_number__na__0",
        artifactKey: "payment_field__card_number__na__0",
        label: "Card Number",
        type: "card-number",
        required: true,
        autocomplete: "cc-number",
      },
      {
        id: "payment_field__expiry__na__0",
        artifactKey: "payment_field__expiry__na__0",
        label: "Expiration (MM/YY)",
        type: "expiry",
        required: true,
        autocomplete: "cc-exp",
      },
      {
        id: "payment_field__cvc__na__0",
        artifactKey: "payment_field__cvc__na__0",
        label: "Security Code (CVC/CVV)",
        type: "cvc",
        required: true,
        autocomplete: "cc-csc",
      },
    ];
  }

  private buildCapabilityProbeUiTemplate(event: CapabilityProbeEvent): HumanAuthUiTemplate {
    if (event.capability === "payment") {
      const fields = this.buildPaymentProbeFields(event);
      return {
        templateId: "capability-probe-payment-v1",
        title: "Human Auth Required: Secure Payment",
        summary: `OpenPocket detected a secure payment surface in ${event.packageName}. Fill the requested fields from your Human Phone to continue.`,
        capabilityHint: `detected=payment/${event.phase} source=${event.source} secure=true fields=${fields.length}`,
        artifactKind: "form",
        requireArtifactOnApprove: true,
        allowTextAttachment: false,
        allowLocationAttachment: false,
        allowPhotoAttachment: false,
        allowAudioAttachment: false,
        allowFileAttachment: false,
        approveLabel: "Approve and Continue",
        rejectLabel: "Reject",
        notePlaceholder: "Optional context (never paste card data here)",
        fields,
      };
    }
    const titleTarget = event.capability === "photos" ? "Photo Library" : event.capability;
    const base: HumanAuthUiTemplate = {
      templateId: `capability-probe-${event.capability}-v1`,
      title: `Human Auth Required: ${titleTarget}`,
      summary: `OpenPocket detected ${event.capability} activity from ${event.packageName}. Provide data from your Human Phone and approve to continue.`,
      capabilityHint: `detected=${event.capability}/${event.phase} source=${event.source}`,
      requireArtifactOnApprove: true,
      allowTextAttachment: false,
      approveLabel: "Approve and Continue",
      rejectLabel: "Reject",
    };
    if (event.capability === "camera") {
      return {
        ...base,
        allowPhotoAttachment: true,
        allowFileAttachment: true,
        fileAccept: "image/*",
      };
    }
    if (event.capability === "photos") {
      return {
        ...base,
        allowPhotoAttachment: true,
        allowFileAttachment: true,
        fileAccept: "image/*",
      };
    }
    if (event.capability === "microphone") {
      return {
        ...base,
        allowAudioAttachment: true,
        allowFileAttachment: true,
        fileAccept: "audio/*",
      };
    }
    if (event.capability === "location") {
      return {
        ...base,
        allowLocationAttachment: true,
      };
    }
    return base;
  }

  private pickCapabilityProbeEventForHumanAuth(
    events: CapabilityProbeEvent[],
    observedAppAfterAction: string,
  ): CapabilityProbeEvent | null {
    const observedApp = String(observedAppAfterAction || "").trim().toLowerCase();
    const candidates = events
      .filter((event) => this.mapProbeCapabilityToHumanAuthCapability(event.capability) !== null)
      .filter((event) => !this.isPermissionDialogApp(event.packageName))
      .filter((event) => event.source !== "permission_dialog")
      .sort((a, b) => {
        if (observedApp) {
          const aCurrent = a.packageName.toLowerCase() === observedApp ? 1 : 0;
          const bCurrent = b.packageName.toLowerCase() === observedApp ? 1 : 0;
          if (aCurrent !== bCurrent) {
            return bCurrent - aCurrent;
          }
        }
        if (a.phase !== b.phase) {
          return a.phase === "requested" ? -1 : 1;
        }
        if (b.confidence !== a.confidence) {
          return b.confidence - a.confidence;
        }
        const aTs = Date.parse(a.observedAt || "");
        const bTs = Date.parse(b.observedAt || "");
        if (Number.isFinite(aTs) && Number.isFinite(bTs) && bTs !== aTs) {
          return bTs - aTs;
        }
        if (a.packageName !== b.packageName) {
          return a.packageName.localeCompare(b.packageName);
        }
        return a.source.localeCompare(b.source);
      });
    return candidates[0] ?? null;
  }

  private shouldThrottleCapabilityProbeHumanAuth(
    capability: HumanAuthCapability,
    packageName: string,
  ): boolean {
    const nowMs = Date.now();
    for (const [key, ts] of this.capabilityProbeAuthCooldownByKey.entries()) {
      if (nowMs - ts > CAPABILITY_PROBE_HUMAN_AUTH_COOLDOWN_MS * 2) {
        this.capabilityProbeAuthCooldownByKey.delete(key);
      }
    }
    const key = this.buildCapabilityProbeAuthKey(capability, packageName);
    const last = this.capabilityProbeAuthCooldownByKey.get(key) ?? 0;
    if (nowMs - last < CAPABILITY_PROBE_HUMAN_AUTH_COOLDOWN_MS) {
      return true;
    }
    this.capabilityProbeAuthCooldownByKey.set(key, nowMs);
    return false;
  }

  private buildCapabilityProbeAuthKey(
    capability: HumanAuthCapability,
    packageName: string,
  ): string {
    if (capability === "payment") {
      return `${capability}:${String(packageName || "").toLowerCase()}`;
    }
    void packageName;
    return capability;
  }

  private shouldRollbackLocalSensitiveSurface(
    event: CapabilityProbeEvent,
    currentApp: string,
  ): boolean {
    const sensitiveCapability =
      event.capability === "camera"
      || event.capability === "microphone"
      || event.capability === "location"
      || event.capability === "photos";
    if (!sensitiveCapability) {
      return false;
    }
    if (event.phase === "active") {
      return true;
    }
    void currentApp;
    return false;
  }

  private async rollbackLocalSensitiveSurface(
    event: CapabilityProbeEvent,
    currentApp: string,
  ): Promise<string | null> {
    if (!this.shouldRollbackLocalSensitiveSurface(event, currentApp)) {
      return null;
    }
    try {
      await this.adb.executeAction(
        {
          type: "keyevent",
          keycode: "KEYCODE_BACK",
          reason: `human_auth_probe_${event.capability}_rollback`,
        },
        this.config.agent.deviceId,
      );
      await sleep(180);
      return `local_${event.capability}_surface_rolled_back=keyevent_back`;
    } catch (error) {
      return `local_${event.capability}_surface_rollback_error=${(error as Error).message}`;
    }
  }

  private async prepareCapabilityProbePreGuardLines(
    event: CapabilityProbeEvent,
    capability: HumanAuthCapability,
    currentApp: string,
  ): Promise<string[]> {
    const preGuardLines: string[] = [];
    if (this.isPermissionDialogApp(currentApp)) {
      const guardDecision: HumanAuthDecision = {
        requestId: "capability-probe-local-permission-guard",
        approved: false,
        status: "rejected",
        message: "Reject local permission dialog before delegated human auth.",
        decidedAt: nowIso(),
        artifactPath: null,
      };
      const localGuard = await this.applyPermissionDialogDecision(capability, guardDecision, currentApp, "human_auth");
      if (localGuard?.message) {
        preGuardLines.push(`local_permission_guard=${localGuard.message}`);
      }
      return preGuardLines;
    }
    const rollbackLine = await this.rollbackLocalSensitiveSurface(event, currentApp);
    if (rollbackLine) {
      preGuardLines.push(rollbackLine);
    }
    return preGuardLines;
  }

  private async maybeEscalateCapabilityProbeToHumanAuth(
    events: CapabilityProbeEvent[],
    ctx: PhoneAgentRunContext,
    currentApp: string,
  ): Promise<string[]> {
    if (events.length === 0 || !this.config.humanAuth.enabled) {
      return [];
    }

    if (this.isPermissionDialogApp(currentApp)) {
      return [];
    }

    const event = this.pickCapabilityProbeEventForHumanAuth(events, currentApp);
    if (!event) {
      return [];
    }
    const capability = this.mapProbeCapabilityToHumanAuthCapability(event.capability);
    if (!capability) {
      return [];
    }
    const authKey = this.buildCapabilityProbeAuthKey(capability, event.packageName);
    const cachedApproval = ctx.capabilityProbeApprovalByKey.get(authKey);
    if (cachedApproval?.decision?.approved && cachedApproval.decision.artifactPath) {
      const preGuardLines = await this.prepareCapabilityProbePreGuardLines(event, capability, currentApp);
      return [
        ...preGuardLines,
        `human_auth_probe skipped=reused capability=${capability} pkg=${event.packageName}`,
        `human_artifact=${cachedApproval.decision.artifactPath}`,
        cachedApproval.delegationMessage ? `delegation=${cachedApproval.delegationMessage}` : "",
      ].filter(Boolean);
    }

    if (this.shouldThrottleCapabilityProbeHumanAuth(capability, event.packageName)) {
      return [
        `human_auth_probe skipped=throttled capability=${capability} pkg=${event.packageName}`,
      ];
    }

    if (!ctx.onHumanAuth) {
      const msg = `Human authorization required (${capability}) but no handler configured for capability probe.`;
      ctx.failMessage = msg;
      return [`human_auth_probe error=${JSON.stringify(msg)}`];
    }

    const timeoutCapSec = Math.max(30, Math.round(this.config.humanAuth.requestTimeoutSec));
    const timeoutSec = Math.min(timeoutCapSec, 180);
    const preGuardLines = await this.prepareCapabilityProbePreGuardLines(event, capability, currentApp);

    let decision: HumanAuthDecision;
    try {
      decision = await ctx.onHumanAuth({
        sessionId: ctx.session.id,
        sessionPath: ctx.session.path,
        task: ctx.task,
        step: ctx.stepCount,
        capability,
        instruction: this.buildCapabilityProbeInstruction(event),
        reason: `capability_probe:${event.capability}:${event.phase}:${event.source}`,
        timeoutSec,
        currentApp,
        screenshotPath: ctx.lastScreenshotPath,
        uiTemplate: this.buildCapabilityProbeUiTemplate(event),
      });
    } catch (error) {
      decision = {
        requestId: "capability-probe-local-error",
        approved: false,
        status: "rejected",
        message: `Human auth error: ${(error as Error).message}`,
        decidedAt: nowIso(),
        artifactPath: null,
      };
    }

    const delegation = await this.applyHumanDelegation(capability, decision, currentApp);
    if (decision.approved && decision.artifactPath) {
      ctx.capabilityProbeApprovalByKey.set(authKey, {
        decision,
        delegationMessage: delegation?.message ?? null,
        templateHint: delegation?.templateHint ?? null,
      });
    }
    const lines = [
      ...preGuardLines,
      `human_auth_probe capability=${capability} status=${decision.status} pkg=${event.packageName}`,
      decision.artifactPath ? `human_artifact=${decision.artifactPath}` : "",
      delegation?.message ? `delegation=${delegation.message}` : "",
    ].filter(Boolean);

    if (!decision.approved) {
      ctx.failMessage = `Human authorization ${decision.status}: ${decision.message}`;
    }

    return lines;
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
    return this.config.agent.deviceId || "unknown-device";
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

    // For delegated capabilities (camera/microphone/location/files/oauth/etc.),
    // local VM permission dialogs must be denied to avoid consuming Agent Phone data.
    const forceRejectForDelegation = capability !== "permission" && this.isPermissionDialogApp(currentApp);
    const approvedForDialog = forceRejectForDelegation ? false : decision.approved;

    const deviceId = this.resolveDelegationDeviceId();
    const uiDumpXml = this.captureUiDumpXml(deviceId);

    const nodes = this.parsePermissionDialogNodes(uiDumpXml);
    const targetNode = this.pickPermissionDialogNode(nodes, approvedForDialog);
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
      reason: approvedForDialog ? `${reasonPrefix}_approve` : `${reasonPrefix}_reject`,
    };
    await this.adb.executeAction(
      tapAction,
      this.config.agent.deviceId,
    );
    await sleep(300);

    const decisionLabel = approvedForDialog ? "approve" : "reject";
    const policySuffix = forceRejectForDelegation
      ? ` (local permission blocked for delegated ${capability})`
      : "";
    return {
      message: `permission dialog ${decisionLabel} tapped (${tapX}, ${tapY}) label="${label}"${policySuffix}`,
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

  private async autoRejectPermissionDialog(
    currentApp: string,
    capabilityHint: HumanAuthCapability,
  ): Promise<DelegationApplyResult | null> {
    if (!this.isPermissionDialogApp(currentApp)) {
      return null;
    }
    const decision: HumanAuthDecision = {
      requestId: "auto-vm-permission-reject",
      approved: false,
      status: "rejected",
      message: "Local permission denied to enforce delegated human auth flow.",
      decidedAt: nowIso(),
      artifactPath: null,
    };
    return this.applyPermissionDialogDecision(
      capabilityHint,
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
    // Agentic delegation: we only describe the artifact to the Agent.
    // The Agent decides how to use it (push files, type text, inject location, etc.)
    // guided by the "Human Auth Delegation" skill.

    const messages: string[] = [];

    const permissionDecision = await this.applyPermissionDialogDecision(capability, decision, currentApp);
    if (permissionDecision) {
      messages.push(permissionDecision.message);
    }

    if (!decision.approved || !decision.artifactPath) {
      if (messages.length === 0) {
        return null;
      }
      return { message: messages.join(" ; "), templateHint: null };
    }

    if (!fs.existsSync(decision.artifactPath)) {
      messages.push(`delegation artifact not found: ${decision.artifactPath}`);
      return { message: messages.join(" ; "), templateHint: null };
    }

    const summary = this.describeArtifact(decision.artifactPath, capability);
    messages.push(summary);

    return { message: messages.join(" ; "), templateHint: null };
  }

  private isFileArtifact(artifactPath: string): boolean {
    const ext = path.extname(artifactPath).toLowerCase();
    const fileExts = new Set([
      ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".gif",
      ".webm", ".ogg", ".mp3", ".wav", ".aac", ".m4a", ".opus", ".flac",
      ".mp4", ".3gp", ".pdf", ".vcf", ".ics", ".csv",
    ]);
    return fileExts.has(ext);
  }

  private pushArtifactToDevice(
    artifactPath: string,
    options?: {
      remotePath?: string;
    },
  ): string | null {
    try {
      const deviceId = this.adb.resolveDeviceId(this.config.agent.deviceId);
      const ext = path.extname(artifactPath).toLowerCase() || ".bin";
      const configuredRemotePath = String(options?.remotePath ?? "").trim();
      const remotePath = configuredRemotePath || `/sdcard/Download/openpocket-human-auth-${Date.now()}${ext}`;
      this.emulator.runAdb(["-s", deviceId, "push", artifactPath, remotePath], 30_000);
      try {
        this.emulator.runAdb([
          "-s", deviceId, "shell", "am", "broadcast",
          "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
          "-d", `file://${remotePath}`,
        ], 15_000);
      } catch {
        // best-effort media scan
      }
      return remotePath;
    } catch {
      return null;
    }
  }

  private mimeTypeToExtension(mimeTypeRaw: unknown): string {
    const mimeType = String(mimeTypeRaw ?? "").trim().toLowerCase();
    if (!mimeType) {
      return ".jpg";
    }
    if (mimeType.includes("png")) return ".png";
    if (mimeType.includes("webp")) return ".webp";
    if (mimeType.includes("heic")) return ".heic";
    if (mimeType.includes("heif")) return ".heif";
    if (mimeType.includes("gif")) return ".gif";
    if (mimeType.includes("bmp")) return ".bmp";
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
    return ".jpg";
  }

  private sanitizePhotoBaseName(nameRaw: unknown, fallback: string): string {
    const name = String(nameRaw ?? "").trim();
    const source = name || fallback;
    const stripped = source.replace(/\.[a-z0-9]{1,5}$/i, "");
    const safe = stripped.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    return safe || fallback;
  }

  private materializePhotoCollectionArtifact(
    artifactPath: string,
    artifactJson: Record<string, unknown>,
  ): {
    photoCount: number;
    pushedCount: number;
    latestLocalPath: string | null;
    latestDevicePath: string | null;
    latestAliasDevicePath: string | null;
    bundleDir: string | null;
    mode: string;
  } {
    const photosRaw = Array.isArray(artifactJson.photos) ? artifactJson.photos : [];
    const mode = String(artifactJson.mode ?? "");
    if (photosRaw.length === 0) {
      return {
        photoCount: 0,
        pushedCount: 0,
        latestLocalPath: null,
        latestDevicePath: null,
        latestAliasDevicePath: null,
        bundleDir: null,
        mode,
      };
    }

    const maxPhotos = 20;
    const targetPhotos = photosRaw.slice(0, maxPhotos);
    const baseName = path.basename(artifactPath, path.extname(artifactPath));
    const bundleDir = ensureDir(path.join(path.dirname(artifactPath), `${baseName}-photos`));

    const hintedLatestIndex = Number(artifactJson.latestIndex ?? -1);
    let latestIndex = Number.isInteger(hintedLatestIndex) ? hintedLatestIndex : -1;
    if (latestIndex < 0 || latestIndex >= targetPhotos.length) {
      latestIndex = 0;
      let latestTs = -1;
      for (let i = 0; i < targetPhotos.length; i += 1) {
        const item = targetPhotos[i];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          continue;
        }
        const lastModified = Number((item as Record<string, unknown>).lastModifiedMs ?? -1);
        if (Number.isFinite(lastModified) && lastModified >= latestTs) {
          latestTs = lastModified;
          latestIndex = i;
        }
      }
    }

    const materialized: Array<{
      index: number;
      localPath: string;
    }> = [];

    let latestLocalPath: string | null = null;
    let latestDevicePath: string | null = null;
    let latestAliasDevicePath: string | null = null;
    let pushedCount = 0;

    for (let i = 0; i < targetPhotos.length; i += 1) {
      const item = targetPhotos[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const base64 = String(record.base64 ?? "").trim();
      if (!base64) {
        continue;
      }
      const ext = this.mimeTypeToExtension(record.mimeType);
      const name = this.sanitizePhotoBaseName(record.name, `photo_${i + 1}`);
      const localPath = path.join(bundleDir, `${String(i + 1).padStart(2, "0")}_${name}${ext}`);
      try {
        fs.writeFileSync(localPath, Buffer.from(base64, "base64"));
      } catch {
        continue;
      }
      if (i === latestIndex) {
        latestLocalPath = localPath;
      }
      materialized.push({ index: i, localPath });
    }

    const ordered = [
      ...materialized.filter((item) => item.index !== latestIndex),
      ...materialized.filter((item) => item.index === latestIndex),
    ];

    for (const item of ordered) {
      const devicePath = this.pushArtifactToDevice(item.localPath);
      if (devicePath) {
        pushedCount += 1;
      }
      if (item.index === latestIndex) {
        latestDevicePath = devicePath;
        const latestExt = path.extname(item.localPath).toLowerCase() || ".jpg";
        latestAliasDevicePath = this.pushArtifactToDevice(
          item.localPath,
          { remotePath: `/sdcard/Download/openpocket-human-auth-latest${latestExt}` },
        );
      }
    }

    return {
      photoCount: photosRaw.length,
      pushedCount,
      latestLocalPath,
      latestDevicePath,
      latestAliasDevicePath,
      bundleDir,
      mode,
    };
  }

  private describeArtifact(artifactPath: string, capability: HumanAuthCapability): string {
    const ext = path.extname(artifactPath).toLowerCase();
    const stats = fs.statSync(artifactPath);
    const sizeKb = (stats.size / 1024).toFixed(1);
    const lines: string[] = [];

    lines.push(`artifact_path=${artifactPath}`);
    lines.push(`artifact_size=${sizeKb}KB`);
    lines.push(`capability=${capability}`);

    const artifactJson = this.readJsonArtifact(artifactPath);
    if (artifactJson) {
      const kind = String(artifactJson.kind ?? "unknown");
      lines.push(`artifact_kind=${kind}`);

      if (kind === "geo" && typeof artifactJson.lat === "number" && typeof artifactJson.lon === "number") {
        lines.push(`lat=${(artifactJson.lat as number).toFixed(6)} lon=${(artifactJson.lon as number).toFixed(6)}`);
      } else if (kind === "text" || kind === "qr_text") {
        const rawValue = String(artifactJson.value ?? "");
        lines.push(`value_length=${rawValue.length}`);
        lines.push("Read the artifact file to get the actual value.");
      } else if (kind === "credentials") {
        lines.push(`has_username=${Boolean(artifactJson.username)} has_password=${Boolean(artifactJson.password)}`);
        lines.push("SENSITIVE: delete artifact after use with exec(\"rm <path>\")");
      } else if (kind.startsWith("payment_card") || kind === "payment") {
        const fieldKeys = Object.keys(artifactJson.fields ?? artifactJson.form_data ?? artifactJson).filter(
          (k) => !["kind", "capability", "templateId", "capturedAt"].includes(k),
        );
        lines.push(`payment_fields=[${fieldKeys.join(",")}]`);
        lines.push("SENSITIVE: delete artifact after use with exec(\"rm <path>\")");
      } else if (kind === "photos_multi" || kind === "photo_library_grant_v1") {
        const photoBundle = this.materializePhotoCollectionArtifact(artifactPath, artifactJson);
        lines.push(`photo_count=${photoBundle.photoCount}`);
        if (kind === "photo_library_grant_v1") {
          lines.push(`photo_library_mode=${photoBundle.mode || "album_grant"}`);
          lines.push("photo_library_authorized=true");
        }
        if (photoBundle.bundleDir) {
          lines.push(`photo_bundle_dir=${photoBundle.bundleDir}`);
        }
        lines.push(`photo_pushed_count=${photoBundle.pushedCount}`);
        if (photoBundle.latestLocalPath) {
          lines.push(`photo_latest_path=${photoBundle.latestLocalPath}`);
          lines.push(`photo_latest_name=${path.basename(photoBundle.latestLocalPath)}`);
        }
        if (photoBundle.latestDevicePath) {
          lines.push(`photo_latest_device_path=${photoBundle.latestDevicePath}`);
          if (photoBundle.latestAliasDevicePath) {
            lines.push(`photo_latest_alias_device_path=${photoBundle.latestAliasDevicePath}`);
            lines.push("If picker shows filenames, prefer openpocket-human-auth-latest.* first.");
          }
          lines.push("In thumbnail grid, prefer the top-left most recently imported photo.");
          lines.push("Latest photo has been pushed to Agent Phone Downloads for immediate upload.");
        } else {
          lines.push("WARNING: failed to push latest photo to Agent Phone. Use adb push manually if needed.");
        }
      } else if (kind === "form") {
        const fieldKeys = Object.keys(artifactJson.fields ?? artifactJson.form_data ?? {});
        lines.push(`form_fields=[${fieldKeys.join(",")}]`);
      }
    }

    // For file-type artifacts (images, audio, etc.), auto-push to Agent Phone
    // so the Agent can access them via file pickers and app UIs.
    if (this.isFileArtifact(artifactPath)) {
      const devicePath = this.pushArtifactToDevice(artifactPath);
      if (devicePath) {
        lines.push(`device_path=${devicePath}`);
        lines.push("File has been pushed to Agent Phone Downloads and is ready for selection in any file picker.");
      } else {
        lines.push("WARNING: failed to push file to Agent Phone. Use shell(\"adb push ...\") manually.");
      }
    } else if (!artifactJson) {
      lines.push("artifact_type=binary");
      const devicePath = this.pushArtifactToDevice(artifactPath);
      if (devicePath) {
        lines.push(`device_path=${devicePath}`);
      }
    }

    lines.push("Use the Human Auth Delegation skill to decide how to apply this artifact.");
    return lines.join(" | ");
  }

  // =========================================================================
  // Phone-use tool execution — called from AgentTool.execute closures
  // =========================================================================

  /** Execute a phone-use action and return a text result string.
   *  Handles coordinate scaling, tap_element resolution, state delta, etc. */
  private async executePhoneAction(
    action: AgentAction,
    ctx: PhoneAgentRunContext,
    options?: {
      skipStateObservation?: boolean;
      skipCapabilityProbe?: boolean;
    },
  ): Promise<string> {
    const snapshot = ctx.latestSnapshot!;
    let observedAppAfterAction = snapshot.currentApp || "unknown";
    let debugScreenshotPath: string | null = null;

    // Resolve tap_element to coordinates
    action = this.resolveTapElementAction(action, snapshot);

    // Debug screenshot overlay before scaling
    if (
      this.config.screenshots.saveStepScreenshots &&
      (action.type === "tap" || action.type === "swipe" || action.type === "drag" || action.type === "long_press_drag")
    ) {
      try {
        const buf = Buffer.from(snapshot.screenshotBase64, "base64");
        const annotated = await drawDebugMarker(buf, action);
        debugScreenshotPath = this.screenshotStore.save(annotated, {
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
    } else if (action.type === "swipe" || action.type === "drag" || action.type === "long_press_drag") {
      const p1 = scaleCoordinates(action.x1, action.y1, snapshot.scaleX, snapshot.scaleY, snapshot.width, snapshot.height);
      const p2 = scaleCoordinates(action.x2, action.y2, snapshot.scaleX, snapshot.scaleY, snapshot.width, snapshot.height);
      action = { ...action, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }

    let executionResult = "";
    let stateDeltaLine = "";
    try {
      if (
        action.type === "cron_add" ||
        action.type === "cron_list" ||
        action.type === "cron_remove" ||
        action.type === "cron_update" ||
        action.type === "runtime_info" ||
        action.type === "todo_write" ||
        action.type === "evidence_add" ||
        action.type === "artifact_add" ||
        action.type === "journal_read" ||
        action.type === "journal_checkpoint"
      ) {
        if (
          action.type === "cron_add" ||
          action.type === "cron_list" ||
          action.type === "cron_remove" ||
          action.type === "cron_update"
        ) {
          executionResult = this.executeCronAction(action);
        } else if (action.type === "runtime_info") {
          executionResult = this.buildRuntimeInfoActionResult(ctx);
        } else {
          executionResult = this.executeJournalAction(action, ctx);
        }
      } else if (action.type === "run_script") {
        const sr = await this.scriptExecutor.execute(action.script, action.timeoutSec);
        executionResult = [
          `run_script exitCode=${sr.exitCode} timedOut=${sr.timedOut}`,
          `runDir=${sr.runDir}`,
          sr.stdout ? `stdout=${sr.stdout}` : "",
          sr.stderr ? `stderr=${sr.stderr}` : "",
        ].filter(Boolean).join("\n");
      } else if (["read", "write", "edit", "apply_patch", "exec", "process"].includes(action.type)) {
        const codingAction = action as Extract<AgentAction, {
          type: "read" | "write" | "edit" | "apply_patch" | "exec" | "process";
        }>;
        let piResult: string | null = null;
        let piError: Error | null = null;
        try {
          piResult = await this.piCodingToolsExecutor.execute(codingAction);
        } catch (error) {
          piError = error as Error;
        }

        if (piResult !== null) {
          executionResult = `${piResult}\n[coding_backend=pi_coding_tools]`;
        } else if (!this.config.agent.legacyCodingExecutor) {
          if (piError) {
            throw piError;
          }
          throw new Error(
            `coding action '${codingAction.type}' is not supported by pi coding backend and legacy fallback is disabled. ` +
            LEGACY_CODING_EXECUTOR_OPT_IN_HINT,
          );
        } else {
          if (piError && this.config.agent.verbose) {
            // eslint-disable-next-line no-console
            console.log(`[OpenPocket][coding-backend] pi_coding_tools failed: ${piError.message}; fallback=legacy`);
          }
          executionResult = await this.codingExecutor.execute(codingAction);
          executionResult = [
            executionResult,
            "[coding_backend=legacy_coding_executor]",
            `[deprecated_config_key=agent.legacyCodingExecutor] ${LEGACY_CODING_EXECUTOR_DEPRECATION}`,
          ].join("\n");
        }
      } else if (action.type === "memory_search" || action.type === "memory_get") {
        executionResult = this.memoryExecutor.execute(action);
      } else {
        executionResult = await this.adb.executeAction(action, this.config.agent.deviceId);
      }
      // State delta observation
      const deltaTypes = new Set(["tap", "swipe", "drag", "long_press_drag", "type", "keyevent", "launch_app", "shell"]);
      if (!options?.skipStateObservation && deltaTypes.has(action.type)) {
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
          observedAppAfterAction = afterState.app || observedAppAfterAction;
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
    if (debugScreenshotPath) {
      executionResult += `\nlocal_debug_screenshot=${debugScreenshotPath}`;
    }
    if (stateDeltaLine) {
      executionResult += `\n${stateDeltaLine}`;
    }
    const probeActionTypes = new Set(["tap", "tap_element", "swipe", "drag", "long_press_drag", "type", "keyevent", "launch_app", "shell"]);
    if (!options?.skipCapabilityProbe && probeActionTypes.has(action.type)) {
      try {
        const deviceId = this.adb.resolveDeviceId(this.config.agent.deviceId);
        const events = this.capabilityProbe.poll({
          deviceId,
          foregroundPackage: observedAppAfterAction,
          candidatePackages: [snapshot.currentApp],
        });
        const permissionDialogEvent = this.buildPermissionDialogCapabilityEvent(
          deviceId,
          observedAppAfterAction,
          snapshot.currentApp,
        );
        const combinedEvents = permissionDialogEvent
          ? this.dedupeCapabilityProbeEvents([...events, permissionDialogEvent])
          : events;
        if (combinedEvents.length > 0) {
          const probeLine = this.formatCapabilityProbeEvents(combinedEvents);
          executionResult += `\n${probeLine}`;
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][capability-probe] ${probeLine}`);
        }
        const escalationLines = await this.maybeEscalateCapabilityProbeToHumanAuth(
          combinedEvents,
          ctx,
          observedAppAfterAction,
        );
        if (escalationLines.length > 0) {
          const escalationText = escalationLines.join("\n");
          executionResult += `\n${escalationText}`;
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][capability-probe] ${escalationText}`);
        }
      } catch (error) {
        if (this.config.agent.verbose) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][capability-probe] failed: ${(error as Error).message}`);
        }
      }
    }
    return executionResult;
  }

  private buildRuntimeInfoActionResult(ctx: PhoneAgentRunContext): string {
    const payload = {
      session: {
        id: ctx.session.id,
        path: ctx.session.path,
        reused: Boolean(ctx.session.reused),
      },
      model: {
        profileKey: ctx.profileKey,
        profileModel: ctx.profile.model,
        activeModelId: ctx.runtimeModel.id,
        provider: ctx.runtimeModel.provider,
        api: ctx.runtimeModel.api,
        baseUrl: ctx.runtimeModel.baseUrl,
        authSource: ctx.runtimeModel.authSource,
      },
      executionPlan: ctx.taskExecutionPlan
        ? {
          surface: ctx.taskExecutionPlan.surface,
          confidence: ctx.taskExecutionPlan.confidence,
          reason: ctx.taskExecutionPlan.reason,
        }
        : null,
      cronPlan: ctx.cronTaskPlan
        ? {
          summary: ctx.cronTaskPlan.summary,
          stepBudget: ctx.cronTaskPlan.stepBudget,
          completionCriteria: ctx.cronTaskPlan.completionCriteria,
          steps: ctx.cronTaskPlan.steps,
        }
        : null,
      task: ctx.task,
      generatedAt: nowIso(),
    };
    return JSON.stringify(payload, null, 2);
  }

  private executeCronAction(
    action: Extract<AgentAction, {
      type: "cron_add" | "cron_list" | "cron_remove" | "cron_update";
    }>,
  ): string {
    const registry = new CronRegistry(this.config);

    if (action.type === "cron_list") {
      return JSON.stringify({ jobs: registry.list() }, null, 2);
    }

    if (action.type === "cron_remove") {
      const removed = registry.remove(action.id);
      return removed
        ? `cron_remove ok id=${action.id}`
        : `cron_remove missing id=${action.id}`;
    }

    if (action.type === "cron_update") {
      const updated = registry.update(action.id, {
        name: action.name,
        enabled: action.enabled,
        payload: action.task
          ? {
            kind: "agent_turn",
            task: action.task,
          }
          : undefined,
        schedule: action.schedule,
        delivery:
          action.channel && action.to
            ? {
              mode: "announce",
              channel: action.channel,
              to: action.to,
            }
            : undefined,
        model: action.model,
        promptMode: action.promptMode,
        runOnStartup: action.runOnStartup,
      });
      return updated
        ? `cron_update ok id=${updated.id}`
        : `cron_update missing id=${action.id}`;
    }

    const created = registry.add({
      id: action.id,
      name: action.name,
      enabled: true,
      schedule: action.schedule,
      payload: {
        kind: "agent_turn",
        task: action.task,
      },
      delivery:
        action.channel && action.to
          ? {
            mode: "announce",
            channel: action.channel,
            to: action.to,
          }
          : null,
      model: action.model ?? null,
      promptMode: action.promptMode ?? "minimal",
      runOnStartup: action.runOnStartup,
      createdBy: action.createdBy,
      sourceChannel: action.sourceChannel,
      sourcePeerId: action.sourcePeerId,
    });
    return `cron_add ok id=${created.id}`;
  }

  private executeJournalAction(
    action: Extract<AgentAction, {
      type: "todo_write" | "evidence_add" | "artifact_add" | "journal_read" | "journal_checkpoint";
    }>,
    ctx: PhoneAgentRunContext,
  ): string {
    const existing = readLatestTaskJournalSnapshot(ctx.session.path);
    const base: TaskJournalSnapshot = existing && existing.task === ctx.task
      ? existing
      : {
        version: 1,
        task: ctx.task,
        runId: `run-${ctx.session.id}-${Date.now()}`,
        updatedAt: nowIso(),
        todos: [],
        evidence: [],
        artifacts: [],
        progress: { milestones: ["task_start"], blockers: [] },
        completion: { status: "in_progress" },
      };

    if (action.type === "journal_read") {
      const limit = Math.max(1, Math.min(50, Math.round(action.limit ?? 20)));
      const payload = {
        version: base.version,
        task: base.task,
        runId: base.runId,
        updatedAt: base.updatedAt,
        ...(action.scope === "todos" || action.scope === "all" ? { todos: base.todos.slice(-limit) } : {}),
        ...(action.scope === "evidence" || action.scope === "all" ? { evidence: base.evidence.slice(-limit) } : {}),
        ...(action.scope === "artifacts" || action.scope === "all" ? { artifacts: base.artifacts.slice(-limit) } : {}),
        ...(action.scope === "all" ? { progress: base.progress, completion: base.completion } : {}),
      };
      return JSON.stringify(payload, null, 2);
    }

    if (action.type === "todo_write") {
      const id = action.id || `t-${Date.now().toString(36)}`;
      const idx = base.todos.findIndex((item) => item.id === id);
      if (action.op === "delete") {
        if (idx >= 0) {
          base.todos.splice(idx, 1);
        }
      } else {
        const nextText = action.text ?? (idx >= 0 ? base.todos[idx]?.text : "");
        const nextStatus = action.op === "complete"
          ? "done"
          : action.status ?? (idx >= 0 ? base.todos[idx]?.status : "pending");
        const nextTags = action.tags ?? (idx >= 0 ? base.todos[idx]?.tags : undefined);

        if (idx >= 0) {
          base.todos[idx] = {
            ...base.todos[idx],
            ...(nextText ? { text: nextText } : {}),
            status: nextStatus,
            ...(Array.isArray(nextTags) ? { tags: nextTags } : {}),
          };
        } else {
          base.todos.push({
            id,
            text: nextText || "(empty)",
            status: nextStatus,
            ...(Array.isArray(nextTags) ? { tags: nextTags } : {}),
          });
        }
      }
    } else if (action.type === "evidence_add") {
      const id = `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      base.evidence.push({
        id,
        kind: action.kind,
        title: action.title,
        ...(action.fields ? { fields: action.fields } : {}),
        source: { step: ctx.stepCount, tool: "evidence_add" },
        ...(typeof action.confidence === "number" ? { confidence: action.confidence } : {}),
      });
    } else if (action.type === "artifact_add") {
      const id = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      base.artifacts.push({
        id,
        kind: action.kind,
        value: action.value,
        ...(action.description ? { description: action.description } : {}),
      });
    } else if (action.type === "journal_checkpoint") {
      const name = action.name || "checkpoint";
      if (!base.progress.milestones.includes(name)) {
        base.progress.milestones.push(name);
      }
      if (action.notes) {
        const id = `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        base.evidence.push({
          id,
          kind: "checkpoint",
          title: `checkpoint:${name}`,
          fields: { notes: action.notes },
          source: { step: ctx.stepCount, tool: "journal_checkpoint" },
        });
      }
    }

    base.updatedAt = nowIso();
    appendTaskJournalSnapshot(ctx.session.path, base);

    if (action.type === "todo_write") {
      return `todo_write ok todos=${base.todos.length}`;
    }
    if (action.type === "evidence_add") {
      return `evidence_add ok evidence=${base.evidence.length}`;
    }
    if (action.type === "artifact_add") {
      return `artifact_add ok artifacts=${base.artifacts.length}`;
    }
    return "journal_checkpoint ok";
  }

  private async executeBatchPhoneActions(
    action: Extract<AgentAction, { type: "batch_actions" }>,
    ctx: PhoneAgentRunContext,
  ): Promise<string> {
    const lines = [`batch_actions count=${action.actions.length}`];
    const terminalActions = new Set<BatchableAgentAction["type"]>([
      "tap",
      "tap_element",
      "swipe",
      "drag",
      "long_press_drag",
      "type",
      "keyevent",
    ]);

    for (let i = 0; i < action.actions.length; i += 1) {
      const item = action.actions[i]!;
      let itemResult = "";

      if (item.type === "wait") {
        const waitMs = item.durationMs ?? 1000;
        await sleep(waitMs);
        itemResult = `Waited ${waitMs}ms`;
      } else {
        itemResult = await this.executePhoneAction(item, ctx, {
          skipStateObservation: true,
          skipCapabilityProbe: true,
        });
      }

      lines.push(`[${i + 1}/${action.actions.length}] ${item.type}: ${itemResult}`);
      if (/action execution error:/i.test(itemResult)) {
        lines.push(`batch_aborted_at=${i + 1}`);
        break;
      }

      if (i < action.actions.length - 1 && terminalActions.has(item.type)) {
        const delayMs = this.computePostActionDelayMs(item, itemResult);
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }

    return lines.join("\n");
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
            if (ctx.cronTaskPlan) {
              const summary = String(ctx.cronTaskPlan.summary || "").replace(/\s+/g, " ").trim();
              ctx.finishMessage = `Completed this scheduled run window after ${ctx.stepCount}/${ctx.maxSteps} steps.${summary ? ` ${summary}` : ""} Remaining work can continue on the next scheduled trigger.`;
              return { content: [{ type: "text" as const, text: ctx.finishMessage }], details: { skipped: true } };
            }
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
          const logStepSection = (section: string, text: string): void => {
            const normalized = String(text ?? "").trim();
            if (!normalized) {
              return;
            }
            for (const line of normalized.split("\n")) {
              // eslint-disable-next-line no-console
              console.log(`[OpenPocket][step ${step}][${section}] ${line}`);
            }
          };
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
            const screenshotMs = ctx.lastScreenshotEndMs > ctx.lastScreenshotStartMs
              ? Math.max(0, ctx.lastScreenshotEndMs - ctx.lastScreenshotStartMs)
              : 0;
            const modelInferenceMs = ctx.lastModelInferenceStartMs > 0 && stepStartedAtMs > ctx.lastModelInferenceStartMs
              ? Math.max(0, stepStartedAtMs - ctx.lastModelInferenceStartMs)
              : 0;
            const trace = {
              actionType: action.type,
              currentApp,
              startedAt: stepStartedAt,
              endedAt,
              durationMs,
              status,
              screenshotMs,
              modelInferenceMs,
              loopDelayMs: runtime.config.agent.loopDelayMs,
            };
            logStepSection(
              "end",
              `tool=${toolName} action=${trace.actionType} app=${trace.currentApp} status=${trace.status}` +
              ` started_at=${trace.startedAt} ended_at=${trace.endedAt} duration_ms=${trace.durationMs}` +
              ` screenshot_ms=${trace.screenshotMs} model_inference_ms=${trace.modelInferenceMs}`,
            );
            return trace;
          };

          const buildTraceUiContext = (): import("../skills/auto-artifact-builder.js").StepTraceUiContext | undefined => {
            const m = runtime.lastResolvedTapElementContext;
            if (!m) {
              return undefined;
            }
            return {
              elementId: m.id,
              label: m.label,
              resourceId: m.resourceId || undefined,
              text: m.text || undefined,
              contentDesc: m.contentDesc || undefined,
              className: m.className,
              clickable: m.clickable,
            };
          };

          if (!snapshot && action.type !== "finish") {
            const msg = "No screen snapshot available for tool execution.";
            ctx.failMessage = msg;
            logStepSection("result", msg);
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

          logStepSection("start", `ts=${stepStartedAt} tool=${toolName} action=${action.type}`);
          logStepSection(
            "input",
            [
              `app=${snapshot?.currentApp ?? "unknown"}`,
              `screenshot=${ctx.lastScreenshotPath ?? "(none)"}`,
              `ui_candidates=${snapshot?.uiElements?.length ?? 0}`,
            ].join(" "),
          );
          logStepSection("thought", thought || "(empty)");
          logStepSection("decision", JSON.stringify(action));

          const stopErrorMessage = "Task stopped by user.";
          const isStopError = (error: unknown): boolean => {
            const message = (error as Error)?.message ?? String(error ?? "");
            return message.toLowerCase().includes(stopErrorMessage.toLowerCase());
          };
          const awaitWithStopGuard = async <T>(operation: () => Promise<T> | T): Promise<T> => {
            if (ctx.stopRequested()) {
              throw new Error(stopErrorMessage);
            }
            const opPromise = Promise.resolve().then(() => operation());
            let stopTimer: NodeJS.Timeout | null = null;
            try {
              return await Promise.race([
                opPromise,
                new Promise<T>((_, reject) => {
                  stopTimer = setInterval(() => {
                    if (!ctx.stopRequested()) {
                      return;
                    }
                    if (stopTimer) {
                      clearInterval(stopTimer);
                      stopTimer = null;
                    }
                    reject(new Error(stopErrorMessage));
                  }, 120);
                  stopTimer.unref?.();
                }),
              ]);
            } finally {
              if (stopTimer) {
                clearInterval(stopTimer);
              }
            }
          };

          // ---- finish ----
          if (action.type === "finish") {
            const preFinishLines: string[] = [];
            const finishApp = snapshot?.currentApp ?? "unknown";
            try {
              const canProbe =
                this.config.humanAuth.enabled
                && Boolean(snapshot)
                && finishApp !== "unknown";
              if (canProbe) {
                const deviceId = this.adb.resolveDeviceId(this.config.agent.deviceId);
                const events = this.capabilityProbe.poll({
                  deviceId,
                  foregroundPackage: finishApp,
                  candidatePackages: [finishApp],
                });
                if (events.length > 0) {
                  const probeLine = this.formatCapabilityProbeEvents(events);
                  preFinishLines.push(probeLine);
                  // eslint-disable-next-line no-console
                  console.log(`[OpenPocket][capability-probe] ${probeLine}`);
                }
                const escalationLines = await this.maybeEscalateCapabilityProbeToHumanAuth(
                  events,
                  ctx,
                  finishApp,
                );
                if (escalationLines.length > 0) {
                  preFinishLines.push(...escalationLines);
                  // eslint-disable-next-line no-console
                  console.log(`[OpenPocket][capability-probe] ${escalationLines.join("\n")}`);
                }
              }
            } catch (error) {
              if (this.config.agent.verbose) {
                // eslint-disable-next-line no-console
                console.log(`[OpenPocket][capability-probe] pre-finish check failed: ${(error as Error).message}`);
              }
            }

            if (ctx.failMessage) {
              const resultText = [
                `FINISH_BLOCKED: ${ctx.failMessage}`,
                ...preFinishLines,
              ]
                .filter(Boolean)
                .join("\n");
              logStepSection("result", resultText);
              runtime.workspace.appendStep(
                ctx.session,
                step,
                thought,
                JSON.stringify(action, null, 2),
                resultText,
                buildStepTrace(finishApp, "error"),
              );
              ctx.traces.push({ step, action, result: resultText, thought, currentApp: finishApp });
              ctx.history.push(`step ${step}: action=finish blocked=${ctx.failMessage}`);
              return { content: [{ type: "text" as const, text: resultText }], details: {} };
            }

            ctx.finishMessage = action.message || "Task completed.";
            const resultText = [
              `FINISH: ${ctx.finishMessage}`,
              ...preFinishLines,
            ]
              .filter(Boolean)
              .join("\n");
            logStepSection("result", resultText);
            runtime.workspace.appendStep(
              ctx.session,
              step,
              thought,
              JSON.stringify(action, null, 2),
              resultText,
              buildStepTrace(finishApp, "ok"),
            );
            ctx.traces.push({ step, action, result: resultText, thought, currentApp: finishApp });
            ctx.history.push(`step ${step}: action=finish message=${ctx.finishMessage}`);
            return { content: [{ type: "text" as const, text: resultText }], details: {} };
          }

          // ---- request_human_auth ----
          if (action.type === "request_human_auth") {
            const onVmDialog = snapshot ? runtime.isPermissionDialogApp(snapshot.currentApp) : false;
            const currentApp = snapshot?.currentApp ?? "unknown";

            // Android permission dialogs are OS-level UI that the agent must handle
            // locally by tapping Allow (if relevant to task) or Deny (if irrelevant).
            // Never escalate them via human auth.
            if (onVmDialog) {
              const msg = `Android permission dialog detected (${action.capability}). Handle it locally: tap Allow if this permission is needed for the current task, or tap Deny/Don't Allow if it is irrelevant. Do not use request_human_auth for OS permission dialogs.`;
              logStepSection("result", msg);
              runtime.workspace.appendStep(
                ctx.session,
                step,
                thought,
                JSON.stringify(action, null, 2),
                msg,
                buildStepTrace(currentApp, "ok"),
              );
              ctx.traces.push({ step, action, result: msg, thought, currentApp });
              ctx.history.push(`step ${step}: action=request_human_auth(${action.capability}) redirected_to_local_dialog_handling`);
              return { content: [{ type: "text" as const, text: msg }], details: {} };
            }

            if (action.capability === "permission") {
              const msg = "permission auto-approved locally (VM policy)";
              logStepSection("result", msg);
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

            if (!ctx.onHumanAuth) {
              const msg = `Human authorization required (${action.capability}), but no handler configured.`;
              ctx.failMessage = msg;
              logStepSection("result", msg);
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
              const resolvedUiTemplate = runtime.resolveHumanAuthUiTemplate(
                action.uiTemplate,
                action.templatePath,
              );
              const requestedTimeoutSec = Number(
                action.timeoutSec ?? runtime.config.humanAuth.requestTimeoutSec,
              );
              const timeoutCapSec = Math.max(30, Math.round(runtime.config.humanAuth.requestTimeoutSec));
              const timeoutSec = Math.min(
                timeoutCapSec,
                Math.max(30, Math.round(Number.isFinite(requestedTimeoutSec) ? requestedTimeoutSec : timeoutCapSec)),
              );
              decision = await awaitWithStopGuard(() => ctx.onHumanAuth!({
                sessionId: ctx.session.id, sessionPath: ctx.session.path, task: ctx.task, step,
                capability: action.capability, instruction: action.instruction,
                reason: action.reason ?? thought,
                timeoutSec,
                currentApp, screenshotPath: ctx.lastScreenshotPath,
                uiTemplate: resolvedUiTemplate,
              }));
            } catch (error) {
              if (isStopError(error)) {
                const msg = stopErrorMessage;
                ctx.failMessage = msg;
                logStepSection("result", msg);
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
              decision = { requestId: "local-error", approved: false, status: "rejected", message: `Human auth error: ${(error as Error).message}`, decidedAt: nowIso(), artifactPath: null };
            }

            const delegation = await runtime.applyHumanDelegation(action.capability, decision, currentApp);
            const resultText = [
              `Human auth ${decision.status}: ${decision.message}`,
              decision.artifactPath ? `human_artifact=${decision.artifactPath}` : "",
              delegation?.message ? `delegation=${delegation.message}` : "",
            ].filter(Boolean).join("\n");
            logStepSection("result", resultText);
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
              logStepSection("result", msg);
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
              decision = await awaitWithStopGuard(() => ctx.onUserDecision!({
                sessionId: ctx.session.id, sessionPath: ctx.session.path, task: ctx.task, step,
                question: action.question, options: action.options,
                timeoutSec: Math.max(20, action.timeoutSec ?? 300),
                currentApp: snapshot?.currentApp ?? "unknown", screenshotPath: ctx.lastScreenshotPath,
              }));
            } catch (error) {
              const msg = isStopError(error)
                ? stopErrorMessage
                : `User decision failed: ${(error as Error).message}`;
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
            logStepSection("result", resultText);
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
              logStepSection("result", msg);
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
              response = await awaitWithStopGuard(() => ctx.onUserInput!({
                sessionId: ctx.session.id,
                sessionPath: ctx.session.path,
                task: ctx.task,
                step,
                question: action.question,
                placeholder: action.placeholder,
                timeoutSec: Math.max(20, action.timeoutSec ?? 300),
                currentApp: snapshot?.currentApp ?? "unknown",
                screenshotPath: ctx.lastScreenshotPath,
              }));
            } catch (error) {
              const msg = isStopError(error)
                ? stopErrorMessage
                : `User input failed: ${(error as Error).message}`;
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
            logStepSection("result", logResultText);
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

          // ---- send_media ----
          if (action.type === "send_media") {
            if (!ctx.onChannelMedia) {
              const msg = "Channel media delivery is not available in this runtime context.";
              ctx.failMessage = msg;
              logStepSection("result", msg);
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

            let delivery: ChannelMediaDeliveryResult;
            try {
              delivery = await awaitWithStopGuard(() => ctx.onChannelMedia!({
                sessionId: ctx.session.id,
                sessionPath: ctx.session.path,
                task: ctx.task,
                step,
                path: action.path,
                mediaType: action.mediaType ?? "auto",
                caption: action.caption,
                reason: action.reason ?? thought,
                currentApp: snapshot?.currentApp ?? "unknown",
                screenshotPath: ctx.lastScreenshotPath,
              }));
            } catch (error) {
              const msg = isStopError(error)
                ? stopErrorMessage
                : `send_media failed: ${(error as Error).message}`;
              ctx.failMessage = msg;
              logStepSection("result", msg);
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

            const resultText = delivery.ok
              ? `send_media ok media_type=${delivery.mediaType ?? "unknown"} message=${delivery.message}`
              : `send_media error message=${delivery.message}`;
            if (!delivery.ok) {
              ctx.failMessage = resultText;
            }
            logStepSection("result", resultText);
            runtime.workspace.appendStep(
              ctx.session,
              step,
              thought,
              JSON.stringify(action, null, 2),
              resultText,
              buildStepTrace(snapshot?.currentApp ?? "unknown", delivery.ok ? "ok" : "error"),
            );
            ctx.traces.push({ step, action, result: resultText, thought, currentApp: snapshot?.currentApp ?? "unknown" });
            ctx.history.push(`step ${step}: action=send_media status=${delivery.ok ? "ok" : "error"} type=${delivery.mediaType ?? "unknown"}`);
            return { content: [{ type: "text" as const, text: resultText }], details: {} };
          }

          // ---- wait ----
          if (action.type === "wait") {
            const ms = action.durationMs ?? 1000;
            await sleep(ms);
            const resultText = `Waited ${ms}ms`;
            logStepSection("result", resultText);
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

          function buildScreenshotSuffix(): string {
            let suffix = "";
            if (ctx.lastScreenshotPath) suffix += `\nlocal_screenshot=${ctx.lastScreenshotPath}`;
            if (ctx.lastSomScreenshotPath) suffix += `\nlocal_som_screenshot=${ctx.lastSomScreenshotPath}`;
            for (let i = 0; i < ctx.lastRecentScreenshotPaths.length; i++) {
              suffix += `\nlocal_recent_screenshot_${i}=${ctx.lastRecentScreenshotPaths[i]}`;
            }
            return suffix;
          }

          // ---- batch_actions ----
          if (action.type === "batch_actions") {
            const executionResult = await runtime.executeBatchPhoneActions(action, ctx);
            const stepResult = executionResult + buildScreenshotSuffix();
            logStepSection("result", stepResult);
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
            ctx.traces.push({ step, action, result: stepResult, thought, currentApp: snapshot?.currentApp ?? "unknown", uiContext: buildTraceUiContext() });
            ctx.history.push(`step ${step}: app=${snapshot?.currentApp ?? "unknown"} action=batch_actions count=${action.actions.length}`);
            return { content: [{ type: "text" as const, text: stepResult }], details: {} };
          }

          // ---- all other actions (tap, swipe, type, keyevent, launch_app, shell, run_script, read, write, edit, etc.) ----
          const executionResult = await runtime.executePhoneAction(action, ctx);
          const stepResult = executionResult + buildScreenshotSuffix();
          logStepSection("result", stepResult);

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
          ctx.traces.push({ step, action, result: stepResult, thought, currentApp: snapshot?.currentApp ?? "unknown", uiContext: buildTraceUiContext() });
          ctx.history.push(`step ${step}: app=${snapshot?.currentApp ?? "unknown"} action=${action.type} result=${executionResult}`);

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
    const normalized = String(task || "").trim();
    if (!normalized) {
      return false;
    }
    // Keep coding/workspace/memory tools available for all real tasks so
    // the agent can decide autonomously whether it needs runtime probing,
    // local scripting, or file-based tool composition.
    return true;
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
      /\b(call\s+finish|should\s+finish|finish\s+the\s+task|complete\s+the\s+task|end\s+the\s+task)\b|\u5b8c\u6210\u4efb\u52a1|\u7ed3\u675f\u4efb\u52a1|\u5e94\u8be5\u7ed3\u675f|\u5e94\u5f53\u7ed3\u675f/i;
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
    onChannelMedia?: (request: ChannelMediaRequest) => Promise<ChannelMediaDeliveryResult> | ChannelMediaDeliveryResult,
    taskExecutionPlan?: TaskExecutionPlan | null,
    availableToolNamesOverride?: string[],
    maxStepsOverride?: number,
    cronTaskPlan?: CronTaskPlan | null,
  ): Promise<AgentRunResult> {
    const activeToolNames = Array.isArray(availableToolNamesOverride) && availableToolNamesOverride.length > 0
      ? availableToolNamesOverride
      : this.resolveToolMetasForTask(task).map((item) => item.name);
    const request: RunTaskRequest = {
      task,
      modelName,
      sessionKey,
      onProgress,
      onHumanAuth,
      onChannelMedia,
      promptMode,
      onUserDecision,
      availableToolNames: activeToolNames,
      onUserInput,
      taskExecutionPlan,
      maxStepsOverride,
      cronTaskPlan,
    };

    return runRuntimeTask(
      {
        isBusy: () => this.busy,
        beginRun: (activeTask) => {
          this.busy = true;
          this.stopRequested = false;
          this.currentTask = activeTask;
          this.currentTaskStartedAtMs = Date.now();
          this.capabilityProbeAuthCooldownByKey.clear();
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
            piSessionBridgeFactory: (options) => createPiSessionBridge(options),
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
          this.busy = false;
          this.currentTask = null;
          this.currentTaskStartedAtMs = null;
          this.stopRequested = false;
          this.capabilityProbeAuthCooldownByKey.clear();
        },
      },
      request,
    );
  }
}
