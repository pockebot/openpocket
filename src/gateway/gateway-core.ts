import fs from "node:fs";
import path from "node:path";

import type {
  AgentProgressUpdate,
  CronJob,
  HumanAuthCapability,
  OpenPocketConfig,
  UserDecisionRequest,
  UserDecisionResponse,
  UserInputRequest,
  UserInputResponse,
} from "../types.js";
import type {
  ChannelRouter,
  InboundEnvelope,
  SendOptions,
  SessionKeyResolver,
  PairingStore,
} from "../channel/types.js";
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
import { evaluateDmPolicy } from "../channel/dm-policy.js";
import type { DmPolicy, GroupPolicy } from "../channel/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OnboardingLocale = "zh" | "en";

type ProgressNarrationState = {
  lastNotifiedProgress: AgentProgressUpdate | null;
  lastNotifiedMessage: string;
  skippedSteps: number;
  recentProgress: AgentProgressUpdate[];
  allProgress: AgentProgressUpdate[];
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

type QueuedTask = {
  envelope: InboundEnvelope;
  task: string;
  sessionKey: string;
  onDone?: (result: CronRunResult) => void | Promise<void>;
};

export interface GatewayCoreOptions {
  logger?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Command handler registry
// ---------------------------------------------------------------------------

type CommandHandler = (envelope: InboundEnvelope, args: string) => Promise<void>;

// ---------------------------------------------------------------------------
// GatewayCore
// ---------------------------------------------------------------------------

/**
 * Platform-agnostic orchestration core extracted from TelegramGateway.
 *
 * Receives InboundEnvelopes from ChannelRouter and dispatches to:
 * - command handlers
 * - chat mode (ChatAssistant)
 * - task mode (AgentRuntime)
 * - human-auth relay
 * - cron jobs
 *
 * All channel I/O goes through the ChannelRouter.
 */
export class GatewayCore {
  private readonly config: OpenPocketConfig;
  private readonly router: ChannelRouter;
  private readonly sessionKeyResolver: SessionKeyResolver;
  private readonly pairingStore: PairingStore;
  private readonly emulator: EmulatorManager;
  private readonly agent: AgentRuntime;
  private chat: ChatAssistant;
  private readonly humanAuth: HumanAuthBridge;
  private readonly localHumanAuthStack: LocalHumanAuthStack;
  private localHumanAuthActive = false;
  private readonly heartbeat: HeartbeatRunner;
  private readonly cron: CronService;
  private readonly writeLogLine: (line: string) => void;

  private readonly chatContextStore = new Map<string, Map<string, ChatContextItem>>();
  private readonly pendingTasks: QueuedTask[] = [];
  private drainingTaskQueue = false;
  private running = false;

  private readonly commandHandlers = new Map<string, CommandHandler>();

  private static readonly CHAT_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;
  private static readonly NARRATION_LLM_INTERVAL = 8;

  constructor(
    config: OpenPocketConfig,
    router: ChannelRouter,
    sessionKeyResolver: SessionKeyResolver,
    pairingStore: PairingStore,
    options?: GatewayCoreOptions,
  ) {
    this.config = config;
    this.router = router;
    this.sessionKeyResolver = sessionKeyResolver;
    this.pairingStore = pairingStore;
    this.emulator = new EmulatorManager(config);
    this.agent = new AgentRuntime(config);
    this.chat = new ChatAssistant(config);
    this.humanAuth = new HumanAuthBridge(config, (line) => this.writeLogLine(line));
    this.localHumanAuthStack = new LocalHumanAuthStack(config, (line) => this.writeLogLine(line));

    this.writeLogLine =
      options?.logger ??
      ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      });

    this.heartbeat = new HeartbeatRunner(config, {
      log: (line) => this.writeLogLine(line),
      readSnapshot: () => ({
        busy: this.agent.isBusy(),
        currentTask: this.agent.getCurrentTask(),
        taskRuntimeMs: this.agent.getCurrentTaskRuntimeMs(),
        devices: this.emulator.status().devices.length,
        bootedDevices: this.emulator.status().bootedDevices.length,
      }),
    });

    this.cron = new CronService(config, {
      runTask: async (job) => this.runScheduledJob(job),
      log: (line) => this.writeLogLine(line),
    });

    this.registerBuiltinCommands();
    router.onInbound((envelope) => this.handleInbound(envelope));
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.config.humanAuth.enabled && this.config.humanAuth.useLocalRelay) {
      try {
        const started = await this.localHumanAuthStack.start();
        this.config.humanAuth.relayBaseUrl = started.relayBaseUrl;
        this.config.humanAuth.publicBaseUrl = started.publicBaseUrl;
        this.localHumanAuthActive = true;
        this.log(`human-auth local stack ready relay=${started.relayBaseUrl} public=${started.publicBaseUrl}`, "info", "humanAuth");
      } catch (error) {
        this.localHumanAuthActive = false;
        this.log(`human-auth local stack failed error=${(error as Error).message}`, "error", "humanAuth");
      }
    }

    this.heartbeat.start();
    this.cron.start();
    await this.router.startAll();
    this.log(`gateway core started model=${this.config.defaultModel}`, "info", "core");
  }

  async stop(reason = "manual"): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.heartbeat.stop();
    this.cron.stop();
    if (this.localHumanAuthActive) {
      await this.localHumanAuthStack.stop();
      this.localHumanAuthActive = false;
    }
    await this.router.stopAll(reason);
    this.log(`gateway core stopped reason=${reason}`, "info", "core");
  }

  isRunning(): boolean {
    return this.running;
  }

  applyExternalConfig(updated: OpenPocketConfig): void {
    (this as unknown as { config: OpenPocketConfig }).config = updated;
    this.chat = new ChatAssistant(updated);
    this.agent.updateConfig(updated);
    this.log(`config hot-reloaded via dashboard model=${updated.defaultModel}`, "info", "core");
  }

  // -----------------------------------------------------------------------
  // Command registration
  // -----------------------------------------------------------------------

  registerCommand(name: string, handler: CommandHandler): void {
    this.commandHandlers.set(name.toLowerCase(), handler);
  }

  private registerBuiltinCommands(): void {
    this.registerCommand("help", async (env) => {
      const commands = [
        "OpenPocket commands:",
        "/start", "/help", "/status", "/model [name]",
        "/startvm", "/stopvm", "/hidevm", "/showvm",
        "/screen", "/skills", "/clear", "/new [task]",
        "/reset", "/stop", "/restart",
        "/cronrun <job-id>", "/auth", "/run <task>",
        "/pairing list [channel]", "/pairing approve <channel> <code>",
      ];
      await this.router.replyText(env, commands.join("\n"));
    });

    this.registerCommand("status", async (env) => {
      const status = this.emulator.status();
      const lines = [
        `Project: ${this.config.projectName}`,
        `Model: ${this.config.defaultModel}`,
        `Target: ${this.config.target.type} (${deviceTargetLabel(this.config.target.type)})`,
        `Agent busy: ${this.agent.isBusy()}`,
        `Current task: ${this.agent.getCurrentTask() ?? "(none)"}`,
        `AVD: ${status.avdName}`,
        `Devices: ${status.devices.length > 0 ? status.devices.join(", ") : "(none)"}`,
        `Booted: ${status.bootedDevices.length > 0 ? status.bootedDevices.join(", ") : "(none)"}`,
        `Channel: ${env.channelType}`,
        `Human auth: ${this.config.humanAuth.enabled ? "enabled" : "disabled"}`,
      ];
      await this.router.replyText(env, lines.join("\n"));
    });

    this.registerCommand("model", async (env, args) => {
      if (!args) {
        await this.router.replyText(
          env,
          `Current model: ${this.config.defaultModel}\nAvailable: ${Object.keys(this.config.models).join(", ")}`,
        );
        return;
      }
      if (!this.config.models[args]) {
        await this.router.replyText(env, `Unknown model: ${args}`);
        return;
      }
      this.config.defaultModel = args;
      saveConfig(this.config);
      this.chat = new ChatAssistant(this.config);
      await this.router.replyText(env, `Default model updated: ${args}`);
    });

    this.registerCommand("startvm", async (env) => {
      const msg = await this.emulator.start();
      await this.router.replyText(env, msg);
    });

    this.registerCommand("stopvm", async (env) => {
      await this.router.replyText(env, this.emulator.stop());
    });

    this.registerCommand("hidevm", async (env) => {
      await this.router.replyText(env, await this.emulator.ensureHiddenBackground());
    });

    this.registerCommand("showvm", async (env) => {
      await this.router.replyText(env, await this.emulator.ensureWindowVisible());
    });

    this.registerCommand("screen", async (env) => {
      this.chat.appendExternalTurn(this.peerIdNum(env), "user", "/screen");
      const screenshotPath = await this.agent.captureManualScreenshot();
      this.log(`manual screenshot channel=${env.channelType} sender=${env.senderId} path=${screenshotPath}`, "info", "task");
      try {
        await this.router.replyImage(env, screenshotPath, "Current device screenshot.");
        this.chat.appendExternalTurn(this.peerIdNum(env), "assistant", "[shared current emulator screenshot]");
      } catch (error) {
        const fallback = `Screenshot saved locally but upload failed: ${(error as Error).message}`;
        await this.router.replyText(env, fallback);
        this.chat.appendExternalTurn(this.peerIdNum(env), "assistant", fallback);
      }
    });

    this.registerCommand("skills", async (env) => {
      const skills = this.agent.listSkills();
      if (skills.length === 0) {
        await this.router.replyText(env, "No skills loaded.");
        return;
      }
      const body = skills
        .slice(0, 25)
        .map((s) => `- [${s.source}] ${s.name}: ${s.description}`)
        .join("\n");
      await this.router.replyText(env, `Loaded skills (${skills.length}):\n${body}`);
    });

    this.registerCommand("clear", async (env) => {
      this.chat.clear(this.peerIdNum(env));
      this.clearChatContext(env.peerId);
      await this.router.replyText(env, "Conversation memory cleared.");
    });

    this.registerCommand("new", async (env, args) => {
      this.chat.clear(this.peerIdNum(env));
      this.clearChatContext(env.peerId);
      this.clearQueuedTasksForPeer(env.peerId);
      const sessionKey = this.sessionKeyResolver.resolve(env);
      const reset = this.agent.resetSession(sessionKey);
      if (!reset) {
        await this.router.replyText(env, "Failed to start a new session.");
        return;
      }
      await this.router.replyText(env, `New session started (${sessionKey} -> ${reset.sessionId}).`);
      if (args) {
        this.chat.appendExternalTurn(this.peerIdNum(env), "user", args);
        await this.enqueueTask(env, args);
      }
    });

    this.registerCommand("reset", async (env) => {
      this.chat.clear(this.peerIdNum(env));
      this.clearChatContext(env.peerId);
      this.clearQueuedTasksForPeer(env.peerId);
      const accepted = this.agent.stopCurrentTask();
      const msg = accepted
        ? "Conversation memory cleared. Stop requested for the running task."
        : "Conversation memory cleared. No running task to stop.";
      await this.router.replyText(env, msg);
    });

    this.registerCommand("stop", async (env) => {
      const accepted = this.agent.stopCurrentTask();
      await this.router.replyText(env, accepted ? "Stop requested." : "No running task.");
    });

    this.registerCommand("restart", async (env) => {
      if (process.listenerCount("SIGUSR1") === 0) {
        await this.router.replyText(env, "Restart is unavailable in the current runtime mode.");
        return;
      }
      await this.router.replyText(env, "Gateway restart requested. Reconnecting...");
      setTimeout(() => {
        try { process.kill(process.pid, "SIGUSR1"); } catch { /* ignore */ }
      }, 50);
    });

    this.registerCommand("cronrun", async (env, args) => {
      if (!args) {
        await this.router.replyText(env, "Usage: /cronrun <job-id>");
        return;
      }
      const found = await this.cron.runNow(args);
      await this.router.replyText(env, found ? `Cron job triggered: ${args}` : `Cron job not found: ${args}`);
    });

    this.registerCommand("run", async (env, args) => {
      if (!args) {
        await this.router.replyText(env, "Usage: /run <task>");
        return;
      }
      this.chat.appendExternalTurn(this.peerIdNum(env), "user", args);
      await this.enqueueTask(env, args);
    });

    this.registerCommand("auth", async (env, args) => {
      await this.handleAuthCommand(env, args);
    });

    this.registerCommand("pairing", async (env, args) => {
      await this.handlePairingCommand(env, args);
    });

    this.registerCommand("start", async (env) => {
      const locale = this.inferLocale(env);
      if (this.chat.isOnboardingPending()) {
        const seed = locale === "zh" ? "你好" : "hello";
        const decision = await this.chat.decide(this.peerIdNum(env), seed);
        const reply = decision.reply || (locale === "zh" ? "我们先做一个简短初始化。" : "Let's do a quick onboarding first.");
        await this.router.replyText(env, this.sanitizeForChat(reply, 1800));
        return;
      }
      const welcome = await this.chat.startReadyReply(locale);
      await this.router.replyText(env, this.sanitizeForChat(welcome, 1800));
    });
  }

  // -----------------------------------------------------------------------
  // Inbound message handling
  // -----------------------------------------------------------------------

  async handleInbound(envelope: InboundEnvelope): Promise<void> {
    const inboundText = this.config.gatewayLogging.includePayloads
      ? ` text=${JSON.stringify(this.previewPayload(envelope.text, 120))}`
      : "";
    this.log(`incoming channel=${envelope.channelType} sender=${envelope.senderId}${inboundText}`, "debug", "access");

    if (!await this.checkAccess(envelope)) return;

    if (envelope.command) {
      const handler = this.commandHandlers.get(envelope.command.toLowerCase());
      if (handler) {
        await handler(envelope, envelope.commandArgs ?? "");
        return;
      }
    }

    await this.handlePlainMessage(envelope);
  }

  /**
   * Unified access control for all channels.
   *
   * Flow (aligned with OpenClaw):
   * 1. If the channel has no approved senders AND no static allowFrom,
   *    the first sender triggers an "owner claim" — they are auto-approved
   *    as the owner of this channel.
   * 2. Otherwise, the configured dmPolicy is evaluated:
   *    - "pairing": unknown senders get a code for owner approval
   *    - "allowlist": only static allowFrom + approved senders
   *    - "open": all allowed
   *    - "disabled": all blocked
   *
   * Returns true if the message should be processed, false if blocked.
   */
  private async checkAccess(envelope: InboundEnvelope): Promise<boolean> {
    if (envelope.peerKind === "group") {
      return this.checkGroupAccess(envelope);
    }
    return this.checkDmAccess(envelope);
  }

  /**
   * DM access control (aligned with OpenClaw):
   * 1. Owner claim: first sender auto-approved when no allowFrom and no approved senders.
   * 2. Otherwise evaluate dmPolicy (pairing / allowlist / open / disabled).
   */
  private async checkDmAccess(envelope: InboundEnvelope): Promise<boolean> {
    const dmPolicy = this.resolveDmPolicy(envelope.channelType);
    const allowFrom = this.resolveAllowFrom(envelope.channelType);

    const noStaticAllowFrom = allowFrom.length === 0;
    const noApprovedSenders = this.pairingStore.isAllowlistEmpty(envelope.channelType);

    if (noStaticAllowFrom && noApprovedSenders) {
      this.pairingStore.addToAllowlist(envelope.channelType, envelope.senderId);
      this.log(`owner claim channel=${envelope.channelType} sender=${envelope.senderId} first_sender_auto_approved=true`, "info", "access");
      const locale = this.inferLocale(envelope);
      const msg = locale === "zh"
        ? "你是此频道的第一个用户，已自动注册为 owner。"
        : "You are the first user on this channel — auto-registered as owner.";
      await this.router.replyText(envelope, msg);
      return true;
    }

    const result = evaluateDmPolicy(envelope.senderId, envelope.senderName, {
      policy: dmPolicy,
      allowFrom,
      pairingStore: this.pairingStore,
      channelType: envelope.channelType,
    });

    if (!result.allowed) {
      if (result.pairingCode) {
        const locale = this.inferLocale(envelope);
        const msg = locale === "zh"
          ? `请将此配对码发给管理员审批：${result.pairingCode}\n（有效期 1 小时）`
          : `Please send this pairing code to the owner for approval: ${result.pairingCode}\n(Valid for 1 hour)`;
        await this.router.replyText(envelope, msg);
      }
      this.log(`access denied channel=${envelope.channelType} sender=${envelope.senderId} policy=${dmPolicy} reason=${result.reason}`, "warn", "access");
      return false;
    }

    return true;
  }

  /**
   * Group access control:
   * - "open" (default): all group messages allowed
   * - "allowlist": sender must be in DM allowlist/approved, OR group peerId must be in allowGroups
   * - "disabled": all group messages blocked
   *
   * Groups never trigger owner claim or pairing codes.
   */
  private async checkGroupAccess(envelope: InboundEnvelope): Promise<boolean> {
    if (envelope.adapterPreAuthorized) {
      return true;
    }

    const groupPolicy = this.resolveGroupPolicy(envelope.channelType);

    if (groupPolicy === "disabled") {
      this.log(`group access denied channel=${envelope.channelType} group=${envelope.peerId} sender=${envelope.senderId} reason=group_policy_disabled`, "warn", "access");
      return false;
    }

    if (groupPolicy === "open") {
      return true;
    }

    const allowFrom = this.resolveAllowFrom(envelope.channelType);
    if (allowFrom.includes("*") || allowFrom.includes(envelope.senderId)) {
      return true;
    }
    if (this.pairingStore.isApproved(envelope.channelType, envelope.senderId)) {
      return true;
    }

    const allowGroups = this.resolveAllowGroups(envelope.channelType);
    if (allowGroups.includes(envelope.peerId)) {
      return true;
    }

    this.log(`group access denied channel=${envelope.channelType} group=${envelope.peerId} sender=${envelope.senderId} reason=not_in_group_allowlist`, "warn", "access");
    return false;
  }

  private async handlePlainMessage(envelope: InboundEnvelope): Promise<void> {
    const text = envelope.text.trim();
    if (!text) return;

    const chatId = this.peerIdNum(envelope);

    if (this.config.agent.chatOnlyMode) {
      this.log(
        `chat-only channel=${envelope.channelType} sender=${envelope.senderId} model=${this.config.defaultModel}`,
        "info",
        "task",
      );
      const reply = await this.chat.reply(chatId, text);
      await this.router.replyText(envelope, this.sanitizeForChat(reply, 1800));
      return;
    }

    if (this.config.agent.skipDecideClassification) {
      if (this.looksLikeChat(text)) {
        this.log(`local-classify=chat channel=${envelope.channelType} sender=${envelope.senderId}`, "debug", "task");
        const reply = await this.chat.reply(chatId, text);
        await this.router.replyText(envelope, this.sanitizeForChat(reply, 1800));
        return;
      }
      this.chat.appendExternalTurn(chatId, "user", text);
      await this.enqueueTask(envelope, text);
      return;
    }

    const decision = await this.chat.decide(chatId, text);
    this.log(
      `decision channel=${envelope.channelType} sender=${envelope.senderId} model=${this.config.defaultModel} mode=${decision.mode} confidence=${decision.confidence.toFixed(2)}`,
      "debug",
      "task",
    );

    if (decision.mode === "task") {
      const task = decision.task || text;
      this.chat.appendExternalTurn(chatId, "user", task);
      await this.enqueueTask(envelope, task);
      return;
    }

    const reply = decision.reply || (await this.chat.reply(chatId, text));
    await this.router.replyText(envelope, this.sanitizeForChat(reply, 1800));
  }

  /**
   * Fast local heuristic: returns true if the message looks like casual chat
   * rather than a phone-operation task. Avoids an LLM call for greetings,
   * questions about the bot, and other short conversational messages.
   */
  private looksLikeChat(text: string): boolean {
    const t = text.toLowerCase().replace(/[!！?？。，,.\s]+/g, "");
    if (t.length === 0) return true;

    const chatPatterns = [
      /^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在不在|早上好|晚上好|下午好|早安|晚安)$/,
      /^(谢谢|感谢|thanks|thank\s*you|thx|ok|好的|了解|明白|收到|嗯|哦|哈哈|lol|haha)$/,
      /^(你是谁|你叫什么|你能做什么|你会什么|介绍一下|what\s*are\s*you|who\s*are\s*you)$/,
    ];
    for (const p of chatPatterns) {
      if (p.test(t)) return true;
    }

    const taskKeywords = [
      "打开", "安装", "卸载", "搜索", "发送", "拍照", "截图", "录屏",
      "下载", "上传", "设置", "修改", "删除", "创建", "拨打", "电话",
      "短信", "微信", "支付宝", "淘宝", "抖音", "百度", "地图", "导航",
      "app", "应用", "浏览器", "网页", "链接", "wifi", "蓝牙", "音量",
      "亮度", "闹钟", "日历", "备忘录", "相册", "视频", "音乐",
      "open", "install", "search", "send", "launch", "tap", "click",
      "navigate", "go to", "find", "download", "uninstall", "call", "text",
    ];
    const hasTaskKeyword = taskKeywords.some((kw) => text.toLowerCase().includes(kw));
    if (hasTaskKeyword) return false;

    if (text.length <= 10 && !hasTaskKeyword) return true;

    return false;
  }

  // -----------------------------------------------------------------------
  // Task execution
  // -----------------------------------------------------------------------

  private async enqueueTask(
    envelope: InboundEnvelope,
    task: string,
    options?: { sessionKey?: string; onDone?: (result: CronRunResult) => void | Promise<void>; skipAck?: boolean },
  ): Promise<void> {
    const locale = this.inferTaskLocale(task);
    const isIdle = !this.drainingTaskQueue && !this.agent.isBusy() && this.pendingTasks.length === 0;
    const position = this.pendingTasks.length + 1;

    if (!options?.skipAck) {
      const ack = isIdle
        ? (locale === "zh"
          ? `收到，我先处理这个任务：${task}\n有明确进展我会及时告诉你。`
          : `On it: ${task}\nI'll update you when there's meaningful progress.`)
        : (locale === "zh"
          ? `当前有任务在执行。你的新任务已加入队列（第 ${position} 位）。`
          : `A previous task is still running. Your new task is queued (position ${position}).`);
      await this.router.replyText(envelope, ack);
      this.chat.appendExternalTurn(this.peerIdNum(envelope), "assistant", ack);
    }

    this.pendingTasks.push({
      envelope,
      task,
      sessionKey: options?.sessionKey ?? this.sessionKeyResolver.resolve(envelope),
      onDone: options?.onDone,
    });
    void this.drainTaskQueue();
  }

  private async drainTaskQueue(): Promise<void> {
    if (this.drainingTaskQueue || this.pendingTasks.length === 0 || this.agent.isBusy()) return;

    this.drainingTaskQueue = true;
    try {
      while (this.pendingTasks.length > 0) {
        if (this.agent.isBusy()) break;
        const next = this.pendingTasks.shift();
        if (!next) break;
        const result = await this.runTaskAndReport(next.envelope, next.task, next.sessionKey);
        if (next.onDone) {
          try { await next.onDone(result); } catch (error) {
            this.log(`task completion callback error channel=${next.envelope.channelType} error=${(error as Error).message}`, "warn", "task");
          }
        }
      }
    } finally {
      this.drainingTaskQueue = false;
      if (this.pendingTasks.length > 0 && !this.agent.isBusy()) {
        void this.drainTaskQueue();
      }
    }
  }

  private async runTaskAndReport(
    envelope: InboundEnvelope,
    task: string,
    sessionKey: string,
  ): Promise<CronRunResult> {
    const enrichedTask = this.enrichTaskWithChatContext(task, envelope.peerId);
    const locale = this.inferTaskLocale(task);
    const narrationState: ProgressNarrationState = {
      lastNotifiedProgress: null, lastNotifiedMessage: "",
      skippedSteps: 0, recentProgress: [], allProgress: [],
    };
    let progressWork: Promise<void> = Promise.resolve();

    const taskDetail = this.config.gatewayLogging.includePayloads
      ? ` task=${JSON.stringify(this.previewPayload(task, 160))}`
      : "";
    this.log(`task accepted channel=${envelope.channelType} sender=${envelope.senderId} model=${this.config.defaultModel}${taskDetail}`, "info", "task");

    const adapter = this.router.getAdapter(envelope.channelType);

    try {
      if (adapter) await adapter.setTypingIndicator(envelope.peerId, true);

      const enqueueProgress = (progress: AgentProgressUpdate): void => {
        progressWork = progressWork.then(async () => {
          const recentProgress = [...narrationState.recentProgress, progress].slice(-8);
          narrationState.allProgress = [...narrationState.allProgress, progress].slice(-16);

          const action = String(progress.actionType || "").toLowerCase();
          const isHighSignal =
            progress.step === 1 || action === "finish" || action === "request_human_auth"
            || action === "request_user_input"
            || /(error|failed|timeout|interrupted|rejected)/i.test(`${progress.message} ${progress.thought}`);
          const isIntervalStep = narrationState.skippedSteps >= GatewayCore.NARRATION_LLM_INTERVAL;
          const useLlm = isHighSignal || isIntervalStep;

          const decision = useLlm
            ? await this.chat.narrateTaskProgress({
              task, locale, progress, recentProgress,
              lastNotifiedProgress: narrationState.lastNotifiedProgress,
              skippedSteps: narrationState.skippedSteps,
            })
            : this.chat.fallbackTaskProgressNarration({
              task, locale, progress, recentProgress,
              lastNotifiedProgress: narrationState.lastNotifiedProgress,
              skippedSteps: narrationState.skippedSteps,
            });

          if (!decision.notify) {
            narrationState.skippedSteps += 1;
            narrationState.recentProgress = recentProgress;
            return;
          }
          const message = this.sanitizeForChat(decision.message, 1800);
          if (!message.trim()) {
            narrationState.skippedSteps += 1;
            narrationState.recentProgress = recentProgress;
            return;
          }
          narrationState.lastNotifiedProgress = progress;
          narrationState.lastNotifiedMessage = message;
          narrationState.skippedSteps = 0;
          narrationState.recentProgress = [];
          await this.router.replyText(envelope, message);
        }).catch((error) => {
          this.log(`progress narration error channel=${envelope.channelType} error=${(error as Error).message}`, "warn", "task");
        });
      };

      const result = await this.agent.runTask(
        enrichedTask,
        undefined,
        async (progress) => enqueueProgress(progress),
        async (request) => {
          return this.humanAuth.requestAndWait(
            { chatId: this.peerIdNum(envelope), task, request: { ...request, timeoutSec: Math.max(30, request.timeoutSec) } },
            async (opened) => {
              const escalationMessage = this.sanitizeForChat(
                await this.chat.narrateEscalation({
                  event: "human_auth", locale, task,
                  capability: request.capability, instruction: request.instruction,
                  reason: request.reason, hasWebLink: Boolean(opened.openUrl),
                  isCodeFlow: request.capability === "sms" || request.capability === "2fa",
                  includeLocalSecurityAssurance: false,
                }),
                1500,
              );
              if (opened.openUrl && adapter) {
                await adapter.sendHumanAuthEscalation(envelope.peerId, escalationMessage, opened.openUrl);
              } else {
                await this.router.replyText(envelope, escalationMessage);
              }
            },
          );
        },
        undefined,
        adapter
          ? async (request) => adapter.requestUserDecision(envelope.peerId, request)
          : undefined,
        sessionKey,
        adapter
          ? async (request) => adapter.requestUserInput(envelope.peerId, request)
          : undefined,
      );
      await progressWork;

      this.log(`task done channel=${envelope.channelType} model=${this.config.defaultModel} ok=${result.ok} session=${result.sessionPath}`, "info", "task");

      const finalMessage = await this.chat.narrateTaskOutcome({
        task, locale, ok: result.ok, rawResult: result.message,
        recentProgress: narrationState.allProgress,
        skillPath: result.skillPath ?? null,
        scriptPath: result.scriptPath ?? null,
      });
      await this.router.replyText(envelope, this.sanitizeForChat(finalMessage, 1800), { disableLinkPreview: true });
      this.chat.appendExternalTurn(this.peerIdNum(envelope), "assistant", finalMessage);

      return { accepted: true, ok: result.ok, message: result.message };
    } catch (error) {
      await progressWork.catch(() => {});
      const message = `Execution interrupted: ${(error as Error).message || "Unknown error."}`;
      this.log(`task crash channel=${envelope.channelType} model=${this.config.defaultModel} error=${(error as Error).message}`, "error", "task");
      await this.router.replyText(envelope, this.sanitizeForChat(message, 600));
      return { accepted: true, ok: false, message };
    } finally {
      if (adapter) await adapter.setTypingIndicator(envelope.peerId, false).catch(() => {});
      void this.drainTaskQueue();
    }
  }

  // -----------------------------------------------------------------------
  // Cron
  // -----------------------------------------------------------------------

  private async runScheduledJob(job: CronJob): Promise<CronRunResult> {
    if (this.agent.isBusy()) {
      return { accepted: false, ok: false, message: "Agent is busy." };
    }

    const adapters = this.router.getAllAdapters();
    const firstAdapter = adapters[0];
    if (!firstAdapter) {
      return { accepted: false, ok: false, message: "No channel adapter available." };
    }

    const envelope: InboundEnvelope = {
      channelType: firstAdapter.channelType,
      senderId: "cron",
      senderName: "Cron",
      senderLanguageCode: null,
      peerId: job.chatId !== null ? String(job.chatId) : "cron",
      peerKind: "dm",
      text: job.task,
      attachments: [],
      rawEvent: job,
      receivedAt: new Date().toISOString(),
    };

    if (job.chatId !== null) {
      await this.router.replyText(envelope, `Scheduled task started (${job.name}): ${job.task}`);
    }

    return this.runTaskAndReport(envelope, job.task, `cron:${job.id}`);
  }

  // -----------------------------------------------------------------------
  // Auth command
  // -----------------------------------------------------------------------

  private async handleAuthCommand(envelope: InboundEnvelope, args: string): Promise<void> {
    const parts = args.split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts[0] === "help") {
      await this.router.replyText(envelope, [
        "Human auth commands:",
        "/auth pending",
        "/auth approve <request-id> [note]",
        "/auth reject <request-id> [note]",
      ].join("\n"));
      return;
    }

    const sub = parts[0];
    const chatId = this.peerIdNum(envelope);

    if (sub === "pending") {
      const pending = this.humanAuth.listPending().filter((item) => item.chatId === chatId);
      if (pending.length === 0) {
        await this.router.replyText(envelope, "No pending human-auth requests.");
        return;
      }
      const body = pending.slice(0, 20).map((item) =>
        `- ${item.requestId} capability=${item.capability} app=${item.currentApp}`).join("\n");
      await this.router.replyText(envelope, `Pending (${pending.length}):\n${body}`);
      return;
    }

    if (sub === "approve" || sub === "reject") {
      const requestId = parts[1]?.trim();
      if (!requestId) {
        await this.router.replyText(envelope, `Usage: /auth ${sub} <request-id> [note]`);
        return;
      }
      const note = parts.slice(2).join(" ").trim();
      const ok = this.humanAuth.resolvePending(requestId, sub === "approve", note, `channel:${envelope.channelType}:${envelope.senderId}`);
      await this.router.replyText(envelope, ok ? `Request ${requestId} ${sub}d.` : `Not found: ${requestId}`);
      return;
    }

    await this.router.replyText(envelope, "Unknown /auth subcommand. Use /auth help.");
  }

  // -----------------------------------------------------------------------
  // Pairing command
  // -----------------------------------------------------------------------

  private async handlePairingCommand(envelope: InboundEnvelope, args: string): Promise<void> {
    const parts = args.split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts[0] === "help") {
      await this.router.replyText(envelope, [
        "Pairing commands:",
        "/pairing list [channel]",
        "/pairing approve <channel> <code>",
        "/pairing reject <channel> <code>",
      ].join("\n"));
      return;
    }

    const sub = parts[0];

    if (sub === "list") {
      const channelFilter = parts[1] as import("../channel/types.js").ChannelType | undefined;
      const pending = this.pairingStore.listPending(channelFilter);
      if (pending.length === 0) {
        await this.router.replyText(envelope, "No pending pairing requests.");
        return;
      }
      const body = pending.map((p) =>
        `- [${p.channelType}] code=${p.code} sender=${p.senderId} (${p.senderName ?? "unknown"}) expires=${p.expiresAt}`).join("\n");
      await this.router.replyText(envelope, `Pending pairings (${pending.length}):\n${body}`);
      return;
    }

    if (sub === "approve" || sub === "reject") {
      const channel = parts[1] as import("../channel/types.js").ChannelType | undefined;
      const code = parts[2]?.trim();
      if (!channel || !code) {
        await this.router.replyText(envelope, `Usage: /pairing ${sub} <channel> <code>`);
        return;
      }
      const ok = sub === "approve"
        ? this.pairingStore.approvePairing(channel, code)
        : this.pairingStore.rejectPairing(channel, code);
      const pastTense = sub === "approve" ? "approved" : "rejected";
      await this.router.replyText(envelope, ok ? `Pairing ${code} ${pastTense} on ${channel}.` : `Pairing code not found: ${code}`);
      return;
    }

    await this.router.replyText(envelope, "Unknown /pairing subcommand. Use /pairing help.");
  }

  // -----------------------------------------------------------------------
  // Chat context store (extracted from TelegramGateway)
  // -----------------------------------------------------------------------

  private enrichTaskWithChatContext(task: string, peerId: string): string {
    this.pruneExpiredChatContext(peerId);
    const bucket = this.chatContextStore.get(peerId);
    if (!bucket || bucket.size === 0) return task;

    const taskLower = task.toLowerCase();
    const contextLines: string[] = [];
    const items = [...bucket.values()].filter((i) => i.sensitivity === "non_sensitive").sort((a, b) => a.key.localeCompare(b.key));
    for (const item of items) {
      if (taskLower.includes(item.value.toLowerCase())) continue;
      contextLines.push(`- ${item.key}=${item.value}`);
    }
    if (contextLines.length === 0) return task;

    return [task, "", "[Channel context cache]", "Use these non-sensitive user-provided fields when relevant:", ...contextLines, "- Do not treat these as credentials/OTP/payment data."].join("\n");
  }

  private pruneExpiredChatContext(peerId: string): void {
    const bucket = this.chatContextStore.get(peerId);
    if (!bucket || bucket.size === 0) return;
    const cutoff = Date.now() - GatewayCore.CHAT_CONTEXT_TTL_MS;
    for (const [key, item] of bucket.entries()) {
      const ts = Date.parse(item.updatedAt);
      if (!Number.isFinite(ts) || ts < cutoff) bucket.delete(key);
    }
    if (bucket.size === 0) this.chatContextStore.delete(peerId);
  }

  private clearChatContext(peerId: string): void {
    this.chatContextStore.delete(peerId);
  }

  // -----------------------------------------------------------------------
  // Task queue helpers
  // -----------------------------------------------------------------------

  private clearQueuedTasksForPeer(peerId: string): number {
    const before = this.pendingTasks.length;
    const remain = this.pendingTasks.filter((t) => t.envelope.peerId !== peerId);
    this.pendingTasks.splice(0, this.pendingTasks.length, ...remain);
    return before - remain.length;
  }

  // -----------------------------------------------------------------------
  // Utility helpers
  // -----------------------------------------------------------------------

  private previewPayload(value: string, maxChars: number): string {
    const compact = String(value || "").replace(/\s+/g, " ").trim();
    if (compact.length <= maxChars) {
      return compact;
    }
    return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private log(
    message: string,
    level: "debug" | "info" | "warn" | "error" = "info",
    module: "core" | "access" | "task" | "channel" | "cron" | "heartbeat" | "humanAuth" | "chat" = "core",
  ): void {
    this.writeLogLine(`[OpenPocket][gateway-core][${module}][${level}] ${new Date().toISOString()} ${message}`);
  }

  private inferLocale(envelope: InboundEnvelope): OnboardingLocale {
    const lang = envelope.senderLanguageCode ?? "";
    if (lang.startsWith("zh")) return "zh";
    return /[\u4e00-\u9fff]/.test(envelope.text) ? "zh" : "en";
  }

  private inferTaskLocale(task: string): OnboardingLocale {
    return /[\u4e00-\u9fff]/.test(task) ? "zh" : "en";
  }

  /**
   * ChatAssistant uses numeric chatId for history keying.
   * Convert peerId to a stable number hash.
   */
  private peerIdNum(envelope: InboundEnvelope): number {
    const raw = Number(envelope.peerId);
    if (Number.isFinite(raw) && Number.isSafeInteger(raw)) return raw;
    let hash = 0;
    for (let i = 0; i < envelope.peerId.length; i++) {
      hash = ((hash << 5) - hash + envelope.peerId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
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
    const oneLine = redacted.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxChars) return oneLine;
    return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private getChannelConfig(channelType: import("../channel/types.js").ChannelType):
    { dmPolicy?: DmPolicy; groupPolicy?: GroupPolicy; allowFrom?: string[]; allowGroups?: string[] } | undefined {
    const channels = this.config.channels;
    if (!channels) return undefined;
    switch (channelType) {
      case "telegram": return channels.telegram;
      case "discord": return channels.discord;
      case "whatsapp": return channels.whatsapp;
      case "imessage": return channels.imessage;
      default: return undefined;
    }
  }

  private resolveDmPolicy(channelType: import("../channel/types.js").ChannelType): DmPolicy {
    const cfg = this.getChannelConfig(channelType);
    if (cfg?.dmPolicy) return cfg.dmPolicy;
    if (this.config.channels?.defaults?.dmPolicy) return this.config.channels.defaults.dmPolicy;
    return "pairing";
  }

  private resolveGroupPolicy(channelType: import("../channel/types.js").ChannelType): GroupPolicy {
    const cfg = this.getChannelConfig(channelType);
    if (cfg?.groupPolicy) return cfg.groupPolicy;
    if (this.config.channels?.defaults?.groupPolicy) return this.config.channels.defaults.groupPolicy;
    return "open";
  }

  private resolveAllowFrom(channelType: import("../channel/types.js").ChannelType): string[] {
    let channelAllowFrom = this.getChannelConfig(channelType)?.allowFrom ?? [];

    if (channelType === "telegram" && channelAllowFrom.length === 0) {
      const legacyIds = this.config.telegram?.allowedChatIds;
      if (legacyIds && legacyIds.length > 0) {
        return legacyIds.map(String);
      }
    }

    if (channelType === "whatsapp") {
      channelAllowFrom = channelAllowFrom.map((id) =>
        id === "*" ? id : id.replace(/[^0-9]/g, ""),
      );
    }

    return channelAllowFrom;
  }

  private resolveAllowGroups(channelType: import("../channel/types.js").ChannelType): string[] {
    const cfg = this.getChannelConfig(channelType);
    const groups = (cfg as { allowGroups?: string[] } | undefined)?.allowGroups ?? [];
    if (channelType === "whatsapp") {
      return groups.map((g) => g.replace(/[^0-9]/g, ""));
    }
    return groups;
  }
}
