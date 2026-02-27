import TelegramBot, { type Message } from "node-telegram-bot-api";
import fs from "node:fs";
import path from "node:path";

import type {
  AgentProgressUpdate,
  CronJob,
  OpenPocketConfig,
  UserDecisionRequest,
  UserDecisionResponse,
  UserInputRequest,
  UserInputResponse,
} from "../types.js";
import { saveConfig } from "../config/index.js";
import { AgentRuntime } from "../agent/agent-runtime.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import { extractPackageName } from "../device/adb-runtime.js";
import { deviceTargetLabel, isEmulatorTarget } from "../device/target-types.js";
import { HumanAuthBridge } from "../human-auth/bridge.js";
import { LocalHumanAuthStack } from "../human-auth/local-stack.js";
import { ChatAssistant } from "./chat-assistant.js";
import { CronService, type CronRunResult } from "./cron-service.js";
import { HeartbeatRunner } from "./heartbeat-runner.js";

export const TELEGRAM_MENU_COMMANDS: TelegramBot.BotCommand[] = [
  { command: "start", description: "Start or resume chat onboarding" },
  { command: "help", description: "Show command help" },
  { command: "context", description: "Inspect injected prompt context" },
  { command: "status", description: "Show gateway and device status" },
  { command: "model", description: "Show or switch model profile" },
  { command: "startvm", description: "Start Android emulator" },
  { command: "stopvm", description: "Stop Android emulator" },
  { command: "hidevm", description: "Hide emulator window" },
  { command: "showvm", description: "Show emulator window" },
  { command: "screen", description: "Capture manual screenshot" },
  { command: "skills", description: "List loaded skills" },
  { command: "clear", description: "Clear chat memory only" },
  { command: "new", description: "Start a new task session" },
  { command: "reset", description: "Clear chat memory and stop task" },
  { command: "stop", description: "Stop current running task" },
  { command: "restart", description: "Restart gateway process loop" },
  { command: "cronrun", description: "Trigger cron job by id" },
  { command: "auth", description: "Human auth helper commands" },
  { command: "run", description: "Force task mode with text" },
];

export interface TelegramGatewayOptions {
  onLogLine?: (line: string) => void;
  typingIntervalMs?: number;
  logger?: (line: string) => void;
}

type ProgressNarrationState = {
  lastNotifiedProgress: AgentProgressUpdate | null;
  lastNotifiedMessage: string;
  skippedSteps: number;
  recentProgress: AgentProgressUpdate[];
  allProgress: AgentProgressUpdate[];
};

type BotDisplayNameSyncState = {
  lastSyncedName?: string;
  retryAfterUntilMs?: number;
};

type OnboardingStateSnapshot = {
  updatedAt?: string;
  gmailLoginConfirmedAt?: string | null;
  playStoreDetected?: boolean | null;
  [key: string]: unknown;
};

