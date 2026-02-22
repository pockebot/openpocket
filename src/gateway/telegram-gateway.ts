import TelegramBot, { type Message } from "node-telegram-bot-api";
import fs from "node:fs";
import path from "node:path";

import type { AgentProgressUpdate, CronJob, OpenPocketConfig, UserDecisionRequest, UserDecisionResponse } from "../types";
import { saveConfig } from "../config";
import { AgentRuntime } from "../agent/agent-runtime";
import { EmulatorManager } from "../device/emulator-manager";
import { HumanAuthBridge } from "../human-auth/bridge";
import { LocalHumanAuthStack } from "../human-auth/local-stack";
import { ChatAssistant } from "./chat-assistant";
import { CronService, type CronRunResult } from "./cron-service";
import { HeartbeatRunner } from "./heartbeat-runner";

export const TELEGRAM_MENU_COMMANDS: TelegramBot.BotCommand[] = [
  { command: "start", description: "Start or resume chat onboarding" },
  { command: "help", description: "Show command help" },
  { command: "context", description: "Inspect injected prompt context" },
  { command: "status", description: "Show gateway and emulator status" },
  { command: "model", description: "Show or switch model profile" },
  { command: "startvm", description: "Start Android emulator" },
  { command: "stopvm", description: "Stop Android emulator" },
  { command: "hidevm", description: "Hide emulator window" },
  { command: "showvm", description: "Show emulator window" },
  { command: "screen", description: "Capture manual screenshot" },
  { command: "skills", description: "List loaded skills" },
  { command: "clear", description: "Clear chat memory only" },
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

type PendingUserDecision = {
  request: UserDecisionRequest;
  resolve: (value: UserDecisionResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
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
  private lastSyncedBotDisplayName: string | null = null;
  private readonly botDisplayNameSyncStatePath: string;
  private botDisplayNameRateLimitedUntilMs = 0;
  private running = false;
  private stoppedPromise: Promise<void> | null = null;
  private stopResolver: (() => void) | null = null;

  constructor(config: OpenPocketConfig, options?: TelegramGatewayOptions) {
    this.config = config;
    this.emulator = new EmulatorManager(config);
    this.agent = new AgentRuntime(config);
    this.chat = new ChatAssistant(config);
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
    try {
      this.log(`incoming chat=${chatId} text=${JSON.stringify(message.text ?? "")}`);
      const text = message.text?.trim() ?? "";
      const shouldType = Boolean(text) && this.allowed(chatId);
      if (shouldType) {
        await this.withTypingStatus(chatId, async () => {
          await this.consumeMessage(message);
        });
      } else {
        await this.consumeMessage(message);
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

  private isCodeBasedHumanAuthCapability(capability: string): boolean {
    return capability === "sms" || capability === "2fa";
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
    await this.bot.sendMessage(chatId, `Got it. Continuing with: ${selected}`);
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

      const options = request.options.length > 0
        ? request.options.map((item, index) => `${index + 1}. ${item}`).join("\n")
        : "(no options provided)";
      const prompt = [
        "I need your decision to continue:",
        `Question: ${request.question}`,
        "",
        "Options:",
        options,
        "",
        "Reply with option number or text.",
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

  private async consumeMessage(message: Message): Promise<void> {
    const chatId = message.chat.id;
    if (!this.allowed(chatId)) {
      return;
    }

    const text = message.text?.trim();
    if (!text) {
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

      await this.bot.sendMessage(
        chatId,
        locale === "zh"
          ? "OpenPocket 已就绪。直接发需求即可；发送 /help 查看命令。"
          : "OpenPocket is ready. Send a request directly, or use /help for commands.",
      );
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
          caption: "Current emulator screenshot.",
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
      await this.bot.sendMessage(chatId, "Conversation memory cleared.");
      return;
    }

    if (text === "/reset") {
      this.chat.clear(chatId);
      const accepted = this.agent.stopCurrentTask();
      const locale = this.inferLocale(message);
      const resetSummary = accepted
        ? "Conversation memory cleared. Stop requested for the running task."
        : "Conversation memory cleared. No running task to stop.";
      await this.bot.sendMessage(chatId, resetSummary);

      if (await this.trySendOnboardingReply(chatId, locale)) {
        return;
      }

      await this.bot.sendMessage(chatId, this.sanitizeForChat(this.chat.sessionResetPrompt(locale), 1800));
      return;
    }

    if (text === "/stop") {
      const accepted = this.agent.stopCurrentTask();
      await this.bot.sendMessage(chatId, accepted ? "Stop requested." : "No running task.");
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

    const decision = await this.chat.decide(chatId, text);
    this.log(
      `decision chat=${chatId} mode=${decision.mode} confidence=${decision.confidence.toFixed(2)} reason=${decision.reason}`,
    );
    if (decision.mode === "task") {
      const task = decision.task || text;
      this.chat.appendExternalTurn(chatId, "user", task);
      await this.runTaskAsync(chatId, task);
      return;
    }

    const reply = decision.reply || (await this.chat.reply(chatId, text));
    await this.bot.sendMessage(chatId, this.sanitizeForChat(reply, 1800));
    const profileUpdate = this.chat.consumePendingProfileUpdate(chatId);
    if (profileUpdate) {
      await this.syncBotDisplayName(chatId, profileUpdate.assistantName, profileUpdate.locale);
    }
  }

  private async runTaskAsync(chatId: number, task: string): Promise<void> {
    if (this.agent.isBusy()) {
      this.log(`task rejected busy chat=${chatId} task=${JSON.stringify(task)}`);
      const busyText = "A previous task is still running. Please wait.";
      await this.bot.sendMessage(chatId, busyText);
      this.chat.appendExternalTurn(chatId, "assistant", busyText);
      return;
    }
    const locale = this.inferTaskLocale(task);
    const acceptedMessage = this.renderTaskAcceptedMessage(task, locale);
    await this.bot.sendMessage(
      chatId,
      acceptedMessage,
    );
    this.chat.appendExternalTurn(chatId, "assistant", acceptedMessage);
    void this.runTaskAndReport({ chatId, task, source: "chat", modelName: null });
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
    });
  }

  private async runTaskAndReport(params: {
    chatId: number | null;
    task: string;
    source: "chat" | "cron";
    modelName: string | null;
  }): Promise<CronRunResult> {
    const { chatId, task, source, modelName } = params;
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

    return this.withTypingStatus(source === "chat" ? chatId : null, async () => {
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
          task,
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
                    const lines = [
                      `Human authorization required (${request.capability}).`,
                      `Request ID: ${opened.requestId}`,
                      `Current app: ${request.currentApp}`,
                      `Instruction: ${request.instruction}`,
                      `Reason: ${request.reason || "no reason provided"}`,
                      `Expires at: ${opened.expiresAt}`,
                      "",
                      "Fallback manual commands:",
                      opened.manualApproveCommand,
                      opened.manualRejectCommand,
                    ];

                    if (isCodeFlow) {
                      await this.bot.sendMessage(
                        chatId,
                        [
                          ...lines,
                          "",
                          "Code flow (recommended):",
                          `- reply plain code (4-10 digits), for example: 123456`,
                          `- or run: ${opened.manualApproveCommand} <code>`,
                          `- reject with: ${opened.manualRejectCommand}`,
                          opened.openUrl
                            ? "- web page is optional for SMS/2FA; Telegram code reply is faster."
                            : "- web page is unavailable; use Telegram code reply.",
                        ].join("\n"),
                      );
                      return;
                    }

                    if (opened.openUrl) {
                      await this.bot.sendMessage(chatId, lines.join("\n"), {
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

                    await this.bot.sendMessage(
                      chatId,
                      `${lines.join("\n")}\n\nWeb link is unavailable. Use manual approve/reject commands.`,
                    );
                  },
                );
              },
          source === "cron" ? "minimal" : undefined,
          chatId === null
            ? undefined
            : async (request) => this.requestUserDecisionFromChat(chatId, request),
        );
        await progressWork;

        this.log(`task done source=${source} chat=${chatId ?? "(none)"} ok=${result.ok} session=${result.sessionPath}`);

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
          await this.bot.sendMessage(
            chatId,
            this.sanitizeForChat(
              this.stripStepCounterTelemetry(finalMessage),
              1800,
            ),
          );
          this.chat.appendExternalTurn(chatId, "assistant", finalMessage);
        }

        return {
          accepted: true,
          ok: result.ok,
          message: result.message,
        };
      } catch (error) {
        await progressWork.catch(() => {});
        const message = `Execution interrupted: ${(error as Error).message || "Unknown error."}`;
        this.log(`task crash source=${source} chat=${chatId ?? "(none)"} error=${(error as Error).message}`);
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
