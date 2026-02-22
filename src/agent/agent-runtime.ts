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
  OpenPocketConfig,
  SkillInfo,
  ScreenSnapshot,
} from "../types";
import { getModelProfile, resolveModelAuth } from "../config";
import { WorkspaceStore } from "../memory/workspace";
import { ScreenshotStore } from "../memory/screenshot-store";
import { sleep } from "../utils/time";
import { nowIso } from "../utils/paths";
import { AdbRuntime } from "../device/adb-runtime";
import { EmulatorManager } from "../device/emulator-manager";
import { AutoArtifactBuilder, type StepTrace } from "../skills/auto-artifact-builder";
import { SkillLoader } from "../skills/skill-loader";
import { ScriptExecutor } from "../tools/script-executor";
import { CodingExecutor } from "../tools/coding-executor";
import { MemoryExecutor } from "../tools/memory-executor";
import { ModelClient } from "./model-client";
import { buildSystemPrompt, buildUserPrompt, type SystemPromptMode } from "./prompts";
import { CHAT_TOOLS } from "./tools";
import { scaleCoordinates, drawDebugMarker } from "../utils/image-scale";

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

  constructor(config: OpenPocketConfig) {
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
      },
      tools,
    };
  }

  getWorkspacePromptContextReport(): WorkspacePromptContextReport {
    if (this.lastSystemPromptReport) {
      return this.lastSystemPromptReport;
    }
    const skillsSummary = this.skillLoader.summaryText();
    const workspacePromptContext = this.buildWorkspacePromptContext();
    const promptMode = this.config.agent.systemPromptMode;
    const systemPrompt = buildSystemPrompt(skillsSummary, workspacePromptContext.text, {
      mode: promptMode,
    });
    return this.buildSystemPromptReport({
      source: "estimate",
      promptMode,
      systemPrompt,
      skillsSummary,
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
    return filtered[0] ?? null;
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

    if (username) {
      focusedUsernameNode = this.pickCredentialInputNode(nodes, "username", null);
      if (focusedUsernameNode) {
        await this.tapCredentialNode(focusedUsernameNode, "human_auth_focus_username");
      }
      await this.adb.executeAction(
        {
          type: "type",
          text: username,
          reason: "human_auth_delegate_username",
        },
        this.config.agent.deviceId,
      );
    }

    if (password) {
      const passwordNode = this.pickCredentialInputNode(nodes, "password", focusedUsernameNode);
      if (passwordNode) {
        await this.tapCredentialNode(passwordNode, "human_auth_focus_password");
      } else if (username) {
        await this.adb.executeAction(
          {
            type: "keyevent",
            keycode: "KEYCODE_TAB",
            reason: "human_auth_focus_password_tab",
          },
          this.config.agent.deviceId,
        );
        await sleep(80);
      }
      await this.adb.executeAction(
        {
          type: "type",
          text: password,
          reason: "human_auth_delegate_password",
        },
        this.config.agent.deviceId,
      );
    }

    const filled: string[] = [];
    if (username) {
      filled.push(`username(${username.length} chars)`);
    }
    if (password) {
      filled.push(`password(${password.length} chars)`);
    }
    return {
      message: `delegated credentials typed: ${filled.join(" + ")}`,
      templateHint: "oauth_credentials_typed_continue_flow",
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
    let uiDumpXml = "";
    try {
      this.emulator.runAdb(
        ["-s", deviceId, "shell", "uiautomator", "dump", "/sdcard/openpocket-window.xml"],
        15_000,
      );
      uiDumpXml = this.emulator.runAdb(
        ["-s", deviceId, "shell", "cat", "/sdcard/openpocket-window.xml"],
        15_000,
      );
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
      x: target.center.x,
      y: target.center.y,
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
    uiElements: Array<{
      text: string;
      contentDesc: string;
      resourceId: string;
      className: string;
      clickable: boolean;
      scaledBounds: { left: number; top: number; right: number; bottom: number };
    }>;
  }): SnapshotObservation {
    const tuples = snapshot.uiElements
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

    const hashInput = JSON.stringify({
      app: snapshot.currentApp,
      nodes: tuples.slice(0, 80),
    });
    const uiHash = createHash("sha1").update(hashInput).digest("hex").slice(0, 12);
    return {
      app: snapshot.currentApp || "unknown",
      uiHash,
      labels,
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
      let artifactResult: DelegationApplyResult | null = null;

      if (capability === "location") {
        const geo = this.extractDelegatedGeo(artifactJson);
        if (geo) {
          artifactResult = await this.applyLocationDelegation(geo.lat, geo.lon);
        }
      }

      if (!artifactResult && capability === "oauth") {
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

      if (!artifactResult && artifactJson?.kind === "credentials") {
        const credentials = this.extractDelegatedCredentials(artifactJson);
        if (credentials) {
          artifactResult = await this.applyCredentialDelegation(credentials.username, credentials.password);
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

  async runTask(
    task: string,
    modelName?: string,
    onProgress?: (update: AgentProgressUpdate) => Promise<void> | void,
    onHumanAuth?: (request: HumanAuthRequest) => Promise<HumanAuthDecision> | HumanAuthDecision,
    promptMode?: "full" | "minimal" | "none",
    onUserDecision?: (request: UserDecisionRequest) => Promise<UserDecisionResponse> | UserDecisionResponse,
  ): Promise<AgentRunResult> {
    if (this.busy) {
      return {
        ok: false,
        message: "Agent is busy. Please retry later.",
        sessionPath: "",
        skillPath: null,
        scriptPath: null,
      };
    }

    this.busy = true;
    this.stopRequested = false;
    this.currentTask = task;
    this.currentTaskStartedAtMs = Date.now();
    let shouldReturnHome = false;

    const profileKey = modelName ?? this.config.defaultModel;
    const profile = getModelProfile(this.config, profileKey);
    const session = this.workspace.createSession(task, profileKey, profile.model);
    let lastAutoPermissionAllowAtMs = 0;

    try {
      const auth = resolveModelAuth(profile);
      if (!auth) {
        const codexHint = profile.model.toLowerCase().includes("codex")
          ? " or login via Codex CLI (`~/.codex/auth.json`)"
          : "";
        const message = `Missing API key for model '${profile.model}'. Set env ${profile.apiKeyEnv} or config.models.${profileKey}.apiKey${codexHint}`;
        this.workspace.finalizeSession(session, false, message);
        this.workspace.appendDailyMemory(profileKey, task, false, message);
        return {
          ok: false,
          message,
          sessionPath: session.path,
          skillPath: null,
          scriptPath: null,
        };
      }

      const model = new ModelClient(profile, auth.apiKey, {
        baseUrl: auth.baseUrl,
        preferredMode: auth.preferredMode,
      });
      const snapshotContextWindow: ScreenSnapshot[] = [];
      const history: string[] = [];
      const traces: StepTrace[] = [];
      const skillsSummary = this.skillLoader.summaryText();
      const workspacePromptContext = this.buildWorkspacePromptContext();
      const effectivePromptMode = promptMode ?? this.config.agent.systemPromptMode;
      const systemPrompt = buildSystemPrompt(skillsSummary, workspacePromptContext.text, {
        mode: effectivePromptMode,
      });
      this.lastSystemPromptReport = this.buildSystemPromptReport({
        source: "run",
        promptMode: effectivePromptMode,
        systemPrompt,
        skillsSummary,
        workspaceReport: workspacePromptContext.report,
      });

      const launchablePackages = typeof this.adb.queryLaunchablePackages === "function"
        ? this.adb.queryLaunchablePackages(this.config.agent.deviceId)
        : [];

      for (let step = 1; step <= this.config.agent.maxSteps; step += 1) {
        if (this.stopRequested) {
          const message = "Task stopped by user.";
          this.workspace.finalizeSession(session, false, message);
          this.workspace.appendDailyMemory(profileKey, task, false, message);
          return {
            ok: false,
            message,
            sessionPath: session.path,
            skillPath: null,
            scriptPath: null,
          };
        }

        const snapshot = await this.adb.captureScreenSnapshot(this.config.agent.deviceId, profile.model);
        snapshot.installedPackages = launchablePackages;
        const recentSnapshots = snapshotContextWindow.slice(-2) as typeof snapshot[];
        shouldReturnHome = true;
        let screenshotPath: string | null = null;
        if (this.config.screenshots.saveStepScreenshots) {
          try {
            screenshotPath = this.screenshotStore.save(
              Buffer.from(snapshot.screenshotBase64, "base64"),
              {
                sessionId: session.id,
                step,
                currentApp: snapshot.currentApp,
              },
            );
          } catch {
            screenshotPath = null;
          }
        }

        const autoPermissionDialogDetected =
          this.isPermissionDialogApp(snapshot.currentApp) &&
          Date.now() - lastAutoPermissionAllowAtMs >= 1_200;

        if (autoPermissionDialogDetected) {
          const autoThought =
            "Detected Android runtime permission dialog in emulator. Auto-approving with Allow.";
          const autoDecision = await this.autoApprovePermissionDialog(snapshot.currentApp);
          if (autoDecision?.action?.type === "tap") {
            lastAutoPermissionAllowAtMs = Date.now();
            const autoAction = autoDecision.action;
            const stepResult = screenshotPath
              ? `${autoDecision.message}\nlocal_screenshot=${screenshotPath}`
              : autoDecision.message;
            this.workspace.appendStep(
              session,
              step,
              autoThought,
              JSON.stringify(autoAction, null, 2),
              stepResult,
            );
            traces.push({
              step,
              action: autoAction,
              result: stepResult,
              thought: autoThought,
              currentApp: snapshot.currentApp,
            });
            history.push(
              `step ${step}: app=${snapshot.currentApp} action=tap(auto_vm_permission_approve) message=${autoDecision.message}`,
            );

            if (onProgress && step % this.config.agent.progressReportInterval === 0) {
              try {
                await onProgress({
                  step,
                  maxSteps: this.config.agent.maxSteps,
                  currentApp: snapshot.currentApp,
                  actionType: autoAction.type,
                  message: autoDecision.message,
                  thought: autoThought,
                  screenshotPath,
                });
              } catch {
                // Keep task execution unaffected when progress callback fails.
              }
            }

            await sleep(Math.min(this.config.agent.loopDelayMs, 1200));
            continue;
          }
        }

        const userPrompt = buildUserPrompt(task, step, snapshot, history);
        this.saveModelInputArtifacts({
          sessionId: session.id,
          step,
          task,
          profileModel: profile.model,
          promptMode: effectivePromptMode,
          systemPrompt,
          userPrompt,
          snapshot,
          history,
        });
        snapshotContextWindow.push(snapshot);
        if (snapshotContextWindow.length > 2) {
          snapshotContextWindow.shift();
        }

        const output = await model.nextStep({
          systemPrompt,
          task,
          step,
          snapshot,
          recentSnapshots,
          history,
        });

        if (output.action.type === "finish") {
          const finishMessage = output.action.message || "Task completed.";
          this.workspace.appendStep(
            session,
            step,
            output.thought,
            JSON.stringify(output.action, null, 2),
            `FINISH: ${finishMessage}`,
          );
          traces.push({
            step,
            action: output.action,
            result: `FINISH: ${finishMessage}`,
            thought: output.thought,
            currentApp: snapshot.currentApp,
          });
          this.workspace.finalizeSession(session, true, finishMessage);
          this.workspace.appendDailyMemory(profileKey, task, true, finishMessage);
          const artifacts = this.autoArtifactBuilder.build({
            task,
            sessionPath: session.path,
            ok: true,
            finalMessage: finishMessage,
            traces,
          });
          if (artifacts.skillPath) {
            // eslint-disable-next-line no-console
            console.log(`[OpenPocket][artifact] auto skill generated: ${artifacts.skillPath}`);
          }
          if (artifacts.scriptPath) {
            // eslint-disable-next-line no-console
            console.log(`[OpenPocket][artifact] auto script generated: ${artifacts.scriptPath}`);
          }
          return {
            ok: true,
            message: finishMessage,
            sessionPath: session.path,
            skillPath: artifacts.skillPath,
            scriptPath: artifacts.scriptPath,
          };
        }

        if (output.action.type === "request_human_auth") {
          const permissionCapabilityOnly = output.action.capability === "permission";
          const onVmPermissionDialog = this.isPermissionDialogApp(snapshot.currentApp);
          let localPermissionAutoMessage: string | null = null;

          if (onVmPermissionDialog) {
            const autoDecision = await this.autoApprovePermissionDialog(snapshot.currentApp);
            localPermissionAutoMessage = autoDecision?.message || "permission dialog auto-approve attempted but no actionable button detected";
            const autoAction: AgentAction = autoDecision?.action?.type === "tap"
              ? autoDecision.action
              : {
                  type: "wait",
                  durationMs: 600,
                  reason: "auto_vm_permission_no_button_detected",
                };
            if (autoDecision?.action?.type === "tap") {
              lastAutoPermissionAllowAtMs = Date.now();
            }

            history.push(
              `step ${step}: app=${snapshot.currentApp} action=${autoAction.type}(auto_vm_permission_policy) message=${localPermissionAutoMessage}`,
            );

            if (permissionCapabilityOnly) {
              const autoThought =
                "Permission authorization belongs to the emulator. Auto-approving permission dialog locally.";
              const stepResult = screenshotPath
                ? `${localPermissionAutoMessage}\nlocal_screenshot=${screenshotPath}`
                : localPermissionAutoMessage;
              this.workspace.appendStep(
                session,
                step,
                autoThought,
                JSON.stringify(autoAction, null, 2),
                stepResult,
              );
              traces.push({
                step,
                action: autoAction,
                result: stepResult,
                thought: autoThought,
                currentApp: snapshot.currentApp,
              });

              if (onProgress && step % this.config.agent.progressReportInterval === 0) {
                try {
                  await onProgress({
                    step,
                    maxSteps: this.config.agent.maxSteps,
                    currentApp: snapshot.currentApp,
                    actionType: autoAction.type,
                    message: localPermissionAutoMessage,
                    thought: autoThought,
                    screenshotPath,
                  });
                } catch {
                  // Keep task execution unaffected when progress callback fails.
                }
              }

              await sleep(Math.min(this.config.agent.loopDelayMs, 1200));
              continue;
            }

            await sleep(Math.min(this.config.agent.loopDelayMs, 500));
          } else if (permissionCapabilityOnly) {
            const autoThought =
              "Permission authorization belongs to the emulator. Waiting for local permission dialog instead of human auth.";
            localPermissionAutoMessage =
              "permission capability requested outside permission dialog; skipping human auth and waiting for local dialog";
            const autoAction: AgentAction = {
              type: "wait",
              durationMs: 600,
              reason: "auto_vm_permission_wait_dialog",
            };
            const stepResult = screenshotPath
              ? `${localPermissionAutoMessage}\nlocal_screenshot=${screenshotPath}`
              : localPermissionAutoMessage;
            this.workspace.appendStep(
              session,
              step,
              autoThought,
              JSON.stringify(autoAction, null, 2),
              stepResult,
            );
            traces.push({
              step,
              action: autoAction,
              result: stepResult,
              thought: autoThought,
              currentApp: snapshot.currentApp,
            });
            history.push(
              `step ${step}: app=${snapshot.currentApp} action=${autoAction.type}(auto_vm_permission_policy) message=${localPermissionAutoMessage}`,
            );

            if (onProgress && step % this.config.agent.progressReportInterval === 0) {
              try {
                await onProgress({
                  step,
                  maxSteps: this.config.agent.maxSteps,
                  currentApp: snapshot.currentApp,
                  actionType: autoAction.type,
                  message: localPermissionAutoMessage,
                  thought: autoThought,
                  screenshotPath,
                });
              } catch {
                // Keep task execution unaffected when progress callback fails.
              }
            }

            await sleep(Math.min(this.config.agent.loopDelayMs, 1200));
            continue;
          }

          const timeoutSec = Math.max(
            30,
            Math.round(output.action.timeoutSec ?? this.config.humanAuth.requestTimeoutSec),
          );

          if (!onHumanAuth) {
            const message = `Human authorization required (${output.action.capability}), but no human auth handler is configured.`;
            const stepResult = screenshotPath
              ? `${message}\nlocal_screenshot=${screenshotPath}`
              : message;
            this.workspace.appendStep(
              session,
              step,
              output.thought,
              JSON.stringify(output.action, null, 2),
              stepResult,
            );
            traces.push({
              step,
              action: output.action,
              result: stepResult,
              thought: output.thought,
              currentApp: snapshot.currentApp,
            });
            this.workspace.finalizeSession(session, false, message);
            this.workspace.appendDailyMemory(profileKey, task, false, message);
            return {
              ok: false,
              message,
              sessionPath: session.path,
              skillPath: null,
              scriptPath: null,
            };
          }

          let decision: HumanAuthDecision;
          try {
            decision = await onHumanAuth({
              sessionId: session.id,
              sessionPath: session.path,
              task,
              step,
              capability: output.action.capability,
              instruction: output.action.instruction,
              reason: output.action.reason ?? output.thought,
              timeoutSec,
              currentApp: snapshot.currentApp,
              screenshotPath,
            });
          } catch (error) {
            decision = {
              requestId: "local-error",
              approved: false,
              status: "rejected",
              message: `Human auth bridge error: ${(error as Error).message}`,
              decidedAt: nowIso(),
              artifactPath: null,
            };
          }

          const delegation = await this.applyHumanDelegation(
            output.action.capability,
            decision,
            snapshot.currentApp,
          );
          const delegationResult = delegation?.message ?? null;
          const delegationTemplate = delegation?.templateHint ?? null;
          const decisionLine = delegationResult
            ? `Human auth ${decision.status} request_id=${decision.requestId} message=${decision.message} delegation=${delegationResult}`
            : `Human auth ${decision.status} request_id=${decision.requestId} message=${decision.message}`;
          const stepResultBaseRaw = decision.artifactPath
            ? `${decisionLine}\nhuman_artifact=${decision.artifactPath}`
            : decisionLine;
          const stepResultBase = localPermissionAutoMessage
            ? `${stepResultBaseRaw}\nlocal_vm_permission=${localPermissionAutoMessage}`
            : stepResultBaseRaw;
          const stepResultWithDelegation = delegationResult
            ? `${stepResultBase}\ndelegation_result=${delegationResult}${delegationTemplate ? `\ndelegation_template=${delegationTemplate}` : ""}`
            : stepResultBase;
          const stepResult = screenshotPath
            ? `${stepResultWithDelegation}\nlocal_screenshot=${screenshotPath}`
            : stepResultWithDelegation;

          this.workspace.appendStep(
            session,
            step,
            output.thought,
            JSON.stringify(output.action, null, 2),
            stepResult,
          );
          traces.push({
            step,
            action: output.action,
            result: stepResult,
            thought: output.thought,
            currentApp: snapshot.currentApp,
          });
          history.push(
            `step ${step}: app=${snapshot.currentApp} action=request_human_auth decision=${decision.status} message=${decision.message}${delegationResult ? ` delegation=${delegationResult}` : ""}`,
          );
          if (delegationTemplate) {
            history.push(`delegation_template ${delegationTemplate}`);
          }

          if (onProgress && step % this.config.agent.progressReportInterval === 0) {
            try {
              await onProgress({
                step,
                maxSteps: this.config.agent.maxSteps,
                currentApp: snapshot.currentApp,
                actionType: output.action.type,
                message: decisionLine,
                thought: output.thought,
                screenshotPath,
              });
            } catch {
              // Keep task execution unaffected when progress callback fails.
            }
          }

          if (!decision.approved) {
            const message = `Human authorization ${decision.status}: ${decision.message}`;
            this.workspace.finalizeSession(session, false, message);
            this.workspace.appendDailyMemory(profileKey, task, false, message);
            return {
              ok: false,
              message,
              sessionPath: session.path,
              skillPath: null,
              scriptPath: null,
            };
          }

          await sleep(Math.min(this.config.agent.loopDelayMs, 1200));
          continue;
        }

        if (output.action.type === "request_user_decision") {
          const timeoutSec = Math.max(20, Math.round(output.action.timeoutSec ?? 300));
          if (!onUserDecision) {
            const message = "User decision required, but no decision handler is configured.";
            const stepResult = screenshotPath
              ? `${message}\nlocal_screenshot=${screenshotPath}`
              : message;
            this.workspace.appendStep(
              session,
              step,
              output.thought,
              JSON.stringify(output.action, null, 2),
              stepResult,
            );
            traces.push({
              step,
              action: output.action,
              result: stepResult,
              thought: output.thought,
              currentApp: snapshot.currentApp,
            });
            this.workspace.finalizeSession(session, false, message);
            this.workspace.appendDailyMemory(profileKey, task, false, message);
            return {
              ok: false,
              message,
              sessionPath: session.path,
              skillPath: null,
              scriptPath: null,
            };
          }

          let decision: UserDecisionResponse;
          try {
            decision = await onUserDecision({
              sessionId: session.id,
              sessionPath: session.path,
              task,
              step,
              question: output.action.question,
              options: output.action.options,
              timeoutSec,
              currentApp: snapshot.currentApp,
              screenshotPath,
            });
          } catch (error) {
            const message = `User decision wait failed: ${(error as Error).message}`;
            const stepResult = screenshotPath
              ? `${message}\nlocal_screenshot=${screenshotPath}`
              : message;
            this.workspace.appendStep(
              session,
              step,
              output.thought,
              JSON.stringify(output.action, null, 2),
              stepResult,
            );
            traces.push({
              step,
              action: output.action,
              result: stepResult,
              thought: output.thought,
              currentApp: snapshot.currentApp,
            });
            this.workspace.finalizeSession(session, false, message);
            this.workspace.appendDailyMemory(profileKey, task, false, message);
            return {
              ok: false,
              message,
              sessionPath: session.path,
              skillPath: null,
              scriptPath: null,
            };
          }

          const choiceLine = `user_decision selected="${decision.selectedOption}" raw="${decision.rawInput}" at=${decision.resolvedAt}`;
          const stepResult = screenshotPath
            ? `${choiceLine}\nlocal_screenshot=${screenshotPath}`
            : choiceLine;
          this.workspace.appendStep(
            session,
            step,
            output.thought,
            JSON.stringify(output.action, null, 2),
            stepResult,
          );
          traces.push({
            step,
            action: output.action,
            result: stepResult,
            thought: output.thought,
            currentApp: snapshot.currentApp,
          });
          history.push(
            `step ${step}: app=${snapshot.currentApp} action=request_user_decision question=${JSON.stringify(output.action.question)} selected=${JSON.stringify(decision.selectedOption)}`,
          );
          history.push(`user decision raw input: ${decision.rawInput}`);

          if (onProgress && step % this.config.agent.progressReportInterval === 0) {
            try {
              await onProgress({
                step,
                maxSteps: this.config.agent.maxSteps,
                currentApp: snapshot.currentApp,
                actionType: output.action.type,
                message: `User selected: ${decision.selectedOption}`,
                thought: output.thought,
                screenshotPath,
              });
            } catch {
              // Keep task execution unaffected when progress callback fails.
            }
          }
          await sleep(Math.min(this.config.agent.loopDelayMs, 600));
          continue;
        }

        output.action = this.resolveTapElementAction(output.action, snapshot);

        // Save debug screenshot with marker overlay before scaling coordinates.
        if (
          this.config.screenshots.saveStepScreenshots &&
          (output.action.type === "tap" || output.action.type === "swipe")
        ) {
          try {
            const scaledBuf = Buffer.from(snapshot.screenshotBase64, "base64");
            const annotated = await drawDebugMarker(scaledBuf, output.action);
            this.screenshotStore.save(annotated, {
              sessionId: session.id,
              step,
              currentApp: `${snapshot.currentApp}-debug`,
            });
          } catch {
            // Debug overlay is best-effort; don't break the task loop.
          }
        }

        // Scale model-returned coordinates back to original device resolution.
        if (output.action.type === "tap") {
          const scaled = scaleCoordinates(
            output.action.x, output.action.y,
            snapshot.scaleX, snapshot.scaleY,
            snapshot.width, snapshot.height,
          );
          output.action.x = scaled.x;
          output.action.y = scaled.y;
        } else if (output.action.type === "swipe") {
          const p1 = scaleCoordinates(
            output.action.x1, output.action.y1,
            snapshot.scaleX, snapshot.scaleY,
            snapshot.width, snapshot.height,
          );
          const p2 = scaleCoordinates(
            output.action.x2, output.action.y2,
            snapshot.scaleX, snapshot.scaleY,
            snapshot.width, snapshot.height,
          );
          output.action.x1 = p1.x;
          output.action.y1 = p1.y;
          output.action.x2 = p2.x;
          output.action.y2 = p2.y;
        }

        let executionResult = "";
        let stateDeltaLine = "";
        try {
          if (output.action.type === "run_script") {
            const scriptResult = await this.scriptExecutor.execute(
              output.action.script,
              output.action.timeoutSec,
            );
            executionResult = [
              `run_script exitCode=${scriptResult.exitCode} timedOut=${scriptResult.timedOut}`,
              `runDir=${scriptResult.runDir}`,
              scriptResult.stdout ? `stdout=${scriptResult.stdout}` : "",
              scriptResult.stderr ? `stderr=${scriptResult.stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          } else if (
            output.action.type === "read" ||
            output.action.type === "write" ||
            output.action.type === "edit" ||
            output.action.type === "apply_patch" ||
            output.action.type === "exec" ||
            output.action.type === "process"
          ) {
            executionResult = await this.codingExecutor.execute(output.action);
          } else if (
            output.action.type === "memory_search" ||
            output.action.type === "memory_get"
          ) {
            executionResult = this.memoryExecutor.execute(output.action);
          } else {
            executionResult = await this.adb.executeAction(output.action, this.config.agent.deviceId);
          }

          const shouldObserveDelta =
            output.action.type === "tap" ||
            output.action.type === "swipe" ||
            output.action.type === "type" ||
            output.action.type === "keyevent" ||
            output.action.type === "launch_app" ||
            output.action.type === "shell";
          if (shouldObserveDelta) {
            try {
              const afterSnapshot = await this.adb.captureScreenSnapshot(this.config.agent.deviceId, profile.model);
              const beforeState = this.observeSnapshotState(snapshot);
              const afterState = this.observeSnapshotState(afterSnapshot);
              stateDeltaLine = this.buildStateDeltaLine(beforeState, afterState, output.action.type);
            } catch {
              stateDeltaLine = "";
            }
          }
        } catch (error) {
          executionResult = `Action execution error: ${(error as Error).message}`;
        }

        if (this.lastResolvedTapElementContext) {
          const mark = this.lastResolvedTapElementContext;
          const markLine =
            `tap_mark id=${mark.id} label=${JSON.stringify(mark.label)} class=${mark.className || "unknown"} clickable=${mark.clickable} center=(${mark.center.x},${mark.center.y}) scaled_center=(${mark.scaledCenter.x},${mark.scaledCenter.y}) bounds=[${mark.bounds.left},${mark.bounds.top}][${mark.bounds.right},${mark.bounds.bottom}] scaled_bounds=[${mark.scaledBounds.left},${mark.scaledBounds.top}][${mark.scaledBounds.right},${mark.scaledBounds.bottom}]`;
          executionResult = `${executionResult}\n${markLine}`;
        }
        if (stateDeltaLine) {
          executionResult = `${executionResult}\n${stateDeltaLine}`;
        }

        const stepResult = screenshotPath
          ? `${executionResult}\nlocal_screenshot=${screenshotPath}`
          : executionResult;
        this.workspace.appendStep(
          session,
          step,
          output.thought,
          JSON.stringify(output.action, null, 2),
          stepResult,
        );
        traces.push({
          step,
          action: output.action,
          result: stepResult,
          thought: output.thought,
          currentApp: snapshot.currentApp,
        });

        history.push(
          `step ${step}: app=${snapshot.currentApp} thought="${output.thought}" action=${output.action.type} result=${executionResult}`,
        );

        if (this.config.agent.verbose) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][step ${step}] ${output.action.type}: ${executionResult}`);
        }

        if (onProgress && step % this.config.agent.progressReportInterval === 0) {
          try {
            await onProgress({
              step,
              maxSteps: this.config.agent.maxSteps,
              currentApp: snapshot.currentApp,
              actionType: output.action.type,
              message: executionResult,
              thought: output.thought,
              screenshotPath,
            });
          } catch {
            // Keep task execution unaffected when progress callback fails.
          }
        }

        if (output.action.type !== "wait") {
          await sleep(this.config.agent.loopDelayMs);
        }
      }

      const message = `Max steps reached (${this.config.agent.maxSteps})`;
      this.workspace.finalizeSession(session, false, message);
      this.workspace.appendDailyMemory(profileKey, task, false, message);
      return {
        ok: false,
        message,
        sessionPath: session.path,
        skillPath: null,
        scriptPath: null,
      };
    } catch (error) {
      const message = `Agent execution failed: ${(error as Error).message}`;
      this.workspace.finalizeSession(session, false, message);
      this.workspace.appendDailyMemory(profileKey, task, false, message);
      return {
        ok: false,
        message,
        sessionPath: session.path,
        skillPath: null,
        scriptPath: null,
      };
    } finally {
      if (shouldReturnHome) {
        await this.safeReturnToHome();
      }
      this.busy = false;
      this.currentTask = null;
      this.currentTaskStartedAtMs = null;
      this.stopRequested = false;
    }
  }
}