type PendingUserDecision = {
  request: UserDecisionRequest;
  resolve: (value: UserDecisionResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type PendingUserInput = {
  request: UserInputRequest;
  resolve: (value: UserInputResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ChatContextSensitivity = "non_sensitive" | "sensitive";
type ChatContextItemSource = "plain_chat" | "request_user_input";

type ChatContextItem = {
  key: string;
  value: string;
  sensitivity: ChatContextSensitivity;
  source: ChatContextItemSource;
  updatedAt: string;
};

type ChatContextPair = {
  key: string;
  value: string;
};

type ChatContextExtractor = {
  id: string;
  extractFromPlainText?: (text: string) => ChatContextPair[];
  extractFromUserInput?: (request: UserInputRequest, text: string) => ChatContextPair[];
};

type QueuedChatTask = {
  chatId: number;
  task: string;
  sessionKey: string;
  onDone?: (result: CronRunResult) => void | Promise<void>;
};

export class TelegramGateway {
  private readonly config: OpenPocketConfig;
  private readonly emulator: EmulatorManager;
  private readonly agent: AgentRuntime;
  private readonly bot: TelegramBot;
  private readonly cron: CronService;
  private readonly heartbeat: HeartbeatRunner;
  private readonly humanAuth: HumanAuthBridge;
  private readonly localHumanAuthStack: LocalHumanAuthStack;
  private localHumanAuthActive = false;
  private chat: ChatAssistant;
  private readonly writeLogLine: (line: string) => void;
  private readonly typingIntervalMs: number;
  private readonly typingSessions = new Map<number, { refs: number; timer: NodeJS.Timeout }>();
  private readonly pendingUserDecisions = new Map<number, PendingUserDecision>();
  private readonly pendingUserInputs = new Map<number, PendingUserInput>();
  private readonly chatContextStore = new Map<number, Map<string, ChatContextItem>>();
  private readonly chatContextExtractors: ChatContextExtractor[];
  private readonly pendingChatTasks: QueuedChatTask[] = [];
  private drainingChatTaskQueue = false;
  private lastSyncedBotDisplayName: string | null = null;
  private readonly botDisplayNameSyncStatePath: string;
  private botDisplayNameRateLimitedUntilMs = 0;
  private playStorePreflightPassed = false;
  private playStorePreflightTriggered = false;
  private playStorePreflightDeferredNotified = false;
  private running = false;
  private stoppedPromise: Promise<void> | null = null;
  private stopResolver: (() => void) | null = null;
  private static readonly CHAT_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;

  constructor(config: OpenPocketConfig, options?: TelegramGatewayOptions) {
    this.config = config;
    this.emulator = new EmulatorManager(config);
    this.agent = new AgentRuntime(config);
    this.chat = new ChatAssistant(config);
    this.chatContextExtractors = this.buildChatContextExtractors();
    const onLogLine = options?.onLogLine ?? null;
    const logger =
      options?.logger ??
      ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      });
    this.writeLogLine = (line: string) => {
      logger(line);
      onLogLine?.(line);
    };
    this.typingIntervalMs = Math.max(50, Math.round(options?.typingIntervalMs ?? 4000));

    const token =
      config.telegram.botToken.trim() ||
      (config.telegram.botTokenEnv ? process.env[config.telegram.botTokenEnv]?.trim() : "") ||
      "";

    if (!token) {
      throw new Error(
        `Telegram bot token is empty. Set config.telegram.botToken or env ${config.telegram.botTokenEnv}.`,
      );
    }

    this.bot = new TelegramBot(token, {
      polling: {
        interval: 1000,
        params: {
          timeout: config.telegram.pollTimeoutSec,
        },
      },
    });

    this.humanAuth = new HumanAuthBridge(config);
    this.localHumanAuthStack = new LocalHumanAuthStack(config, (line) => this.writeLogLine(line));

    this.heartbeat = new HeartbeatRunner(config, {
      log: (line) => {
        this.writeLogLine(line);
      },
      readSnapshot: () => {
        const status = this.emulator.status();
        return {
          busy: this.agent.isBusy(),
          currentTask: this.agent.getCurrentTask(),
          taskRuntimeMs: this.agent.getCurrentTaskRuntimeMs(),
          devices: status.devices.length,
          bootedDevices: status.bootedDevices.length,
        };
      },
    });

    this.cron = new CronService(config, {
      runTask: async (job) => this.runScheduledJob(job),
      log: (line) => {
        this.writeLogLine(line);
      },
    });

    this.botDisplayNameSyncStatePath = path.join(this.config.stateDir, "telegram-bot-name-sync.json");
    this.restoreBotDisplayNameSyncState();
  }

  private log(message: string): void {
    const line = `[OpenPocket][gateway] ${new Date().toISOString()} ${message}`;
    this.writeLogLine(line);
  }

  private durationMsBetween(startHr: bigint, endHr: bigint): number {
    const elapsedNs = endHr - startHr;
    if (elapsedNs <= 0n) {
      return 0;
    }
    const durationMs = Number(elapsedNs / 1_000_000n);
    if (durationMs > 0) {
      return durationMs;
    }
    return 1;
  }

  private durationMsSince(startHr: bigint): number {
    return this.durationMsBetween(startHr, process.hrtime.bigint());
  }

  isRunning(): boolean {
    return this.running;
  }

  private compact(text: string, maxChars: number): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxChars) {
      return oneLine;
    }
    return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private compactMultiline(text: string, maxChars: number): string {
    const normalized = String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  private sanitizeForChat(text: string, maxChars: number): string {
    const withoutInternalLines = text
      .split("\n")
      .filter((line) => !/^\s*(Session|Auto skill|Auto script)\s*:/i.test(line))
      .join("\n");

    const redacted = withoutInternalLines
      .replace(/local_screenshot=\S+/gi, "local_screenshot=[saved locally]")
      .replace(/runDir=\S+/gi, "runDir=[local-dir]")
      .replace(/\/(?:Users|home|var|tmp)\/[^\s)\]]+/g, "[local-path]")
      .replace(/[A-Za-z]:\\[^\s)\]]+/g, "[local-path]");

    return this.compact(redacted, maxChars);
  }

  private sanitizeForChatMultiline(text: string, maxChars: number): string {
    const withoutInternalLines = String(text || "")
      .split("\n")
      .filter((line) => !/^\s*(Session|Auto skill|Auto script)\s*:/i.test(line))
      .join("\n");

    const redacted = withoutInternalLines
      .replace(/local_screenshot=\S+/gi, "local_screenshot=[saved locally]")
      .replace(/runDir=\S+/gi, "runDir=[local-dir]")
      .replace(/\/(?:Users|home|var|tmp)\/[^\s)\]]+/g, "[local-path]")
      .replace(/[A-Za-z]:\\[^\s)\]]+/g, "[local-path]");

    return this.compactMultiline(redacted, maxChars);
  }

  private escapeTelegramHtml(text: string): string {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private stripHumanAuthNarrationNoise(text: string): string {
    return String(text || "")
      .replace(/Once you['’]?ve done that,?\s*send (?:a )?(?:quick )?confirmation(?: here| in Telegram)?\.?/gi, "")
      .replace(/Then send (?:a )?confirmation(?: here| in Telegram)?\.?/gi, "")
      .replace(/then return to Telegram\.?/gi, "")
      .replace(/然后回到\s*Telegram[^。！？.!?]*[。！？.!?]?/gi, "")
      .replace(/完成后(?:再)?(?:在|回到)?\s*Telegram[^。！？.!?]*[。！？.!?]?/gi, "")
      .replace(/Security note:[^.。!?！？]*(?:[.。!?！？]|$)/gi, "")
      .replace(/安全提示：[^。！？]*(?:[。！？]|$)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private humanAuthSecurityNote(locale: "zh" | "en"): string {
    return locale === "zh"
      ? "该授权页连接你本机上的 OpenPocket Relay；凭据仅通过当前私有加密通道传输，不会存入中心化 OpenPocket Relay。"
      : "This auth page connects to your local OpenPocket relay. Credentials are transmitted only through a private encrypted channel and are never stored in a centralized OpenPocket relay.";
  }

  private buildHumanAuthHtmlMessage(narration: string, locale: "zh" | "en", extraLines?: string[]): string {
    const cleanedNarration = this.stripHumanAuthNarrationNoise(this.sanitizeForChat(narration, 1500));
    const payloadLines: string[] = [];
    if (cleanedNarration) {
      payloadLines.push(this.escapeTelegramHtml(cleanedNarration));
    }
    if (Array.isArray(extraLines) && extraLines.length > 0) {
      const formatted = extraLines
        .map((line) => this.sanitizeForChat(String(line || ""), 500).trim())
        .filter(Boolean)
        .map((line) => (/^\/auth\s+/i.test(line)
          ? `<code>${this.escapeTelegramHtml(line)}</code>`
          : this.escapeTelegramHtml(line)));
      if (formatted.length > 0) {
        payloadLines.push("");
        payloadLines.push(...formatted);
      }
    }
    const securityTitle = locale === "zh" ? "安全提示" : "Security note";
    payloadLines.push("");
    payloadLines.push(`<b>${securityTitle}:</b> ${this.escapeTelegramHtml(this.humanAuthSecurityNote(locale))}`);
    return payloadLines.join("\n");
  }

  private normalizeHumanAuthCurrentAppToken(app: string): string | null {
    const value = String(app || "").trim();
    if (!value) {
      return null;
    }
    const lower = value.toLowerCase();
    if (lower === "unknown" || lower === "n/a" || lower === "null" || lower === "(null)") {
      return null;
    }
    return value;
  }

  private extractPackageNameFromWindowDump(windowDump: string): string | null {
    const result = extractPackageName(windowDump);
    return this.normalizeHumanAuthCurrentAppToken(result);
  }

  private resolveHumanAuthCurrentApp(appHint: string): string | null {
    const provided = this.normalizeHumanAuthCurrentAppToken(appHint);
    if (provided) {
      return provided;
    }
    try {
      const status = this.emulator.status();
      const probeDevices = status.bootedDevices.length > 0 ? status.bootedDevices : status.devices;
      for (const deviceId of probeDevices) {
        try {
          const dump = this.emulator.runAdb(["-s", deviceId, "shell", "dumpsys", "window", "windows"], 15_000);
          const parsed = this.extractPackageNameFromWindowDump(dump);
          if (parsed) {
            return parsed;
          }
        } catch {
          // Continue probing next available device.
        }
      }
    } catch {
      // Best-effort current-app probe; ignore probe failures.
    }
    return null;
  }

  private normalizeBotDisplayName(input: string): string {
    const normalized = input.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "";
    }
    // Telegram bot display name max length is 64 chars.
    return normalized.slice(0, 64);
  }

  private restoreBotDisplayNameSyncState(): void {
    if (!fs.existsSync(this.botDisplayNameSyncStatePath)) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.botDisplayNameSyncStatePath, "utf-8")) as BotDisplayNameSyncState;
      const cachedName =
        parsed && typeof parsed.lastSyncedName === "string" ? this.normalizeBotDisplayName(parsed.lastSyncedName) : "";
      if (cachedName) {
        this.lastSyncedBotDisplayName = cachedName;
      }
      const retryAfterUntilMs = parsed && typeof parsed.retryAfterUntilMs === "number" ? parsed.retryAfterUntilMs : 0;
      if (Number.isFinite(retryAfterUntilMs) && retryAfterUntilMs > Date.now()) {
        this.botDisplayNameRateLimitedUntilMs = Math.trunc(retryAfterUntilMs);
      }
    } catch {
      // Ignore invalid local cache payload and continue with runtime defaults.
    }
  }

  private persistBotDisplayNameSyncState(): void {
    const payload: BotDisplayNameSyncState = {};
    if (this.lastSyncedBotDisplayName) {
      payload.lastSyncedName = this.lastSyncedBotDisplayName;
    }
    if (this.botDisplayNameRateLimitedUntilMs > Date.now()) {
      payload.retryAfterUntilMs = this.botDisplayNameRateLimitedUntilMs;
    }

    try {
      if (!payload.lastSyncedName && !payload.retryAfterUntilMs) {
        if (fs.existsSync(this.botDisplayNameSyncStatePath)) {
          fs.unlinkSync(this.botDisplayNameSyncStatePath);
        }
        return;
      }
      fs.writeFileSync(this.botDisplayNameSyncStatePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    } catch {
      // Ignore local cache persistence errors.
    }
  }

  private getBotDisplayNameRetryAfterSec(nowMs = Date.now()): number {
    if (this.botDisplayNameRateLimitedUntilMs <= nowMs) {
      return 0;
    }
    return Math.max(1, Math.ceil((this.botDisplayNameRateLimitedUntilMs - nowMs) / 1000));
  }

  private parseTelegramRetryAfterSec(error: unknown): number {
    const typed = error as { response?: { body?: { parameters?: { retry_after?: unknown } } } };
    const structured = typed.response?.body?.parameters?.retry_after;
    if (typeof structured === "number" && Number.isFinite(structured) && structured > 0) {
      return Math.ceil(structured);
    }
    const message = String((error as Error)?.message ?? "");
    const match = message.match(/retry after\s+(\d+)/i);
    if (!match) {
      return 0;
    }
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }
    return Math.ceil(parsed);
  }

  private markBotDisplayNameRateLimited(retryAfterSec: number): void {
    if (retryAfterSec <= 0) {
      return;
    }
    const nextUntil = Date.now() + retryAfterSec * 1000;
    if (nextUntil > this.botDisplayNameRateLimitedUntilMs) {
      this.botDisplayNameRateLimitedUntilMs = nextUntil;
      this.persistBotDisplayNameSyncState();
    }
  }

  private onboardingStatePath(): string {
    return path.join(this.config.stateDir, "onboarding.json");
  }

  private readOnboardingState(): OnboardingStateSnapshot {
    const filePath = this.onboardingStatePath();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as OnboardingStateSnapshot;
      }
      return {};
    } catch {
      return {};
    }
  }

  private persistOnboardingStatePatch(patch: Partial<OnboardingStateSnapshot>): void {
    const filePath = this.onboardingStatePath();
    const current = this.readOnboardingState();
    const next: OnboardingStateSnapshot = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    } catch {
      // Ignore onboarding state persistence errors.
    }
  }

  private resolveBootedDeviceForPlayStoreCheck(): string | null {
    const status = this.emulator.status();
    const preferred = this.config.agent.deviceId?.trim() ?? "";
    if (preferred && status.bootedDevices.includes(preferred)) {
      return preferred;
    }
    return status.bootedDevices[0] ?? null;
  }

  private detectPlayStoreInstalled(deviceId: string): boolean | null {
    try {
      const output = this.emulator.runAdb(["-s", deviceId, "shell", "pm", "path", "com.android.vending"], 15_000);
      return output.includes("package:");
    } catch {
      return null;
    }
  }

  private detectGoogleAccountSignedIn(deviceId: string): boolean | null {
    try {
      const output = this.emulator.runAdb(["-s", deviceId, "shell", "dumpsys", "account"], 20_000);
      return /type=com\.google/i.test(output);
    } catch {
      return null;
    }
  }

  private playStoreRemoteLoginTask(locale: "zh" | "en"): string {
    if (locale === "zh") {
      return [
        "检查 Android 系统 Google 账号是否已登录（可从 Play Store 入口进入）。",
        "如果未登录，完成系统级 Google 账号登录流程。",
        "首次需要凭据时，发起 request_human_auth(oauth)，一次性让用户提供邮箱和密码。",
        "Google 登录是分步页面：先邮箱 Next，再密码。后续步骤优先复用已获得凭据；仅在缺失或失败时再请求用户补充。",
        "登录完成后，确认系统 Google 账号已登录，并验证 Play Store 可搜索/安装应用，然后结束任务。",
      ].join(" ");
    }
    return [
      "Check whether Android system Google account is signed in (entry can be through Play Store).",
      "If not signed in, complete the system-level Google account sign-in flow.",
      "At first credential prompt, trigger request_human_auth(oauth) and ask for email+password together in one submission.",
      "Google login is split across pages (email then Next, then password). Reuse cached credentials for follow-up steps and only ask again if missing or failed.",
      "After sign-in succeeds, verify system Google account is signed in and Play Store can search/install apps, then finish.",
    ].join(" ");
  }

  private async ensurePlayStoreReady(chatId: number, locale: "zh" | "en"): Promise<boolean> {
    if (!isEmulatorTarget(this.config.target.type)) {
      this.playStorePreflightPassed = true;
      return false;
    }
    if (this.playStorePreflightPassed) {
      return false;
    }
    if (this.playStorePreflightTriggered) {
      return true;
    }

    const deviceId = this.resolveBootedDeviceForPlayStoreCheck();
    if (!deviceId) {
      if (!this.playStorePreflightDeferredNotified) {
        this.playStorePreflightDeferredNotified = true;
        await this.bot.sendMessage(
          chatId,
          locale === "zh"
            ? "Play Store 检查已排队：当前还没有检测到已启动的模拟器。等模拟器启动后我会自动重试。"
            : "Play Store preflight is queued: no booted emulator detected yet. I will retry automatically after the emulator boots.",
        );
      }
      return false;
    }
    this.playStorePreflightDeferredNotified = false;

    const playStoreInstalled = this.detectPlayStoreInstalled(deviceId);
    if (playStoreInstalled === false) {
      this.persistOnboardingStatePatch({ playStoreDetected: false });
      await this.bot.sendMessage(
        chatId,
        locale === "zh"
          ? "当前模拟器未检测到 Play Store（com.android.vending）。请使用带 Google Play 的系统镜像。"
          : "Play Store (com.android.vending) is not detected on this emulator. Use a Google Play system image.",
      );
      return false;
    }
    if (playStoreInstalled === true) {
      this.persistOnboardingStatePatch({ playStoreDetected: true });
    }

    const signedIn = this.detectGoogleAccountSignedIn(deviceId);
    if (signedIn === true) {
      this.playStorePreflightPassed = true;
      this.persistOnboardingStatePatch({
        gmailLoginConfirmedAt: new Date().toISOString(),
        playStoreDetected: true,
      });
      return false;
    }

    if (!this.config.humanAuth.enabled) {
      await this.bot.sendMessage(
        chatId,
        locale === "zh"
          ? "检测到系统 Google 账号未登录，但 humanAuth 未启用。请先在模拟器手动登录，随后我会自动重检。"
          : "System Google account is not signed in, but humanAuth is disabled. Please sign in manually in emulator and I will re-check automatically.",
      );
      return true;
    }

    await this.bot.sendMessage(
      chatId,
      locale === "zh"
        ? "正在检查系统 Google 账号登录状态，需要你授权时我会提示。"
        : "Checking system Google account sign-in now. I will prompt you only when authorization is needed.",
    );
    this.playStorePreflightTriggered = true;
    const accepted = await this.runTaskAsync(
      chatId,
      this.playStoreRemoteLoginTask(locale),
      {
        sessionKey: `telegram:playstore-preflight:${chatId}`,
        skipAcceptedMessage: true,
        onDone: async (result) => {
          this.playStorePreflightTriggered = false;
          if (!result.ok) {
            return;
          }
          const doneDeviceId = this.resolveBootedDeviceForPlayStoreCheck();
          if (!doneDeviceId) {
            return;
          }
          const signedInAfterTask = this.detectGoogleAccountSignedIn(doneDeviceId);
          if (signedInAfterTask === true) {
            this.playStorePreflightPassed = true;
            this.persistOnboardingStatePatch({
              gmailLoginConfirmedAt: new Date().toISOString(),
              playStoreDetected: true,
            });
          }
        },
      },
    );
    if (!accepted) {
      this.playStorePreflightTriggered = false;
    }
    return true;
  }

  private readAssistantNameFromIdentity(): string {
    const identityPath = path.join(this.config.workspaceDir, "IDENTITY.md");
    if (!fs.existsSync(identityPath)) {
      return "";
    }
    let raw = "";
    try {
      raw = fs.readFileSync(identityPath, "utf-8");
    } catch {
      return "";
    }
    // Match "- Name:" only inside the "## Agent Identity" section to avoid
    // picking up unrelated Name bullets from other sections.
    const sectionMatch = raw.match(/##\s*Agent\s+Identity\b[\s\S]*?(?=\n##\s|\n#\s|$)/i);
    const section = sectionMatch ? sectionMatch[0] : raw;
    const match = section.match(/^\s*-\s*Name\s*:\s*(.+)$/im);
    if (!match?.[1]) {
      return "";
    }
    return this.normalizeBotDisplayName(match[1]);
  }

  private async syncBotDisplayNameFromIdentity(): Promise<void> {
    const assistantName = this.readAssistantNameFromIdentity();
    if (!assistantName || assistantName === this.lastSyncedBotDisplayName) {
      return;
    }
    const retryAfterSec = this.getBotDisplayNameRetryAfterSec();
    if (retryAfterSec > 0) {
      this.log(`telegram bot display name startup-sync skipped: rate-limited retry_after=${retryAfterSec}s`);
      return;
    }
    try {
      await this.bot.setMyName({ name: assistantName });
      this.lastSyncedBotDisplayName = assistantName;
      this.botDisplayNameRateLimitedUntilMs = 0;
      this.persistBotDisplayNameSyncState();
      this.log(`telegram bot display name startup-sync name=${JSON.stringify(assistantName)}`);
    } catch (error) {
      const retry = this.parseTelegramRetryAfterSec(error);
      if (retry > 0) {
        this.markBotDisplayNameRateLimited(retry);
        this.log(`telegram bot display name startup-sync rate-limited retry_after=${retry}s`);
        return;
      }
      this.log(`telegram bot display name startup-sync failed: ${(error as Error).message}`);
    }
  }

  /**
   * Shared helper: run onboarding seed through chat.decide and send the reply.
   * Returns true if onboarding message was sent, false if onboarding is not pending.
   */
  private async trySendOnboardingReply(chatId: number, locale: "zh" | "en"): Promise<boolean> {
    if (!this.chat.isOnboardingPending()) {
      return false;
    }
    const onboardingSeed = locale === "zh" ? "你好" : "hello";
    const decision = await this.chat.decide(chatId, onboardingSeed);
    const reply = decision.reply || (
      locale === "zh"
        ? "我们先做一个简短初始化。"
        : "Let's do a quick onboarding first."
    );
    await this.bot.sendMessage(chatId, this.sanitizeForChat(reply, 1800));
    const profileUpdate = this.chat.consumePendingProfileUpdate(chatId);
    if (profileUpdate) {
      await this.syncBotDisplayName(chatId, profileUpdate.assistantName, profileUpdate.locale);
    }
    return true;
  }

  private estimateTokens(chars: number): number {
    return Math.ceil(Math.max(0, chars) / 4);
  }

  private formatChars(chars: number): string {
    return `${chars} chars (~${this.estimateTokens(chars)} tok)`;
  }

  private buildContextSummaryMessage(): string {
    const report = this.agent.getWorkspacePromptContextReport();
    const lines = [
      "Context breakdown:",
      `- source: ${report.source}`,
      `- prompt mode: ${report.promptMode}`,
      `- system prompt: ${this.formatChars(report.systemPrompt?.chars ?? 0)}`,
      `- workspace context: ${this.formatChars(report.totalIncludedChars)}`,
      `- limits: per-file=${report.maxCharsPerFile}, total=${report.maxCharsTotal}`,
      `- hook applied: ${Boolean(report.hookApplied)}`,
      `- skills: ${this.formatChars(report.skills?.promptChars ?? 0)} (${report.skills?.entries?.length ?? 0})`,
      `- active skills: ${this.formatChars(report.skills?.activePromptChars ?? 0)} (${report.skills?.activeEntries?.length ?? 0})`,
      `- tools list: ${this.formatChars(report.tools?.listChars ?? 0)}`,
      `- tools schema: ${this.formatChars(report.tools?.schemaChars ?? 0)}`,
      "",
      "Injected files:",
    ];
    for (const file of report.files) {
      const status = file.included ? "included" : file.budgetExhausted ? "budget-exhausted" : "skipped";
      lines.push(
        `- ${file.fileName}: ${status}, missing=${file.missing}, truncated=${file.truncated}, chars=${file.includedChars}/${file.originalChars}`,
      );
    }
    lines.push("");
    lines.push("Try `/context detail` for full breakdown, `/context detail <fileName>` for snippet, `/context json` for raw JSON.");
    return lines.join("\n");
  }

  private buildContextDeepDetailMessage(): string {
    const report = this.agent.getWorkspacePromptContextReport();
    const topSkills = [...(report.skills?.entries ?? [])]
      .sort((a, b) => b.blockChars - a.blockChars)
      .slice(0, 20);
    const topActiveSkills = [...(report.skills?.activeEntries ?? [])]
      .sort((a, b) => b.blockChars - a.blockChars)
      .slice(0, 20);
    const topToolsBySchema = [...(report.tools?.entries ?? [])]
      .sort((a, b) => b.schemaChars - a.schemaChars)
      .slice(0, 20);

    const lines = [
      "Context breakdown (detailed):",
      `- source: ${report.source}`,
      `- generatedAt: ${report.generatedAt}`,
      `- prompt mode: ${report.promptMode}`,
      `- system prompt: ${this.formatChars(report.systemPrompt?.chars ?? 0)}`,
      `  - workspace context chars: ${this.formatChars(report.systemPrompt?.workspaceContextChars ?? 0)}`,
      `  - non-workspace chars: ${this.formatChars(report.systemPrompt?.nonWorkspaceChars ?? 0)}`,
      `- workspace limits: per-file=${report.maxCharsPerFile}, total=${report.maxCharsTotal}`,
      `- workspace included: ${this.formatChars(report.totalIncludedChars)}`,
      "",
      "Injected workspace files:",
    ];

    for (const file of report.files) {
      const status = file.missing ? "MISSING" : file.truncated ? "TRUNCATED" : file.included ? "OK" : "SKIPPED";
      lines.push(
        `- ${file.fileName}: ${status} | raw ${this.formatChars(file.originalChars)} | injected ${this.formatChars(file.includedChars)}`,
      );
    }

    lines.push("");
    lines.push(`Skills prompt: ${this.formatChars(report.skills?.promptChars ?? 0)} (${report.skills?.entries?.length ?? 0} skills)`);
    if (topSkills.length > 0) {
      lines.push("Top skills by entry size:");
      for (const skill of topSkills) {
        lines.push(`- ${skill.name}: ${this.formatChars(skill.blockChars)} (${skill.source})`);
      }
    }

    lines.push(`Active skills prompt: ${this.formatChars(report.skills?.activePromptChars ?? 0)} (${report.skills?.activeEntries?.length ?? 0} skills)`);
    if (topActiveSkills.length > 0) {
      lines.push("Active skills selected for latest task:");
      for (const skill of topActiveSkills) {
        lines.push(`- ${skill.name}: ${this.formatChars(skill.blockChars)} (${skill.source}, score=${skill.score})`);
      }
    }

    lines.push("");
    lines.push(`Tools list: ${this.formatChars(report.tools?.listChars ?? 0)}`);
    lines.push(`Tools schema: ${this.formatChars(report.tools?.schemaChars ?? 0)} (${report.tools?.entries?.length ?? 0} tools)`);
    if (topToolsBySchema.length > 0) {
      lines.push("Top tools by schema size:");
      for (const tool of topToolsBySchema) {
        const paramsCount = tool.propertiesCount ?? 0;
        lines.push(`- ${tool.name}: ${this.formatChars(tool.schemaChars)} (${paramsCount} params)`);
      }
    }

    return lines.join("\n");
  }

  private buildContextFileDetailMessage(target: string): string {
    const report = this.agent.getWorkspacePromptContextReport();
    const normalizedTarget = target.trim().toLowerCase();
    if (!normalizedTarget) {
      return "Usage: /context detail <fileName>";
    }
    const file = report.files.find((item) => item.fileName.toLowerCase() === normalizedTarget);
    if (!file) {
      return `Unknown context file: ${target}`;
    }
    if (!file.included || !file.snippet) {
      return `No injected snippet for ${file.fileName} (missing=${file.missing}).`;
    }
    const snippet = file.snippet.length > 2400
      ? `${file.snippet.slice(0, 2400)}\n...[detail truncated]`
      : file.snippet;
    return [
      `${file.fileName}`,
      `included=${file.included}, missing=${file.missing}, truncated=${file.truncated}, chars=${file.includedChars}/${file.originalChars}`,
      "",
      snippet,
    ].join("\n");
  }

  private inferLocale(message: Message): "zh" | "en" {
    const languageCode = String(message.from?.language_code ?? "").toLowerCase();
    if (languageCode.startsWith("zh")) {
      return "zh";
    }
    const text = message.text ?? "";
    return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
  }

  private inferTaskLocale(task: string): "zh" | "en" {
    return /[\u4e00-\u9fff]/.test(task) ? "zh" : "en";
  }

  private buildChatContextExtractors(): ChatContextExtractor[] {
    return [
      {
        id: "generic_key_value_pairs",
        extractFromPlainText: (text) => this.extractGenericKeyValuePairs(text),
        extractFromUserInput: (request, text) => {
          const key = this.deriveUserInputContextKey(request);
          const value = this.normalizeContextValue(text);
          if (!key || !value) {
            return [];
          }
          return [{ key, value }];
        },
      },
    ];
  }

  private normalizeContextKey(rawKey: string, fallbackIndex: number): string {
    const ascii = String(rawKey || "")
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, " ")
      .toLowerCase();
    const normalized = ascii
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (normalized) {
      return normalized.slice(0, 48);
    }
    return `field_${Math.max(1, fallbackIndex)}`;
  }

  private normalizeContextValue(rawValue: string): string {
    return String(rawValue || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  private deriveUserInputContextKey(request: UserInputRequest): string {
    const normalized = String(request.question || "")
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const stopWords = new Set([
      "please",
      "provide",
      "share",
      "reply",
      "your",
      "the",
      "a",
      "an",
      "to",
      "with",
      "for",
      "and",
      "value",
      "requested",
      "text",
    ]);
    const tokens = normalized
      ? normalized
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1 && !stopWords.has(token))
      : [];
    if (tokens.length > 0) {
      return tokens.slice(0, 6).join("_");
    }
    const step = Number.isFinite(request.step) ? Math.max(1, Math.trunc(request.step)) : 1;
    return `user_input_step_${step}`;
  }

  private isSensitiveContextText(text: string): boolean {
    return /(password|passcode|otp|one[-\s]?time|verification|auth(?:orization)?\s*code|2fa|cvv|cvc|credit\s*card|debit\s*card|card\s*number|bank\s*account|ssn|social\s*security|passport|identity|id\s*number|银行卡|信用卡|借记卡|卡号|密码|验证码|一次性|支付|身份证|护照|社保)/i
      .test(String(text || ""));
  }

  private buildNonSensitiveChatContextItems(
    pairs: ChatContextPair[],
    source: ChatContextItemSource,
  ): ChatContextItem[] {
    const itemsByKey = new Map<string, ChatContextItem>();
    let fallbackIndex = 1;
    for (const pair of pairs) {
      const key = this.normalizeContextKey(pair.key, fallbackIndex);
      fallbackIndex += 1;
      const value = this.normalizeContextValue(pair.value);
      if (!key || !value) {
        continue;
      }
      if (this.isSensitiveContextText(`${key}\n${value}`)) {
        continue;
      }
      itemsByKey.set(key, {
        key,
        value,
        sensitivity: "non_sensitive",
        source,
        updatedAt: new Date().toISOString(),
      });
    }
    return [...itemsByKey.values()];
  }

  private extractGenericKeyValuePairs(text: string): ChatContextPair[] {
    const input = String(text || "").trim();
    if (!input || input.startsWith("/")) {
      return [];
    }
    const regex = /(^|[,\n;，；])\s*([^,\n;，；:=]{1,40})\s*[:：=]\s*([^,\n;，；]{1,120})/g;
    const pairs: ChatContextPair[] = [];
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(input)) !== null) {
      const key = String(match[2] || "").trim();
      const value = String(match[3] || "").trim();
      if (!key || !value) {
        continue;
      }
      pairs.push({ key, value });
    }
    return pairs;
  }

  private extractChatContextItemsFromPlainText(text: string): ChatContextItem[] {
    const pairs: ChatContextPair[] = [];
    for (const extractor of this.chatContextExtractors) {
      if (!extractor.extractFromPlainText) {
        continue;
      }
      const extracted = extractor.extractFromPlainText(text);
      if (Array.isArray(extracted) && extracted.length > 0) {
        pairs.push(...extracted);
      }
    }
    return this.buildNonSensitiveChatContextItems(pairs, "plain_chat");
  }

  private extractChatContextItemsFromUserInput(
    request: UserInputRequest,
    input: string,
  ): ChatContextItem[] {
    const value = String(input || "").trim();
    if (!value) {
      return [];
    }
    if (this.isSensitiveContextText(`${request.question ?? ""}\n${request.placeholder ?? ""}`)) {
      return [];
    }

    const pairs: ChatContextPair[] = [];
    for (const extractor of this.chatContextExtractors) {
      if (!extractor.extractFromUserInput) {
        continue;
      }
      const extracted = extractor.extractFromUserInput(request, value);
      if (Array.isArray(extracted) && extracted.length > 0) {
        pairs.push(...extracted);
      }
    }
    return this.buildNonSensitiveChatContextItems(pairs, "request_user_input");
  }

  private upsertChatContextItems(chatId: number, items: ChatContextItem[]): ChatContextItem[] {
    if (items.length === 0) {
      return [];
    }
    this.pruneExpiredChatContext(chatId);
    const bucket = this.chatContextStore.get(chatId) ?? new Map<string, ChatContextItem>();
    this.chatContextStore.set(chatId, bucket);
    for (const item of items) {
      bucket.set(item.key, item);
    }
    return items;
  }

  private pruneExpiredChatContext(chatId: number): void {
    const bucket = this.chatContextStore.get(chatId);
    if (!bucket || bucket.size === 0) {
      return;
    }
    const cutoff = Date.now() - TelegramGateway.CHAT_CONTEXT_TTL_MS;
    for (const [key, item] of bucket.entries()) {
      const ts = Date.parse(item.updatedAt);
      if (!Number.isFinite(ts) || ts < cutoff) {
        bucket.delete(key);
      }
    }
    if (bucket.size === 0) {
      this.chatContextStore.delete(chatId);
    }
  }

  private clearChatContext(chatId: number): void {
    this.chatContextStore.delete(chatId);
  }

  private isLikelyTaskInstruction(text: string): boolean {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return false;
    }
    return /^(?:\/run\b|open\b|start\b|launch\b|go\b|use\b|run\b|please\b|打开|开始|启动|请|帮我|去|前往)/i.test(normalized);
  }

  private buildChatContextSavedMessage(locale: "zh" | "en", items: ChatContextItem[]): string {
    const keys = Array.from(new Set(items.map((item) => item.key))).slice(0, 6);
    if (keys.length === 0) {
      return locale === "zh"
        ? "已记录非敏感上下文信息，后续任务可复用。"
        : "Saved non-sensitive context for reuse in upcoming tasks.";
    }
    if (locale === "zh") {
      return `已记录上下文字段：${keys.join("、")}。后续任务可复用这些非敏感信息。`;
    }
    return `Saved context fields: ${keys.join(", ")}. I will reuse these non-sensitive values in upcoming tasks.`;
  }

  private enrichTaskWithChatContext(task: string, chatId: number | null): string {
    if (chatId === null) {
      return task;
    }
    this.pruneExpiredChatContext(chatId);
    const bucket = this.chatContextStore.get(chatId);
    if (!bucket || bucket.size === 0) {
      return task;
    }

    const taskLower = task.toLowerCase();
    const contextLines: string[] = [];
    const items = [...bucket.values()]
      .filter((item) => item.sensitivity === "non_sensitive")
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const item of items) {
      const keyLower = item.key.toLowerCase();
      const valueLower = item.value.toLowerCase();
      if (taskLower.includes(`${keyLower}=`) || taskLower.includes(valueLower)) {
        continue;
      }
      contextLines.push(`- ${item.key}=${item.value}`);
    }
    if (contextLines.length === 0) {
      return task;
    }

    return [
      task,
      "",
      "[Telegram context cache]",
      "Use these non-sensitive user-provided fields when relevant:",
      ...contextLines,
      "- Do not treat these as credentials/OTP/payment data.",
    ].join("\n");
  }

  private normalizeAppToken(app: string): string {
    const normalized = String(app || "").trim().toLowerCase();
    return normalized || "unknown";
  }

  private tokenizeNarrationMessage(text: string): string[] {
    const normalized = String(text || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[0-9]+\/[0-9]+/g, " ")
      .replace(/[0-9]+/g, " ")
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      return [];
    }
    return normalized
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 1);
  }

  private messageSimilarityScore(a: string, b: string): number {
    const aTokens = new Set(this.tokenizeNarrationMessage(a));
    const bTokens = new Set(this.tokenizeNarrationMessage(b));
    if (aTokens.size === 0 || bTokens.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const token of aTokens) {
      if (bTokens.has(token)) {
        intersection += 1;
      }
    }
    const denominator = Math.max(aTokens.size, bTokens.size);
    if (denominator === 0) {
      return 0;
    }
    return intersection / denominator;
  }

  private shouldSuppressLowSignalNarration(
    progress: AgentProgressUpdate,
    state: ProgressNarrationState,
    message: string,
  ): boolean {
    const last = state.lastNotifiedProgress;
    if (!last) {
      return false;
    }

    const stepGap = progress.step - last.step;
    if (stepGap <= 0) {
      return true;
    }

    const action = String(progress.actionType || "").toLowerCase();
    const highSignalAction =
      action === "request_human_auth"
      || action === "run_script"
      || action === "finish"
      || action === "tap"
      || action === "swipe"
      || action === "type_text";
    const errorLike = /(error|failed|timeout|interrupted|rejected|not completed)/i.test(
      `${progress.message} ${progress.thought}`,
    );
    if (highSignalAction || errorLike) {
      return false;
    }

    const sameApp = this.normalizeAppToken(progress.currentApp) === this.normalizeAppToken(last.currentApp);
    if (!sameApp) {
      return false;
    }

    const loadingLike = /(loading|still loading|gett?ing your messages|sync|等待|加载|同步|重试)/i.test(
      `${message} ${progress.message} ${progress.thought}`,
    );
    if ((action === "wait" || action === "launch_app") && stepGap < 8) {
      return true;
    }
    if (loadingLike && stepGap < 12) {
      return true;
    }

    const similarity = this.messageSimilarityScore(message, state.lastNotifiedMessage);
    if (similarity >= 0.78 && stepGap < 12) {
      return true;
    }
    return false;
  }

  private renderTaskAcceptedMessage(task: string, locale: "zh" | "en"): string {
    if (locale === "zh") {
      return `收到，我先处理这个任务：${task}\n有明确进展我会及时告诉你。`;
    }
    return `On it: ${task}\nI'll update you when there's meaningful progress.`;
  }

  private renderTaskQueuedMessage(position: number, locale: "zh" | "en"): string {
    if (locale === "zh") {
      if (position <= 1) {
        return "当前有任务在执行。你的新任务已加入队列，将在下一条执行。";
      }
      return `当前有任务在执行。你的新任务已加入队列（当前排队第 ${position} 位）。`;
    }
    if (position <= 1) {
      return "A previous task is still running. Your new task is queued and will run next.";
    }
    return `A previous task is still running. Your new task is queued (position ${position}).`;
  }

  private clearQueuedTasksForChat(chatId: number): number {
    if (this.pendingChatTasks.length === 0) {
      return 0;
    }
    const before = this.pendingChatTasks.length;
    const remain = this.pendingChatTasks.filter((item) => item.chatId !== chatId);
    this.pendingChatTasks.splice(0, this.pendingChatTasks.length, ...remain);
    return before - remain.length;
  }

  private clearAllQueuedTasks(): number {
    if (this.pendingChatTasks.length === 0) {
      return 0;
    }
    const count = this.pendingChatTasks.length;
    this.pendingChatTasks.splice(0, this.pendingChatTasks.length);
    return count;
  }

  private async drainQueuedChatTasks(): Promise<void> {
    if (this.drainingChatTaskQueue) {
      return;
    }
    if (this.pendingChatTasks.length === 0) {
      return;
    }
    if (this.agent.isBusy()) {
      return;
    }

    this.drainingChatTaskQueue = true;
    try {
      while (this.pendingChatTasks.length > 0) {
        if (this.agent.isBusy()) {
          break;
        }
        const next = this.pendingChatTasks.shift();
        if (!next) {
          break;
        }
        const result = await this.runTaskAndReport({
          chatId: next.chatId,
          task: next.task,
          source: "chat",
          modelName: null,
          sessionKey: next.sessionKey,
        });
        if (next.onDone) {
          try {
            await next.onDone(result);
          } catch (error) {
            this.log(`task completion callback error chat=${next.chatId} error=${(error as Error).message}`);
          }
        }
      }
    } finally {
      this.drainingChatTaskQueue = false;
      if (this.pendingChatTasks.length > 0 && !this.agent.isBusy()) {
        void this.drainQueuedChatTasks();
      }
    }
  }

  private stripStepCounterTelemetry(text: string): string {
    const stripped = String(text || "")
      .replace(/(?:^|\n)\s*(?:step|progress|进度)\s*\d+\s*\/\s*\d+\s*[:：-]?\s*/gim, "\n")
      .replace(/\b(?:step|progress)\s*\d+\s*[:：-]?\s*/gim, "")
      .replace(/\(\s*\d+\s*\/\s*\d+\s*\)/g, "")
      .replace(/(^|\s)\d+\s*\/\s*\d+\s*[:：-]?\s*/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return stripped || text;
  }

  private async syncBotDisplayName(
    chatId: number,
    assistantName: string,
    locale: "zh" | "en",
  ): Promise<void> {
    const nextName = this.normalizeBotDisplayName(assistantName);
    if (!nextName) {
      return;
    }
    if (this.lastSyncedBotDisplayName === nextName) {
      return;
    }
    const retryAfterSec = this.getBotDisplayNameRetryAfterSec();
    if (retryAfterSec > 0) {
      this.log(
        `telegram bot display name update skipped chat=${chatId} name=${JSON.stringify(nextName)} retry_after=${retryAfterSec}s`,
      );
      await this.bot.sendMessage(
        chatId,
        locale === "zh"
          ? `Telegram 限流中，显示名暂时无法修改。请约 ${Math.ceil(retryAfterSec / 60)} 分钟后再试。`
          : `Telegram is rate-limiting display name updates. Please retry in about ${Math.ceil(retryAfterSec / 60)} minute(s).`,
      );
      return;
    }

    try {
      await this.bot.setMyName({ name: nextName });
      this.lastSyncedBotDisplayName = nextName;
      this.botDisplayNameRateLimitedUntilMs = 0;
      this.persistBotDisplayNameSyncState();
      this.log(`telegram bot display name updated chat=${chatId} name=${JSON.stringify(nextName)}`);
      await this.bot.sendMessage(
        chatId,
        locale === "zh"
          ? `已同步 Telegram Bot 显示名：${nextName}`
          : `Telegram bot display name updated: ${nextName}`,
      );
    } catch (error) {
      const retry = this.parseTelegramRetryAfterSec(error);
      if (retry > 0) {
        this.markBotDisplayNameRateLimited(retry);
        this.log(
          `telegram bot display name update rate-limited chat=${chatId} name=${JSON.stringify(nextName)} retry_after=${retry}s`,
        );
        await this.bot.sendMessage(
          chatId,
          locale === "zh"
            ? `Telegram 限流中，显示名暂时无法修改。请约 ${Math.ceil(retry / 60)} 分钟后再试。`
            : `Telegram is rate-limiting display name updates. Please retry in about ${Math.ceil(retry / 60)} minute(s).`,
        );
        return;
      }
      this.log(
        `telegram bot display name update failed chat=${chatId} name=${JSON.stringify(nextName)} error=${(error as Error).message}`,
      );
      await this.bot.sendMessage(
        chatId,
        locale === "zh"
          ? `我已保存名字“${nextName}”，但同步 Telegram Bot 显示名失败：${(error as Error).message}`
          : `I saved name "${nextName}", but failed to sync Telegram bot display name: ${(error as Error).message}`,
      );
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.stopResolver = resolve;
    });

    this.bot.on("message", this.handleMessage);
    this.bot.on("polling_error", this.handlePollingError);
    await this.configureBotCommandMenu();
    await this.syncBotDisplayNameFromIdentity();

    if (this.config.humanAuth.enabled && this.config.humanAuth.useLocalRelay) {
      try {
        const started = await this.localHumanAuthStack.start();
        this.config.humanAuth.relayBaseUrl = started.relayBaseUrl;
        this.config.humanAuth.publicBaseUrl = started.publicBaseUrl;
        this.localHumanAuthActive = true;
        this.log(
          `human-auth local stack ready relay=${started.relayBaseUrl} public=${started.publicBaseUrl}`,
        );
      } catch (error) {
        this.localHumanAuthActive = false;
        this.log(`human-auth local stack failed: ${(error as Error).message}`);
      }
    }

    this.heartbeat.start();
    this.cron.start();
    this.log("telegram polling started");
    this.log("OpenPocket Telegram gateway running...");
  }

  async stop(reason = "manual"): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.agent.stopCurrentTask();
    const droppedQueued = this.clearAllQueuedTasks();
    const cancelledWaits = this.cancelAllPendingUserWaits("Task stopped by gateway shutdown.");
    if (droppedQueued > 0 || cancelledWaits > 0) {
      this.log(`stop cleanup queued_cleared=${droppedQueued} pending_cancelled=${cancelledWaits}`);
    }
    this.bot.removeListener("message", this.handleMessage);
    this.bot.removeListener("polling_error", this.handlePollingError);
    this.heartbeat.stop();
    this.cron.stop();
    this.clearTypingSessions();
    if (this.localHumanAuthActive) {
      await this.localHumanAuthStack.stop();
      this.localHumanAuthActive = false;
    }
    try {
      await this.bot.stopPolling();
    } catch {
      // Ignore stop polling errors on shutdown.
    }
    this.log(`gateway stopped reason=${reason}`);
    this.stopResolver?.();
    this.stopResolver = null;
  }

  async runForever(): Promise<void> {
    await this.start();
    await this.waitForStop();
  }

  async waitForStop(): Promise<void> {
    if (!this.stoppedPromise) {
      return;
    }
    await this.stoppedPromise;
  }

  private readonly handlePollingError = (error: Error): void => {
    this.log(`polling error: ${error.message}`);
  };

  private readonly handleMessage = async (message: Message): Promise<void> => {
    const chatId = message.chat.id;
    const incomingAtHr = process.hrtime.bigint();
    try {
      this.log(`incoming chat=${chatId} text=${JSON.stringify(message.text ?? "")}`);
      const text = message.text?.trim() ?? "";
      const shouldType = Boolean(text) && this.allowed(chatId);
      if (shouldType) {
        await this.withTypingStatus(chatId, async () => {
          await this.consumeMessage(message, incomingAtHr);
        });
      } else {
        await this.consumeMessage(message, incomingAtHr);
      }
    } catch (error) {
      this.log(`handler error chat=${chatId} error=${(error as Error).message}`);
      await this.bot.sendMessage(chatId, `OpenPocket error: ${(error as Error).message}`);
    }
  };

  private clearTypingSessions(): void {
    for (const session of this.typingSessions.values()) {
      clearInterval(session.timer);
    }
    this.typingSessions.clear();
  }

  private async sendTypingAction(chatId: number): Promise<void> {
    try {
      await this.bot.sendChatAction(chatId, "typing");
    } catch {
      // Ignore chat action failures to keep task execution stable.
    }
  }

  private beginTypingStatus(chatId: number): () => void {
    const existing = this.typingSessions.get(chatId);
    if (existing) {
      existing.refs += 1;
    } else {
      const timer = setInterval(() => {
        void this.sendTypingAction(chatId);
      }, this.typingIntervalMs);
      timer.unref?.();
      this.typingSessions.set(chatId, { refs: 1, timer });
      void this.sendTypingAction(chatId);
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const session = this.typingSessions.get(chatId);
      if (!session) {
        return;
      }
      session.refs -= 1;
      if (session.refs <= 0) {
        clearInterval(session.timer);
        this.typingSessions.delete(chatId);
      }
    };
  }

  private async withTypingStatus<T>(
    chatId: number | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (chatId === null) {
      return operation();
    }
    const release = this.beginTypingStatus(chatId);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async configureBotCommandMenu(): Promise<void> {
    try {
      await this.bot.setMyCommands(TELEGRAM_MENU_COMMANDS);
      await this.bot.setChatMenuButton({
        menu_button: {
          type: "commands",
        },
      });
      this.log(`telegram command menu configured commands=${TELEGRAM_MENU_COMMANDS.length}`);
    } catch (error) {
      this.log(`telegram command menu setup failed: ${(error as Error).message}`);
    }
  }

  private allowed(chatId: number): boolean {
    const allow = this.config.telegram.allowedChatIds;
    if (!allow || allow.length === 0) {
      return true;
    }
    return allow.includes(chatId);
  }

  private resolveChatSessionKey(chatId: number): string {
    return `telegram:chat:${chatId}`;
  }

  private isCodeBasedHumanAuthCapability(capability: string): boolean {
    return capability === "sms" || capability === "2fa";
  }

  private isStopIntentText(text: string): boolean {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return false;
    }
    if (/^\/stop(?:@\w+)?$/i.test(normalized)) {
      return true;
    }
    if (normalized.startsWith("/")) {
      return false;
    }
    if (/\b(stop|cancel|abort|terminate|halt)\b/i.test(normalized)) {
      return true;
    }
    if (/(停止|终止|取消(?:当前)?任务|停一下|停下|结束当前任务)/.test(normalized)) {
      return true;
    }
    return false;
  }

  private hasPendingHumanAuthForChat(chatId: number): boolean {
    return this.humanAuth.listPending().some((item) => item.chatId === chatId);
  }

  private hasStopTargetForChat(chatId: number): boolean {
    return this.agent.isBusy()
      || this.pendingUserDecisions.has(chatId)
      || this.pendingUserInputs.has(chatId)
      || this.pendingChatTasks.some((item) => item.chatId === chatId)
      || this.hasPendingHumanAuthForChat(chatId);
  }

  private cancelPendingUserDecisionWait(chatId: number, reason: string): boolean {
    const pending = this.pendingUserDecisions.get(chatId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeout);
    this.pendingUserDecisions.delete(chatId);
    try {
      pending.reject(new Error(reason));
    } catch {
      // Ignore rejection handler failures during forced stop.
    }
    return true;
  }

  private cancelPendingUserInputWait(chatId: number, reason: string): boolean {
    const pending = this.pendingUserInputs.get(chatId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeout);
    this.pendingUserInputs.delete(chatId);
    try {
      pending.reject(new Error(reason));
    } catch {
      // Ignore rejection handler failures during forced stop.
    }
    return true;
  }

  private requestStopForChat(
    chatId: number,
    options?: {
      reason?: string;
      clearQueue?: boolean;
    },
  ): { accepted: boolean; cancelledWaits: number; droppedQueued: number } {
    const reason = options?.reason ?? "Task stopped by user.";
    const accepted = this.agent.stopCurrentTask();
    const droppedQueued = options?.clearQueue ? this.clearQueuedTasksForChat(chatId) : 0;
    const cancelledDecision = this.cancelPendingUserDecisionWait(chatId, reason) ? 1 : 0;
    const cancelledInput = this.cancelPendingUserInputWait(chatId, reason) ? 1 : 0;
    const cancelledHumanAuth = this.humanAuth.cancelPendingForChat(chatId, reason);
    return {
      accepted,
      cancelledWaits: cancelledDecision + cancelledInput + cancelledHumanAuth,
      droppedQueued,
    };
  }

  private cancelAllPendingUserWaits(reason: string): number {
    let cancelled = 0;
    for (const chatId of [...this.pendingUserDecisions.keys()]) {
      if (this.cancelPendingUserDecisionWait(chatId, reason)) {
        cancelled += 1;
      }
    }
    for (const chatId of [...this.pendingUserInputs.keys()]) {
      if (this.cancelPendingUserInputWait(chatId, reason)) {
        cancelled += 1;
      }
    }
    cancelled += this.humanAuth.cancelAllPending(reason);
    return cancelled;
  }

  private normalizeOtpCode(text: string): string | null {
    const compact = text.replace(/\s+/g, "");
    if (/^\d{4,10}$/.test(compact)) {
      return compact;
    }
    return null;
  }

  private async tryResolvePendingOtpFromPlainText(chatId: number, text: string): Promise<boolean> {
    const code = this.normalizeOtpCode(text);
    if (!code) {
      return false;
    }
    const pending = this.humanAuth
      .listPending()
      .filter((item) => item.chatId === chatId && this.isCodeBasedHumanAuthCapability(item.capability));
    if (pending.length !== 1) {
      return false;
    }

    const requestId = pending[0].requestId;
    const resolved = this.humanAuth.resolvePending(
      requestId,
      true,
      code,
      `chat:${chatId}:otp-inline`,
    );
    if (!resolved) {
      return false;
    }

    await this.bot.sendMessage(
      chatId,
      `Received code for ${requestId}: ${code}\nContinuing task execution now.`,
    );
    return true;
  }

  private async tryResolvePendingUserDecision(chatId: number, text: string): Promise<boolean> {
    const pending = this.pendingUserDecisions.get(chatId);
    if (!pending) {
      return false;
    }
    const normalized = String(text || "").trim();
    if (!normalized) {
      return false;
    }
    const options = pending.request.options || [];
    let selected = normalized;
    const numeric = normalized.match(/^\d+$/);
    if (numeric) {
      const idx = Number(numeric[0]) - 1;
      if (idx >= 0 && idx < options.length) {
        selected = options[idx];
      }
    } else {
      const exact = options.find((opt) => opt.toLowerCase() === normalized.toLowerCase());
      if (exact) {
        selected = exact;
      }
    }

    clearTimeout(pending.timeout);
    this.pendingUserDecisions.delete(chatId);
    pending.resolve({
      selectedOption: selected,
      rawInput: normalized,
      resolvedAt: new Date().toISOString(),
    });
    // Echo the selected option if it matches a listed choice; redact custom free-text input.
    const matchedOption = options.find(
      (opt) => opt.trim().toLowerCase() === selected.trim().toLowerCase(),
    );
    const confirmMessage = matchedOption
      ? `Got it: "${matchedOption}". Continuing.`
      : "Got it. Continuing.";
    await this.bot.sendMessage(chatId, confirmMessage);
    return true;
  }

  private async tryResolvePendingUserInput(chatId: number, text: string): Promise<boolean> {
    const pending = this.pendingUserInputs.get(chatId);
    if (!pending) {
      return false;
    }
    const normalized = String(text || "").trim();
    if (!normalized) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pendingUserInputs.delete(chatId);
    const contextItems = this.extractChatContextItemsFromUserInput(pending.request, normalized);
    this.upsertChatContextItems(chatId, contextItems);
    pending.resolve({
      text: normalized,
      resolvedAt: new Date().toISOString(),
    });
    await this.bot.sendMessage(chatId, "Got it. Continuing.");
    return true;
  }

  private requestUserDecisionFromChat(
    chatId: number,
    request: UserDecisionRequest,
  ): Promise<UserDecisionResponse> {
    const screenshotPromise = this.agent.captureManualScreenshot().catch(() => "");
    return new Promise<UserDecisionResponse>(async (resolve, reject) => {
      if (this.pendingUserDecisions.has(chatId)) {
        const existing = this.pendingUserDecisions.get(chatId)!;
        clearTimeout(existing.timeout);
        this.pendingUserDecisions.delete(chatId);
        existing.reject(new Error("Superseded by a newer user-decision request."));
      }

      const timeout = setTimeout(() => {
        this.pendingUserDecisions.delete(chatId);
        reject(new Error("User decision timed out."));
      }, Math.max(15_000, request.timeoutSec * 1000));

      this.pendingUserDecisions.set(chatId, {
        request,
        resolve,
        reject,
        timeout,
      });

      const decisionLocale = this.inferTaskLocale(
        `${request.question}\n${Array.isArray(request.options) ? request.options.join(" ") : ""}`,
      );
      const escalationIntro = this.sanitizeForChat(
        await this.chat.narrateEscalation({
          event: "user_decision",
          locale: decisionLocale,
          task: request.task,
          question: request.question,
          options: request.options,
          hasWebLink: false,
          includeLocalSecurityAssurance: false,
        }),
        1000,
      );
      const optionsTitle = decisionLocale === "zh" ? "选项：" : "Options:";
      const replyHint = decisionLocale === "zh" ? "请回复选项编号或文本。" : "Reply with option number or text.";
      const options = request.options.length > 0
        ? request.options.map((item, index) => `${index + 1}. ${item}`).join("\n")
        : (decisionLocale === "zh" ? "（没有可用选项）" : "(no options provided)");
      const prompt = [
        escalationIntro,
        "",
        optionsTitle,
        options,
        "",
        replyHint,
      ].join("\n");
      const screenshotPath = await screenshotPromise;
      if (screenshotPath) {
        try {
          await this.bot.sendPhoto(chatId, screenshotPath, {
            caption: this.sanitizeForChat(prompt, 950),
          });
          return;
        } catch {
          // Fall back to text-only prompt below.
        }
      }
      await this.bot.sendMessage(chatId, this.sanitizeForChat(prompt, 1800));
    });
  }

  private requestUserInputFromChat(
    chatId: number,
    request: UserInputRequest,
  ): Promise<UserInputResponse> {
    const screenshotPromise = this.agent.captureManualScreenshot().catch(() => "");
    return new Promise<UserInputResponse>(async (resolve, reject) => {
      if (this.pendingUserInputs.has(chatId)) {
        const existing = this.pendingUserInputs.get(chatId)!;
        clearTimeout(existing.timeout);
        this.pendingUserInputs.delete(chatId);
        existing.reject(new Error("Superseded by a newer user-input request."));
      }

      const timeout = setTimeout(() => {
        this.pendingUserInputs.delete(chatId);
        reject(new Error("User input timed out."));
      }, Math.max(15_000, request.timeoutSec * 1000));

      this.pendingUserInputs.set(chatId, {
        request,
        resolve,
        reject,
        timeout,
      });

      const locale = this.inferTaskLocale(`${request.question}\n${request.placeholder ?? ""}`);
      const escalationIntro = this.sanitizeForChat(
        await this.chat.narrateEscalation({
          event: "user_decision",
          locale,
          task: request.task,
          question: request.question,
          options: [],
          hasWebLink: false,
          includeLocalSecurityAssurance: false,
        }),
        1000,
      );
      const questionTitle = locale === "zh" ? "需要的信息：" : "Requested value:";
      const placeholderLine = request.placeholder
        ? (locale === "zh"
          ? `格式提示：${request.placeholder}`
          : `Format hint: ${request.placeholder}`)
        : "";
      const replyHint = locale === "zh" ? "请直接回复文本内容。" : "Reply with the text value.";
      const prompt = [
        escalationIntro,
        "",
        questionTitle,
        request.question,
        placeholderLine,
        "",
        replyHint,
      ].filter(Boolean).join("\n");
      const screenshotPath = await screenshotPromise;
      if (screenshotPath) {
        try {
          await this.bot.sendPhoto(chatId, screenshotPath, {
            caption: this.sanitizeForChat(prompt, 950),
          });
          return;
        } catch {
          // Fall back to text-only prompt below.
        }
      }
      await this.bot.sendMessage(chatId, this.sanitizeForChat(prompt, 1800));
    });
  }

  private async consumeMessage(message: Message, incomingAtHr?: bigint): Promise<void> {
    const chatId = message.chat.id;
    if (!this.allowed(chatId)) {
      return;
    }

    const text = message.text?.trim();
    if (!text) {
      return;
    }

    if (this.isStopIntentText(text) && this.hasStopTargetForChat(chatId)) {
      const stop = this.requestStopForChat(chatId, {
        reason: "Task stopped by user.",
        clearQueue: true,
      });
      if (stop.droppedQueued > 0) {
        this.log(`cleared queued tasks chat=${chatId} count=${stop.droppedQueued} reason=stop-intent`);
      }
      await this.bot.sendMessage(chatId, "Stop requested.");
      return;
    }

    if (!text.startsWith("/") && await this.tryResolvePendingUserInput(chatId, text)) {
      return;
    }

    if (!text.startsWith("/") && await this.tryResolvePendingUserDecision(chatId, text)) {
      return;
    }

    if (/^\/start(?:\s.*)?$/i.test(text) && !text.startsWith("/startvm")) {
      const locale = this.inferLocale(message);
      if (await this.trySendOnboardingReply(chatId, locale)) {
        return;
      }
      if (await this.ensurePlayStoreReady(chatId, locale)) {
        return;
      }

      const welcome = await this.chat.startReadyReply(locale);
      await this.bot.sendMessage(chatId, this.sanitizeForChat(welcome, 1800));
      return;
    }

    if (text.startsWith("/help")) {
      await this.bot.sendMessage(
        chatId,
        [
          "OpenPocket commands:",
          "/start",
          "/context [list|detail|json]",
          "/context detail <fileName>",
          "/status",
          "/model [name]",
          "/startvm",
          "/stopvm",
          "/hidevm",
          "/showvm",
          "/screen",
          "/skills",
          "/clear",
          "/new [task]",
          "/reset",
          "/stop",
          "/restart",
          "/cronrun <job-id>",
          "/auth",
          "/auth pending",
          "/auth approve <request-id> [note]",
          "/auth reject <request-id> [note]",
          "/run <task>",
          "Send plain text directly. I will auto-route to chat or task mode. Use /run to force task mode.",
        ].join("\n"),
      );
      return;
    }

    if (text.startsWith("/context")) {
      const contextArg = text.replace("/context", "").trim();
      if (!contextArg || /^list$/i.test(contextArg) || /^show$/i.test(contextArg)) {
        await this.bot.sendMessage(chatId, this.sanitizeForChat(this.buildContextSummaryMessage(), 3500));
        return;
      }
      if (/^json$/i.test(contextArg)) {
        const report = this.agent.getWorkspacePromptContextReport();
        await this.bot.sendMessage(chatId, this.sanitizeForChat(JSON.stringify(report, null, 2), 3800));
        return;
      }
      if (/^detail$/i.test(contextArg) || /^deep$/i.test(contextArg)) {
        await this.bot.sendMessage(chatId, this.sanitizeForChat(this.buildContextDeepDetailMessage(), 3800));
        return;
      }
      if (/^detail\s+.+/i.test(contextArg)) {
        const target = contextArg.replace(/^detail\s*/i, "");
        await this.bot.sendMessage(chatId, this.sanitizeForChat(this.buildContextFileDetailMessage(target), 3500));
        return;
      }
      await this.bot.sendMessage(
        chatId,
        "Usage: /context [list|detail|json] or /context detail <fileName>",
      );
      return;
    }

    if (text.startsWith("/status")) {
      const status = this.emulator.status();
      await this.bot.sendMessage(
        chatId,
        [
          `Project: ${this.config.projectName}`,
          `Model: ${this.config.defaultModel}`,
          `Target: ${this.config.target.type} (${deviceTargetLabel(this.config.target.type)})`,
          `Agent busy: ${this.agent.isBusy()}`,
          `Current task: ${this.agent.getCurrentTask() ?? "(none)"}`,
          `AVD: ${status.avdName}`,
          `Devices: ${status.devices.length > 0 ? status.devices.join(", ") : "(none)"}`,
          `Booted: ${status.bootedDevices.length > 0 ? status.bootedDevices.join(", ") : "(none)"}`,
          `Human auth: ${this.config.humanAuth.enabled ? "enabled" : "disabled"}`,
          `Human auth relay: ${this.config.humanAuth.relayBaseUrl || "(not configured)"}`,
          `Human auth public: ${this.config.humanAuth.publicBaseUrl || "(not configured)"}`,
        ].join("\n"),
      );
      return;
    }

    if (text.startsWith("/model")) {
      const requested = text.replace("/model", "").trim();
      if (!requested) {
        await this.bot.sendMessage(
          chatId,
          `Current model: ${this.config.defaultModel}\nAvailable: ${Object.keys(this.config.models).join(", ")}`,
        );
        return;
      }

      if (!this.config.models[requested]) {
        await this.bot.sendMessage(chatId, `Unknown model: ${requested}`);
        return;
      }

      this.config.defaultModel = requested;
      saveConfig(this.config);
      this.chat = new ChatAssistant(this.config);
      await this.bot.sendMessage(chatId, `Default model updated: ${requested}`);
      return;
    }

    if (text.startsWith("/startvm")) {
      const messageText = await this.emulator.start();
      await this.bot.sendMessage(chatId, messageText);
      return;
    }

    if (text.startsWith("/stopvm")) {
      await this.bot.sendMessage(chatId, this.emulator.stop());
      return;
    }

    if (text.startsWith("/hidevm")) {
      await this.bot.sendMessage(chatId, await this.emulator.ensureHiddenBackground());
      return;
    }

    if (text.startsWith("/showvm")) {
      await this.bot.sendMessage(chatId, await this.emulator.ensureWindowVisible());
      return;
    }

    if (text.startsWith("/screen")) {
      this.chat.appendExternalTurn(chatId, "user", text);
      const screenshotPath = await this.agent.captureManualScreenshot();
      this.log(`manual screenshot chat=${chatId} path=${screenshotPath}`);
      try {
        await this.bot.sendPhoto(chatId, screenshotPath, {
          caption: "Current device screenshot.",
        });
        this.chat.appendExternalTurn(chatId, "assistant", "[shared current emulator screenshot]");
      } catch (error) {
        const detail = (error as Error).message || "unknown upload error";
        this.log(`manual screenshot upload failed chat=${chatId} path=${screenshotPath} error=${detail}`);
        const fallback = `Screenshot saved locally but upload failed: ${detail}\nPath: ${screenshotPath}`;
        await this.bot.sendMessage(
          chatId,
          fallback,
        );
        this.chat.appendExternalTurn(chatId, "assistant", fallback);
      }
      return;
    }

    if (text.startsWith("/skills")) {
      const skills = this.agent.listSkills();
      if (skills.length === 0) {
        await this.bot.sendMessage(chatId, "No skills loaded.");
        return;
      }
      const body = skills
        .slice(0, 25)
        .map((skill) => `- [${skill.source}] ${skill.name}: ${skill.description}`)
        .join("\n");
      await this.bot.sendMessage(chatId, `Loaded skills (${skills.length}):\n${body}`);
      return;
    }

    if (text === "/clear") {
      this.chat.clear(chatId);
      this.clearChatContext(chatId);
      await this.bot.sendMessage(chatId, "Conversation memory cleared.");
      return;
    }

    const newSessionMatch = text.match(/^\/new(?:\s+(.+))?$/i);
    if (newSessionMatch) {
      this.chat.clear(chatId);
      this.clearChatContext(chatId);
      const droppedQueued = this.clearQueuedTasksForChat(chatId);
      if (droppedQueued > 0) {
        this.log(`cleared queued tasks chat=${chatId} count=${droppedQueued} reason=/new`);
      }
      const sessionKey = this.resolveChatSessionKey(chatId);

      const reset = this.agent.resetSession(sessionKey);
      if (!reset) {
        await this.bot.sendMessage(chatId, "Failed to start a new session.");
        return;
      }

      const summary = `New session started (${sessionKey} -> ${reset.sessionId}).`;
      await this.bot.sendMessage(chatId, summary);

      const followupTask = (newSessionMatch[1] ?? "").trim();
      if (followupTask) {
        this.chat.appendExternalTurn(chatId, "user", followupTask);
        await this.runTaskAsync(chatId, followupTask);
        return;
      }

      const locale = this.inferLocale(message);
      if (await this.trySendOnboardingReply(chatId, locale)) {
        return;
      }
      await this.bot.sendMessage(chatId, this.sanitizeForChat(await this.chat.sessionResetUserReply(locale), 1800));
      return;
    }

    if (text === "/reset") {
      this.chat.clear(chatId);
      this.clearChatContext(chatId);
      this.playStorePreflightPassed = false;
      this.playStorePreflightTriggered = false;
      this.playStorePreflightDeferredNotified = false;
      const droppedQueued = this.clearQueuedTasksForChat(chatId);
      if (droppedQueued > 0) {
        this.log(`cleared queued tasks chat=${chatId} count=${droppedQueued} reason=/reset`);
      }
      const stop = this.requestStopForChat(chatId, {
        reason: "Task stopped by user.",
      });
      if (stop.cancelledWaits > 0) {
        this.log(`cleared pending waits chat=${chatId} count=${stop.cancelledWaits} reason=/reset`);
      }
      const locale = this.inferLocale(message);
      const resetSummary = (stop.accepted || stop.cancelledWaits > 0)
        ? "Conversation memory cleared. Stop requested for the running task."
        : "Conversation memory cleared. No running task to stop.";
      await this.bot.sendMessage(chatId, resetSummary);

      if (await this.trySendOnboardingReply(chatId, locale)) {
        return;
      }

      await this.bot.sendMessage(chatId, this.sanitizeForChat(await this.chat.sessionResetUserReply(locale), 1800));
      return;
    }

    if (/^\/stop(?:@\w+)?$/i.test(text)) {
      const stop = this.requestStopForChat(chatId, {
        reason: "Task stopped by user.",
        clearQueue: true,
      });
      if (stop.droppedQueued > 0) {
        this.log(`cleared queued tasks chat=${chatId} count=${stop.droppedQueued} reason=/stop`);
      }
      const stoppedAnything = stop.accepted || stop.cancelledWaits > 0 || stop.droppedQueued > 0;
      await this.bot.sendMessage(chatId, stoppedAnything ? "Stop requested." : "No running task.");
      return;
    }

    if (text === "/restart") {
      if (process.listenerCount("SIGUSR1") === 0) {
        await this.bot.sendMessage(
          chatId,
          "Restart is unavailable in the current runtime mode (no gateway run-loop signal handler).",
        );
        return;
      }
      await this.bot.sendMessage(chatId, "Gateway restart requested. Reconnecting...");
      setTimeout(() => {
        try {
          process.kill(process.pid, "SIGUSR1");
        } catch (error) {
          this.log(`gateway restart signal failed: ${(error as Error).message}`);
        }
      }, 50);
      return;
    }

    if (text.startsWith("/cronrun")) {
      const jobId = text.replace("/cronrun", "").trim();
      if (!jobId) {
        await this.bot.sendMessage(chatId, "Usage: /cronrun <job-id>");
        return;
      }
      const found = await this.cron.runNow(jobId);
      await this.bot.sendMessage(chatId, found ? `Cron job triggered: ${jobId}` : `Cron job not found: ${jobId}`);
      return;
    }

    if (text.startsWith("/run")) {
      const task = text.replace("/run", "").trim();
      if (!task) {
        await this.bot.sendMessage(chatId, "Usage: /run <task>");
        return;
      }
      const runLocale = this.inferLocale(message);
      if (await this.ensurePlayStoreReady(chatId, runLocale)) {
        return;
      }
      this.chat.appendExternalTurn(chatId, "user", task);
      await this.runTaskAsync(chatId, task);
      return;
    }

    if (text.startsWith("/auth")) {
      await this.handleAuthCommand(chatId, text);
      return;
    }

    if (await this.tryResolvePendingOtpFromPlainText(chatId, text)) {
      return;
    }

    const onboardingPendingNow = this.chat.isOnboardingPending();
    if (!text.startsWith("/") && !onboardingPendingNow) {
      const contextItems = this.extractChatContextItemsFromPlainText(text);
      const savedItems = this.upsertChatContextItems(chatId, contextItems);
      if (savedItems.length > 0) {
        if (!this.isLikelyTaskInstruction(text)) {
          const locale = this.inferLocale(message);
          await this.bot.sendMessage(
            chatId,
            this.sanitizeForChat(this.buildChatContextSavedMessage(locale, savedItems), 1800),
          );
          return;
        }
      }
    }

    const onboardingPendingBefore = this.chat.isOnboardingPending();
    let preflightCheckedThisMessage = false;
    if (!text.startsWith("/") && !onboardingPendingBefore && !this.playStorePreflightPassed) {
      const locale = this.inferLocale(message);
      preflightCheckedThisMessage = true;
      if (await this.ensurePlayStoreReady(chatId, locale)) {
        return;
      }
    }

    const decisionStartedAtHr = process.hrtime.bigint();
    const decision = await this.chat.decide(chatId, text);
    const decisionEndedAtHr = process.hrtime.bigint();
    const decisionLatencyMs = this.durationMsBetween(decisionStartedAtHr, decisionEndedAtHr);
    const incomingToDecisionMs = incomingAtHr
      ? this.durationMsBetween(incomingAtHr, decisionEndedAtHr)
      : null;
    const onboardingCompletedThisTurn = onboardingPendingBefore && !this.chat.isOnboardingPending();
    this.log(
      `decision chat=${chatId} mode=${decision.mode} confidence=${decision.confidence.toFixed(2)} decision_ms=${decisionLatencyMs}` +
      `${incomingToDecisionMs === null ? "" : ` incoming_to_decision_ms=${incomingToDecisionMs}`}` +
      ` reason=${decision.reason}`,
    );
    if (decision.mode === "task") {
      const task = decision.task || text;
      this.chat.appendExternalTurn(chatId, "user", task);
      const locale = this.inferLocale(message);
      if (onboardingCompletedThisTurn || (!this.playStorePreflightPassed && !preflightCheckedThisMessage)) {
        if (await this.ensurePlayStoreReady(chatId, locale)) {
          return;
        }
      }
      await this.runTaskAsync(chatId, task);
      return;
    }

    const reply = decision.reply || (await this.chat.reply(chatId, text));
    await this.bot.sendMessage(chatId, this.sanitizeForChat(reply, 1800));
    const profileUpdate = this.chat.consumePendingProfileUpdate(chatId);
    if (profileUpdate) {
      await this.syncBotDisplayName(chatId, profileUpdate.assistantName, profileUpdate.locale);
    }
    if (onboardingCompletedThisTurn) {
      const locale = this.inferLocale(message);
      await this.ensurePlayStoreReady(chatId, locale);
    }
  }

  private async runTaskAsync(
    chatId: number,
    task: string,
    options?: {
      sessionKey?: string;
      onDone?: (result: CronRunResult) => void | Promise<void>;
      skipAcceptedMessage?: boolean;
    },
  ): Promise<boolean> {
    const locale = this.inferTaskLocale(task);
    const isIdle = !this.drainingChatTaskQueue && !this.agent.isBusy() && this.pendingChatTasks.length === 0;
    const queuePosition = this.pendingChatTasks.length + 1;
    if (!options?.skipAcceptedMessage) {
      const ackMessage = isIdle
        ? this.renderTaskAcceptedMessage(task, locale)
        : this.renderTaskQueuedMessage(queuePosition, locale);
      await this.bot.sendMessage(chatId, ackMessage);
      this.chat.appendExternalTurn(chatId, "assistant", ackMessage);
      if (!isIdle) {
        this.log(`task queued busy chat=${chatId} position=${queuePosition} task=${JSON.stringify(task)}`);
      }
    }

    this.pendingChatTasks.push({
      chatId,
      task,
      sessionKey: options?.sessionKey ?? this.resolveChatSessionKey(chatId),
      onDone: options?.onDone,
    });
    void this.drainQueuedChatTasks();
    return true;
  }

  private async runScheduledJob(job: CronJob): Promise<CronRunResult> {
    if (this.agent.isBusy()) {
      return {
        accepted: false,
        ok: false,
        message: "Agent is busy.",
      };
    }

    if (job.chatId !== null) {
      await this.bot.sendMessage(job.chatId, `Scheduled task started (${job.name}): ${job.task}`);
    }

    return this.runTaskAndReport({
      chatId: job.chatId,
      task: job.task,
      source: "cron",
      modelName: job.model,
      sessionKey: job.chatId !== null ? this.resolveChatSessionKey(job.chatId) : `telegram:cron:${job.id}`,
    });
  }

  private async runTaskAndReport(params: {
    chatId: number | null;
    task: string;
    source: "chat" | "cron";
    modelName: string | null;
    sessionKey: string;
  }): Promise<CronRunResult> {
    const { chatId, task, source, modelName, sessionKey } = params;
    const taskAcceptedAtHr = process.hrtime.bigint();
    const agentTask = this.enrichTaskWithChatContext(task, chatId);
    const progressLocale = this.inferTaskLocale(task);
    const progressNarrationState: ProgressNarrationState = {
      lastNotifiedProgress: null,
      lastNotifiedMessage: "",
      skippedSteps: 0,
      recentProgress: [],
      allProgress: [],
    };
    let progressWork: Promise<void> = Promise.resolve();
    this.log(
      `task accepted source=${source} chat=${chatId ?? "(none)"} task=${JSON.stringify(task)} model=${modelName ?? this.config.defaultModel}`,
    );

    // Sparse narration: only call the LLM every N steps to save cost/latency.
    // High-signal actions (first step, errors, human auth, finish) always go through.
    const NARRATION_LLM_INTERVAL = 8;

    try {
      return await this.withTypingStatus(source === "chat" ? chatId : null, async () => {
        const enqueueProgressNarration = (progress: AgentProgressUpdate): void => {
          progressWork = progressWork
            .then(async () => {
              if (chatId === null) {
                return;
              }
              this.log(
                `progress source=${source} chat=${chatId} step=${progress.step}/${progress.maxSteps} action=${progress.actionType} app=${progress.currentApp}`,
              );
              const recentProgress = [...progressNarrationState.recentProgress, progress].slice(-8);
              progressNarrationState.allProgress = [...progressNarrationState.allProgress, progress].slice(-16);

              // Determine if this step qualifies for LLM narration or should use
              // the cheaper rule-based fallback instead.
              const action = String(progress.actionType || "").toLowerCase();
              const isHighSignal =
                progress.step === 1
                || action === "finish"
                || action === "request_human_auth"
                || action === "request_user_input"
                || /(error|failed|timeout|interrupted|rejected)/i.test(
                  `${progress.message} ${progress.thought}`,
                );
              const isIntervalStep = progressNarrationState.skippedSteps >= NARRATION_LLM_INTERVAL;
              const useLlm = isHighSignal || isIntervalStep;

              const decision = useLlm
                ? await this.chat.narrateTaskProgress({
                  task,
                  locale: progressLocale,
                  progress,
                  recentProgress,
                  lastNotifiedProgress: progressNarrationState.lastNotifiedProgress,
                  skippedSteps: progressNarrationState.skippedSteps,
                })
                : this.chat.fallbackTaskProgressNarration({
                  task,
                  locale: progressLocale,
                  progress,
                  recentProgress,
                  lastNotifiedProgress: progressNarrationState.lastNotifiedProgress,
                  skippedSteps: progressNarrationState.skippedSteps,
                });

              if (!decision.notify) {
                progressNarrationState.skippedSteps += 1;
                progressNarrationState.recentProgress = recentProgress;
                return;
              }
              const message = this.sanitizeForChat(
                this.stripStepCounterTelemetry(decision.message),
                1800,
              );
              if (!message.trim()) {
                progressNarrationState.skippedSteps += 1;
                progressNarrationState.recentProgress = recentProgress;
                return;
              }
              if (this.shouldSuppressLowSignalNarration(progress, progressNarrationState, message)) {
                progressNarrationState.skippedSteps += 1;
                progressNarrationState.recentProgress = recentProgress;
                return;
              }
              progressNarrationState.lastNotifiedProgress = progress;
              progressNarrationState.lastNotifiedMessage = message;
              progressNarrationState.skippedSteps = 0;
              progressNarrationState.recentProgress = [];
              await this.bot.sendMessage(chatId, message);
            })
            .catch((error) => {
              this.log(
                `progress narration error source=${source} chat=${chatId ?? "(none)"} error=${(error as Error).message}`,
              );
            });
        };

        try {
          const result = await this.agent.runTask(
            agentTask,
            modelName ?? undefined,
            chatId === null
              ? undefined
              : async (progress) => {
                enqueueProgressNarration(progress);
              },
            chatId === null
              ? undefined
              : async (request) => {
                const timeoutSec = Math.max(30, Math.round(request.timeoutSec));
                return this.humanAuth.requestAndWait(
                  { chatId, task, request: { ...request, timeoutSec } },
                  async (opened) => {
                    const isCodeFlow = this.isCodeBasedHumanAuthCapability(request.capability);
                    const resolvedCurrentApp = this.resolveHumanAuthCurrentApp(request.currentApp);
                    const escalationMessage = this.sanitizeForChat(
                      await this.chat.narrateEscalation({
                        event: "human_auth",
                        locale: progressLocale,
                        task,
                        capability: request.capability,
                        currentApp: resolvedCurrentApp,
                        instruction: request.instruction,
                        reason: request.reason,
                        hasWebLink: Boolean(opened.openUrl),
                        isCodeFlow,
                        includeLocalSecurityAssurance: false,
                      }),
                      1500,
                    );

                    if (isCodeFlow) {
                      const codeLines = progressLocale === "zh"
                        ? [
                          "你也可以直接在 Telegram 回复验证码（4-10位数字，例如 123456）。",
                          `多个验证码请求时可发送：${opened.manualApproveCommand} 123456`,
                          `拒绝可发送：${opened.manualRejectCommand}`,
                        ]
                        : [
                          "You can also reply directly in Telegram with the 4-10 digit code (for example: 123456).",
                          `If multiple code requests are pending, use: ${opened.manualApproveCommand} 123456`,
                          `Reject with: ${opened.manualRejectCommand}`,
                        ];
                      const codeBody = this.buildHumanAuthHtmlMessage(escalationMessage, progressLocale, codeLines);
                      await this.bot.sendMessage(
                        chatId,
                        codeBody,
                        {
                          parse_mode: "HTML",
                          reply_markup: opened.openUrl
                            ? {
                              inline_keyboard: [
                                [
                                  {
                                    text: "Open Human Auth",
                                    url: opened.openUrl,
                                  },
                                ],
                              ],
                            }
                            : undefined,
                        },
                      );
                      return;
                    }

                    if (opened.openUrl) {
                      await this.bot.sendMessage(chatId, this.buildHumanAuthHtmlMessage(escalationMessage, progressLocale), {
                        parse_mode: "HTML",
                        reply_markup: {
                          inline_keyboard: [
                            [
                              {
                                text: "Open Human Auth",
                                url: opened.openUrl,
                              },
                            ],
                          ],
                        },
                      });
                      return;
                    }

                    const noLinkHint = progressLocale === "zh"
                      ? "当前授权链接不可用，请直接用命令处理："
                      : "Web link is unavailable. Use manual commands:";
                    await this.bot.sendMessage(
                      chatId,
                      this.buildHumanAuthHtmlMessage(escalationMessage, progressLocale, [
                        noLinkHint,
                        opened.manualApproveCommand,
                        opened.manualRejectCommand,
                      ]),
                      {
                        parse_mode: "HTML",
                      },
                    );
                  },
                );
              },
            source === "cron" ? "minimal" : undefined,
            chatId === null
              ? undefined
              : async (request) => this.requestUserDecisionFromChat(chatId, request),
            sessionKey,
            chatId === null
              ? undefined
              : async (request) => this.requestUserInputFromChat(chatId, request),
          );
          await progressWork;

          this.log(
            `task done source=${source} chat=${chatId ?? "(none)"} ok=${result.ok}` +
            ` duration_ms=${this.durationMsSince(taskAcceptedAtHr)} session=${result.sessionPath}`,
          );

          if (chatId !== null) {
            const finalMessage = await this.chat.narrateTaskOutcome({
              task,
              locale: progressLocale,
              ok: result.ok,
              rawResult: result.message,
              recentProgress: progressNarrationState.allProgress,
              skillPath: result.skillPath ?? null,
              scriptPath: result.scriptPath ?? null,
            });
            const finalForChat = this.sanitizeForChatMultiline(
              this.stripStepCounterTelemetry(finalMessage),
              1800,
            );
            // Check if message contains an image URL
            const imageUrlMatch = finalMessage.match(/https:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp)/i);
            if (imageUrlMatch) {
              const imageUrl = imageUrlMatch[0];
              const caption = this.sanitizeForChat(
                this.stripStepCounterTelemetry(finalMessage.replace(imageUrl, "").trim()),
                1000,
              );
              try {
                await this.bot.sendPhoto(chatId, imageUrl, {
                  caption: caption || undefined,
                });
                this.chat.appendExternalTurn(chatId, "assistant", finalMessage);
              } catch (error) {
                // Fallback to text message if photo send fails
                this.log(`Failed to send photo, falling back to text: ${(error as Error).message}`);
                await this.bot.sendMessage(
                  chatId,
                  this.sanitizeForChat(
                    this.stripStepCounterTelemetry(finalMessage),
                    1800,
                  ),
                );
                this.chat.appendExternalTurn(chatId, "assistant", finalMessage);
              }
            } else {
              await this.bot.sendMessage(
                chatId,
                finalForChat,
                {
                  disable_web_page_preview: true,
                },
              );
              this.chat.appendExternalTurn(chatId, "assistant", finalMessage);
            }
          }

          return {
            accepted: true,
            ok: result.ok,
            message: result.message,
          };
        } catch (error) {
          await progressWork.catch(() => { });
          const message = `Execution interrupted: ${(error as Error).message || "Unknown error."}`;
          this.log(
            `task crash source=${source} chat=${chatId ?? "(none)"} duration_ms=${this.durationMsSince(taskAcceptedAtHr)}` +
            ` error=${(error as Error).message}`,
          );
          if (chatId !== null) {
            const sanitized = this.sanitizeForChat(message, 600);
            await this.bot.sendMessage(chatId, sanitized);
            this.chat.appendExternalTurn(chatId, "assistant", sanitized);
          }
          return {
            accepted: true,
            ok: false,
            message,
          };
        }
      });
    } finally {
      void this.drainQueuedChatTasks();
    }
  }

  private async handleAuthCommand(chatId: number, text: string): Promise<void> {
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length === 1 || parts[1] === "help") {
      await this.bot.sendMessage(
        chatId,
        [
          "Human auth commands:",
          "/auth pending",
          "/auth approve <request-id> [note]",
          "/auth reject <request-id> [note]",
        ].join("\n"),
      );
      return;
    }

    const sub = parts[1];
    if (sub === "pending") {
      const pending = this.humanAuth.listPending().filter((item) => item.chatId === chatId);
      if (pending.length === 0) {
        await this.bot.sendMessage(chatId, "No pending human-auth requests.");
        return;
      }
      const body = pending
        .slice(0, 20)
        .map(
          (item) =>
            `- ${item.requestId} capability=${item.capability} app=${item.currentApp} expires=${item.expiresAt}`,
        )
        .join("\n");
      await this.bot.sendMessage(chatId, `Pending human-auth requests (${pending.length}):\n${body}`);
      return;
    }

    if (sub === "approve" || sub === "reject") {
      const requestId = parts[2]?.trim();
      if (!requestId) {
        await this.bot.sendMessage(chatId, `Usage: /auth ${sub} <request-id> [note]`);
        return;
      }
      const note = parts.slice(3).join(" ").trim();
      const ok = this.humanAuth.resolvePending(requestId, sub === "approve", note, `chat:${chatId}`);
      await this.bot.sendMessage(
        chatId,
        ok ? `Request ${requestId} ${sub}d.` : `Pending request not found: ${requestId}`,
      );
      return;
    }

    await this.bot.sendMessage(chatId, "Unknown /auth subcommand. Use /auth help.");
  }
}
