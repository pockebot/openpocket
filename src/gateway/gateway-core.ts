import fs from "node:fs";
import path from "node:path";

import type {
  AgentProgressUpdate,
  ChannelMediaDeliveryResult,
  ChannelMediaRequest,
  HumanAuthCapability,
  OpenPocketConfig,
  ScheduleIntent,
  StoredCronJob,
  TaskExecutionPlan,
  UserDecisionRequest,
  UserDecisionResponse,
  UserInputRequest,
  UserInputResponse,
} from "../types.js";
import type {
  ChannelAdapter,
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
import { readLatestTaskJournalSnapshot } from "../agent/journal/task-journal-store.js";
import { ChatAssistant } from "./chat-assistant.js";
import { CronRegistry } from "./cron-registry.js";
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

type PendingScheduleConfirmation = {
  intent: ScheduleIntent;
  createdAtMs: number;
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
  private readonly pendingScheduleConfirmations = new Map<string, PendingScheduleConfirmation>();
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
    if (await this.handlePendingScheduleConfirmation(envelope, text)) {
      return;
    }

    const chatId = this.peerIdNum(envelope);
    const decision = await this.chat.decide(chatId, text);
    this.log(
      `decision channel=${envelope.channelType} sender=${envelope.senderId} model=${this.config.defaultModel} mode=${decision.mode} confidence=${decision.confidence.toFixed(2)}`,
      "debug",
      "task",
    );

    if (decision.mode === "task") {
      const task = decision.task || text;
      this.chat.appendExternalTurn(chatId, "user", task);
      await this.enqueueTask(envelope, task, {
        acceptedAck: decision.taskAcceptedReply || "",
      });
      return;
    }

    if (decision.mode === "schedule_intent" && decision.scheduleIntent) {
      this.pendingScheduleConfirmations.set(this.scheduleConfirmationKey(envelope), {
        intent: decision.scheduleIntent,
        createdAtMs: Date.now(),
      });
      await this.router.replyText(envelope, this.sanitizeForChat(decision.reply, 1800));
      return;
    }

    const reply = decision.reply || (await this.chat.reply(chatId, text));
    await this.router.replyText(envelope, this.sanitizeForChat(reply, 1800));
  }

  private scheduleConfirmationKey(envelope: InboundEnvelope): string {
    return `${envelope.channelType}:${envelope.peerId}`;
  }

  private readScheduleConfirmationAction(text: string): "confirm" | "cancel" | null {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (["确认", "确认创建", "confirm", "yes", "y"].includes(normalized)) {
      return "confirm";
    }
    if (["取消", "cancel", "no", "n"].includes(normalized)) {
      return "cancel";
    }
    return null;
  }

  private slugifyScheduleTask(task: string): string {
    const slug = task
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    return slug || "scheduled-task";
  }

  private buildScheduledJobName(intent: ScheduleIntent, locale: OnboardingLocale): string {
    const base = intent.normalizedTask.trim();
    if (!base) {
      return locale === "zh" ? "定时任务" : "Scheduled task";
    }
    return base.slice(0, 80);
  }

  private createStructuredJobFromIntent(envelope: InboundEnvelope, intent: ScheduleIntent): string {
    const registry = new CronRegistry(this.config);
    const locale = this.inferLocale(envelope);
    const created = registry.add({
      id: `schedule-${Date.now()}-${this.slugifyScheduleTask(intent.normalizedTask)}`,
      name: this.buildScheduledJobName(intent, locale),
      enabled: true,
      schedule: intent.schedule,
      payload: {
        kind: "agent_turn",
        task: intent.normalizedTask,
      },
      delivery: {
        mode: "announce",
        channel: envelope.channelType,
        to: envelope.peerId,
      },
      model: null,
      promptMode: "minimal",
      createdBy: `${envelope.channelType}:${envelope.senderId}`,
      sourceChannel: envelope.channelType,
      sourcePeerId: envelope.peerId,
      runOnStartup: false,
    });
    return created.id;
  }

  private buildCronSetupTask(envelope: InboundEnvelope, intent: ScheduleIntent): string {
    return [
      "Create exactly one cron job from this confirmed schedule intent.",
      "Use cron_add once, then finish.",
      "Do not execute any phone actions.",
      "Confirmed intent JSON:",
      JSON.stringify({
        id: `schedule-${Date.now()}-${this.slugifyScheduleTask(intent.normalizedTask)}`,
        name: this.buildScheduledJobName(intent, this.inferLocale(envelope)),
        schedule: intent.schedule,
        task: intent.normalizedTask,
        channel: envelope.channelType,
        to: envelope.peerId,
        promptMode: "minimal",
        runOnStartup: false,
        createdBy: `${envelope.channelType}:${envelope.senderId}`,
        sourceChannel: envelope.channelType,
        sourcePeerId: envelope.peerId,
      }, null, 2),
    ].join("\n");
  }

  private async runCronSetupTask(envelope: InboundEnvelope, intent: ScheduleIntent): Promise<string | null> {
    const registry = new CronRegistry(this.config);
    const beforeIds = new Set(registry.list().map((job) => job.id));
    const task = this.buildCronSetupTask(envelope, intent);
    const result = await this.agent.runTask(
      task,
      undefined,
      undefined,
      undefined,
      "minimal",
      undefined,
      `cron-setup:${this.scheduleConfirmationKey(envelope)}`,
      undefined,
      undefined,
      null,
      ["cron_add", "finish"],
    );
    if (!result.ok) {
      throw new Error(result.message || "Cron setup run failed.");
    }
    const created = registry.list().find((job) =>
      !beforeIds.has(job.id)
      && job.payload.task === intent.normalizedTask
      && job.delivery?.to === envelope.peerId,
    );
    return created?.id ?? null;
  }

  private async handlePendingScheduleConfirmation(envelope: InboundEnvelope, text: string): Promise<boolean> {
    const key = this.scheduleConfirmationKey(envelope);
    const pending = this.pendingScheduleConfirmations.get(key);
    if (!pending) {
      return false;
    }
    if (Date.now() - pending.createdAtMs > 15 * 60 * 1000) {
      this.pendingScheduleConfirmations.delete(key);
      return false;
    }
    const action = this.readScheduleConfirmationAction(text);
    const locale = this.inferLocale(envelope);
    if (!action) {
      const reminder = locale === "zh"
        ? "你有一个待确认的定时任务。请先回复“确认”或“取消”。"
        : 'You have a pending scheduled job. Reply with "confirm" or "cancel" first.';
      await this.router.replyText(envelope, reminder);
      return true;
    }
    this.pendingScheduleConfirmations.delete(key);
    if (action === "cancel") {
      const cancelled = locale === "zh"
        ? "已取消这个待确认的定时任务。"
        : "Cancelled the pending scheduled job.";
      await this.router.replyText(envelope, cancelled);
      return true;
    }

    try {
      let jobId = await this.runCronSetupTask(envelope, pending.intent);
      if (!jobId) {
        jobId = this.createStructuredJobFromIntent(envelope, pending.intent);
      }
      const created = locale === "zh"
        ? `定时任务已创建：${jobId}`
        : `Scheduled job created: ${jobId}`;
      await this.router.replyText(envelope, created);
    } catch (error) {
      try {
        const jobId = this.createStructuredJobFromIntent(envelope, pending.intent);
        const fallback = locale === "zh"
          ? `定时任务已创建：${jobId}`
          : `Scheduled job created: ${jobId}`;
        await this.router.replyText(envelope, fallback);
      } catch (fallbackError) {
        const message = locale === "zh"
          ? `创建定时任务失败：${(fallbackError as Error).message}`
          : `Failed to create scheduled job: ${(fallbackError as Error).message}`;
        await this.router.replyText(envelope, message);
      }
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Task execution
  // -----------------------------------------------------------------------

  private async enqueueTask(
    envelope: InboundEnvelope,
    task: string,
    options?: {
      sessionKey?: string;
      onDone?: (result: CronRunResult) => void | Promise<void>;
      skipAck?: boolean;
      acceptedAck?: string;
    },
  ): Promise<void> {
    const locale = this.inferTaskLocale(task);
    const isIdle = !this.drainingTaskQueue && !this.agent.isBusy() && this.pendingTasks.length === 0;
    const position = this.pendingTasks.length + 1;

    if (!options?.skipAck) {
      const providedAck = String(options?.acceptedAck ?? "").trim();
      const ack = isIdle
        ? (providedAck || await this.resolveTaskAcceptedAck(task, locale))
        : (locale === "zh"
          ? `当前有任务在执行。你的新任务已加入队列（第 ${position} 位）。`
          : `A previous task is still running. Your new task is queued (position ${position}).`);
      const sanitizedAck = this.sanitizeForChat(ack, 1800);
      await this.router.replyText(envelope, sanitizedAck);
      this.chat.appendExternalTurn(this.peerIdNum(envelope), "assistant", sanitizedAck);
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
    const taskExecutionPlan: TaskExecutionPlan | null = await this.planTaskExecutionSafe(task);
    if (taskExecutionPlan) {
      this.log(
        `task execution plan channel=${envelope.channelType} sender=${envelope.senderId} surface=${taskExecutionPlan.surface}` +
        ` confidence=${taskExecutionPlan.confidence.toFixed(2)} reason=${JSON.stringify(taskExecutionPlan.reason)}`,
        "info",
        "task",
      );
    }
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
          const isFirstProgress =
            narrationState.lastNotifiedProgress === null && progress.step === 1;

          const action = String(progress.actionType || "").toLowerCase();
          const isHighSignal =
            progress.step === 1 || action === "finish" || action === "request_human_auth"
            || action === "request_user_input"
            || /(error|failed|timeout|interrupted|rejected)/i.test(`${progress.message} ${progress.thought}`);
          const isIntervalStep = narrationState.skippedSteps >= GatewayCore.NARRATION_LLM_INTERVAL;
          const useLlm = isHighSignal || isIntervalStep;

          let decision = useLlm
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

          // Keep model-first behavior, but guarantee users see task start.
          if (isFirstProgress && (!decision.notify || !String(decision.message || "").trim())) {
            decision = this.chat.fallbackTaskProgressNarration({
              task, locale, progress, recentProgress,
              lastNotifiedProgress: narrationState.lastNotifiedProgress,
              skippedSteps: narrationState.skippedSteps,
            });
          }

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
        adapter
          ? async (request) => this.deliverChannelMedia(envelope, request, adapter)
          : undefined,
        taskExecutionPlan,
      );
      await progressWork;

      this.log(`task done channel=${envelope.channelType} model=${this.config.defaultModel} ok=${result.ok} session=${result.sessionPath}`, "info", "task");

      const evidenceSnapshot = readLatestTaskJournalSnapshot(result.sessionPath);
      const finalMessage = await this.chat.narrateTaskOutcome({
        task, locale, ok: result.ok, rawResult: result.message,
        recentProgress: narrationState.allProgress,
        evidenceSnapshot,
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

  private async planTaskExecutionSafe(task: string): Promise<TaskExecutionPlan | null> {
    const planner = this.chat as unknown as {
      planTaskExecution?: (value: string) => Promise<TaskExecutionPlan | null>;
    };
    if (typeof planner.planTaskExecution !== "function") {
      return null;
    }
    try {
      return await planner.planTaskExecution(task);
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Cron
  // -----------------------------------------------------------------------

  private async runScheduledJob(job: StoredCronJob): Promise<CronRunResult> {
    if (this.agent.isBusy()) {
      return { accepted: false, ok: false, message: "Agent is busy." };
    }

    const adapters = this.router.getAllAdapters();
    const preferredAdapter = job.delivery?.channel
      ? this.router.getAdapter(job.delivery.channel as import("../channel/types.js").ChannelType)
      : null;
    const adapter = preferredAdapter ?? adapters[0];
    if (!adapter) {
      return { accepted: false, ok: false, message: "No channel adapter available." };
    }

    const envelope: InboundEnvelope = {
      channelType: adapter.channelType,
      senderId: "cron",
      senderName: "Cron",
      senderLanguageCode: null,
      peerId: job.delivery?.to ? String(job.delivery.to) : "cron",
      peerKind: "dm",
      text: job.payload.task,
      attachments: [],
      rawEvent: job,
      receivedAt: new Date().toISOString(),
    };

    if (job.delivery?.to) {
      await this.router.replyText(envelope, `Scheduled task started (${job.name}): ${job.payload.task}`);
    }

    return this.runTaskAndReport(envelope, job.payload.task, `cron:${job.id}`);
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

  private async resolveTaskAcceptedAck(task: string, locale: OnboardingLocale): Promise<string> {
    const fallback = this.chat.taskAcceptedFallbackReply(
      this.previewPayload(task, 160),
      locale,
    );

    const timeoutMs = 1200;
    const timeoutPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve(fallback), timeoutMs);
    });

    try {
      const ack = await Promise.race([
        this.chat.taskAcceptedReply(task, locale),
        timeoutPromise,
      ]);
      const sanitized = this.sanitizeForChat(ack, 1800);
      return sanitized || fallback;
    } catch {
      return fallback;
    }
  }

  private async deliverChannelMedia(
    envelope: InboundEnvelope,
    request: ChannelMediaRequest,
    adapter: ChannelAdapter,
  ): Promise<ChannelMediaDeliveryResult> {
    const rawPath = String(request.path || "").trim();
    if (!rawPath) {
      return { ok: false, mediaType: null, message: "send_media path is empty." };
    }

    const capabilities = adapter.getCapabilities();
    let localPath = "";
    let cleanupPath: string | null = null;
    try {
      if (this.isAndroidDevicePath(rawPath)) {
        const deviceId = this.resolveOnlineDeviceId();
        if (!deviceId) {
          return { ok: false, mediaType: null, message: "No online Android device available to pull media." };
        }
        const outDir = path.join(this.config.stateDir, "outbound-media");
        fs.mkdirSync(outDir, { recursive: true });
        const safeBase = (path.basename(rawPath) || `artifact-${Date.now()}`)
          .replace(/[^a-zA-Z0-9._-]+/g, "_");
        localPath = path.join(outDir, `${Date.now()}-step-${request.step}-${safeBase}`);
        this.emulator.runAdb(["-s", deviceId, "pull", rawPath, localPath], 30_000);
        cleanupPath = localPath;
      } else {
        localPath = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(this.config.workspaceDir, rawPath);
      }

      if (!fs.existsSync(localPath)) {
        return { ok: false, mediaType: null, message: `Media file not found: ${localPath}` };
      }

      const mediaType = this.resolveChannelMediaType(request.mediaType, localPath);
      const caption = request.caption?.trim() || undefined;

      if (mediaType === "image") {
        if (capabilities.supportsImageUpload) {
          await this.router.replyImage(envelope, localPath, caption);
          return { ok: true, mediaType, message: `Image sent from ${rawPath}` };
        }
        if (capabilities.supportsFileUpload) {
          await this.router.replyFile(envelope, localPath, caption);
          return { ok: true, mediaType: "file", message: `Image sent as file from ${rawPath}` };
        }
        return { ok: false, mediaType: null, message: `Channel ${adapter.channelType} does not support image/file upload.` };
      }

      if (mediaType === "voice") {
        if (capabilities.supportsVoiceUpload) {
          await this.router.replyVoice(envelope, localPath, caption);
          return { ok: true, mediaType, message: `Voice sent from ${rawPath}` };
        }
        if (capabilities.supportsFileUpload) {
          await this.router.replyFile(envelope, localPath, caption);
          return { ok: true, mediaType: "file", message: `Voice sent as file from ${rawPath}` };
        }
        return { ok: false, mediaType: null, message: `Channel ${adapter.channelType} does not support voice/file upload.` };
      }

      if (capabilities.supportsFileUpload) {
        await this.router.replyFile(envelope, localPath, caption);
        return { ok: true, mediaType: "file", message: `File sent from ${rawPath}` };
      }

      if (capabilities.supportsImageUpload) {
        await this.router.replyImage(envelope, localPath, caption);
        return { ok: true, mediaType: "image", message: `File sent as image from ${rawPath}` };
      }

      return { ok: false, mediaType: null, message: `Channel ${adapter.channelType} cannot upload media.` };
    } catch (error) {
      return { ok: false, mediaType: null, message: `send_media failed: ${(error as Error).message}` };
    } finally {
      if (cleanupPath) {
        try {
          fs.unlinkSync(cleanupPath);
        } catch {
          // Ignore temp cleanup failure.
        }
      }
    }
  }

  private isAndroidDevicePath(value: string): boolean {
    const normalized = String(value || "").trim();
    return /^\/(?:sdcard|storage\/emulated\/0)\//i.test(normalized);
  }

  private resolveOnlineDeviceId(): string | null {
    try {
      const status = this.emulator.status();
      const online = status.devices;
      if (online.length === 0) {
        return null;
      }
      const preferred = this.config.agent.deviceId?.trim() || "";
      if (preferred && online.includes(preferred)) {
        return preferred;
      }
      if (status.bootedDevices.length > 0) {
        return status.bootedDevices[0];
      }
      return online[0] ?? null;
    } catch {
      return null;
    }
  }

  private resolveChannelMediaType(
    preferred: ChannelMediaRequest["mediaType"] | undefined,
    filePath: string,
  ): "image" | "file" | "voice" {
    if (preferred === "image" || preferred === "file" || preferred === "voice") {
      return preferred;
    }
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".heif"]);
    const voiceExts = new Set([".mp3", ".m4a", ".wav", ".ogg", ".opus", ".aac", ".flac", ".amr", ".3gp"]);
    if (imageExts.has(ext)) {
      return "image";
    }
    if (voiceExts.has(ext)) {
      return "voice";
    }
    return "file";
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
