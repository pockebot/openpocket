import TelegramBot, { type Message } from "node-telegram-bot-api";
import fs from "node:fs";
import path from "node:path";

import type { OpenPocketConfig, UserDecisionRequest, UserDecisionResponse, UserInputRequest, UserInputResponse } from "../../types.js";
import type { ChannelAdapter, ChannelCapabilities, InboundEnvelope, InboundHandler, SendOptions, TelegramChannelConfig } from "../types.js";
import { getDefaultCapabilities } from "../capabilities.js";
import { ChatAssistant } from "../../gateway/chat-assistant.js";

// ---------------------------------------------------------------------------
// Menu commands for Telegram
// ---------------------------------------------------------------------------

export const TELEGRAM_MENU_COMMANDS: TelegramBot.BotCommand[] = [
  { command: "start", description: "Start or resume chat onboarding" },
  { command: "help", description: "Show command help" },
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
  { command: "cronrun", description: "Trigger existing cron job by id" },
  { command: "auth", description: "Human auth helper commands" },
  { command: "run", description: "Force immediate task mode" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramAdapterOptions {
  logger?: (line: string) => void;
  typingIntervalMs?: number;
}

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

type BotDisplayNameSyncState = {
  lastSyncedName?: string;
  retryAfterUntilMs?: number;
};

// ---------------------------------------------------------------------------
// TelegramAdapter
// ---------------------------------------------------------------------------

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = "telegram" as const;

  private readonly config: OpenPocketConfig;
  private readonly tgConfig: TelegramChannelConfig;
  private readonly bot: TelegramBot;
  private readonly writeLogLine: (line: string) => void;
  private readonly typingIntervalMs: number;

  private readonly typingSessions = new Map<number, { refs: number; timer: NodeJS.Timeout }>();
  private readonly pendingUserDecisions = new Map<number, PendingUserDecision>();
  private readonly pendingUserInputs = new Map<number, PendingUserInput>();

  private inboundHandler: InboundHandler | null = null;
  private running = false;

  private lastSyncedBotDisplayName: string | null = null;
  private readonly botDisplayNameSyncStatePath: string;
  private botDisplayNameRateLimitedUntilMs = 0;

  constructor(config: OpenPocketConfig, tgConfig: TelegramChannelConfig, options?: TelegramAdapterOptions) {
    this.config = config;
    this.tgConfig = tgConfig;
    this.writeLogLine = options?.logger ?? ((line: string) => { console.log(line); });
    this.typingIntervalMs = Math.max(50, Math.round(options?.typingIntervalMs ?? 4000));

    const envName = tgConfig.botTokenEnv || "TELEGRAM_BOT_TOKEN";
    const token =
      (tgConfig.botToken ?? "").trim() ||
      (process.env[envName]?.trim()) ||
      "";

    if (!token) {
      throw new Error(
        `Telegram bot token is empty. Set channels.telegram.botToken in config or env ${envName}.`,
      );
    }

    this.bot = new TelegramBot(token, {
      polling: {
        autoStart: false,
        interval: 1000,
        params: { timeout: tgConfig.pollTimeoutSec ?? 25 },
      },
    });

    this.botDisplayNameSyncStatePath = path.join(config.stateDir, "telegram-bot-name-sync.json");
    this.restoreBotDisplayNameSyncState();
  }

  // -----------------------------------------------------------------------
  // ChannelAdapter lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.bot.on("message", this.handleTelegramMessage);
    this.bot.on("polling_error", this.handlePollingError);
    await this.configureBotCommandMenu();
    await this.syncBotDisplayNameFromIdentity();
    await this.bot.startPolling({
      restart: true,
      polling: {
        autoStart: false,
        interval: 1000,
        params: { timeout: this.tgConfig.pollTimeoutSec ?? 25 },
      },
    });
    this.log("telegram adapter started (polling)");
  }

  async stop(reason?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.bot.removeListener("message", this.handleTelegramMessage);
    this.bot.removeListener("polling_error", this.handlePollingError);
    this.clearTypingSessions();
    try { await this.bot.stopPolling(); } catch { /* ignore */ }
    this.log(`telegram adapter stopped reason=${reason ?? "unknown"}`);
  }

  // -----------------------------------------------------------------------
  // Outbound messaging
  // -----------------------------------------------------------------------

  async sendText(peerId: string, text: string, opts?: SendOptions): Promise<void> {
    const chatId = Number(peerId);
    const telegramOpts: TelegramBot.SendMessageOptions = {};
    if (opts?.format === "html") telegramOpts.parse_mode = "HTML";
    else if (opts?.format === "markdown") telegramOpts.parse_mode = "Markdown";
    if (opts?.disableLinkPreview) telegramOpts.disable_web_page_preview = true;
    if (opts?.replyMarkup) telegramOpts.reply_markup = opts.replyMarkup as TelegramBot.SendMessageOptions["reply_markup"];
    await this.bot.sendMessage(chatId, text, telegramOpts);
  }

  async sendImage(peerId: string, imagePath: string, caption?: string): Promise<void> {
    const chatId = Number(peerId);
    await this.bot.sendPhoto(chatId, imagePath, { caption });
  }

  async sendFile(peerId: string, filePath: string, caption?: string): Promise<void> {
    const chatId = Number(peerId);
    await this.bot.sendDocument(chatId, filePath, caption ? { caption } : undefined);
  }

  async sendVoice(peerId: string, voicePath: string, caption?: string): Promise<void> {
    const chatId = Number(peerId);
    await this.bot.sendVoice(chatId, voicePath, caption ? { caption } : undefined);
  }

  // -----------------------------------------------------------------------
  // Inbound
  // -----------------------------------------------------------------------

  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler;
  }

  // -----------------------------------------------------------------------
  // Typing indicator
  // -----------------------------------------------------------------------

  async setTypingIndicator(peerId: string, active: boolean): Promise<void> {
    const chatId = Number(peerId);
    if (active) {
      this.beginTypingStatus(chatId);
    } else {
      this.endTypingStatus(chatId);
    }
  }

  private beginTypingStatus(chatId: number): void {
    const existing = this.typingSessions.get(chatId);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const timer = setInterval(() => { void this.sendTypingAction(chatId); }, this.typingIntervalMs);
    timer.unref?.();
    this.typingSessions.set(chatId, { refs: 1, timer });
    void this.sendTypingAction(chatId);
  }

  private endTypingStatus(chatId: number): void {
    const session = this.typingSessions.get(chatId);
    if (!session) return;
    session.refs -= 1;
    if (session.refs <= 0) {
      clearInterval(session.timer);
      this.typingSessions.delete(chatId);
    }
  }

  private async sendTypingAction(chatId: number): Promise<void> {
    try { await this.bot.sendChatAction(chatId, "typing"); } catch { /* ignore */ }
  }

  private clearTypingSessions(): void {
    for (const session of this.typingSessions.values()) clearInterval(session.timer);
    this.typingSessions.clear();
  }

  // -----------------------------------------------------------------------
  // User decision / input
  // -----------------------------------------------------------------------

  async requestUserDecision(peerId: string, request: UserDecisionRequest): Promise<UserDecisionResponse> {
    const chatId = Number(peerId);
    return new Promise<UserDecisionResponse>((resolve, reject) => {
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

      this.pendingUserDecisions.set(chatId, { request, resolve, reject, timeout });

      const locale = this.inferTaskLocale(`${request.question}\n${(request.options || []).join(" ")}`);
      const optionsTitle = "Options:";
      const replyHint = "Reply with option number or text.";
      const optionsList = request.options.length > 0
        ? request.options.map((item, index) => `${index + 1}. ${item}`).join("\n")
        : "(no options provided)";
      const prompt = [request.question, "", optionsTitle, optionsList, "", replyHint].join("\n");
      void this.bot.sendMessage(chatId, prompt.slice(0, 1800));
    });
  }

  async requestUserInput(peerId: string, request: UserInputRequest): Promise<UserInputResponse> {
    const chatId = Number(peerId);
    return new Promise<UserInputResponse>((resolve, reject) => {
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

      this.pendingUserInputs.set(chatId, { request, resolve, reject, timeout });

      const locale = this.inferTaskLocale(`${request.question}\n${request.placeholder ?? ""}`);
      const questionTitle = "Requested value:";
      const placeholderLine = request.placeholder
        ? `Format hint: ${request.placeholder}`
        : "";
      const replyHint = "Reply with the text value.";
      const prompt = [questionTitle, request.question, placeholderLine, "", replyHint].filter(Boolean).join("\n");
      void this.bot.sendMessage(chatId, prompt.slice(0, 1800));
    });
  }

  // -----------------------------------------------------------------------
  // Human auth escalation
  // -----------------------------------------------------------------------

  async sendHumanAuthEscalation(peerId: string, htmlBody: string, openUrl?: string): Promise<void> {
    const chatId = Number(peerId);
    const opts: TelegramBot.SendMessageOptions = { parse_mode: "HTML" };
    if (openUrl) {
      opts.reply_markup = {
        inline_keyboard: [[{ text: "Open Human Auth", url: openUrl }]],
      };
    }
    await this.bot.sendMessage(chatId, htmlBody, opts);
  }

  // -----------------------------------------------------------------------
  // Platform identity
  // -----------------------------------------------------------------------

  async resolveDisplayName(peerId: string): Promise<string | null> {
    try {
      const chatId = Number(peerId);
      const chat = await this.bot.getChat(chatId);
      return chat.first_name ?? chat.username ?? null;
    } catch {
      return null;
    }
  }

  getCapabilities(): ChannelCapabilities {
    return getDefaultCapabilities("telegram");
  }

  // -----------------------------------------------------------------------
  // Access control
  // -----------------------------------------------------------------------

  isAllowed(_senderId: string): boolean {
    return true;
  }

  // -----------------------------------------------------------------------
  // Internal: Telegram message → InboundEnvelope
  // -----------------------------------------------------------------------

  private readonly handleTelegramMessage = async (message: Message): Promise<void> => {
    const chatId = message.chat.id;
    try {
      const text = message.text?.trim() ?? "";

      if (this.tryResolveInteractivePending(chatId, text)) return;

      const envelope = this.telegramMessageToEnvelope(message);
      if (this.inboundHandler) {
        await this.inboundHandler(envelope);
      }
    } catch (error) {
      this.log(`handler error chat=${chatId} error=${(error as Error).message}`);
      try { await this.bot.sendMessage(chatId, `OpenPocket error: ${(error as Error).message}`); } catch { /* ignore */ }
    }
  };

  private tryResolveInteractivePending(chatId: number, text: string): boolean {
    if (text.startsWith("/")) return false;
    if (!text) return false;

    const pendingInput = this.pendingUserInputs.get(chatId);
    if (pendingInput) {
      clearTimeout(pendingInput.timeout);
      this.pendingUserInputs.delete(chatId);
      pendingInput.resolve({ text, resolvedAt: new Date().toISOString() });
      void this.bot.sendMessage(chatId, "Got it. Continuing.");
      return true;
    }

    const pendingDecision = this.pendingUserDecisions.get(chatId);
    if (pendingDecision) {
      const options = pendingDecision.request.options || [];
      let selected = text;
      const numeric = text.match(/^\d+$/);
      if (numeric) {
        const idx = Number(numeric[0]) - 1;
        if (idx >= 0 && idx < options.length) selected = options[idx];
      } else {
        const exact = options.find((opt) => opt.toLowerCase() === text.toLowerCase());
        if (exact) selected = exact;
      }
      clearTimeout(pendingDecision.timeout);
      this.pendingUserDecisions.delete(chatId);
      pendingDecision.resolve({ selectedOption: selected, rawInput: text, resolvedAt: new Date().toISOString() });
      const matchedOption = options.find((opt) => opt.trim().toLowerCase() === selected.trim().toLowerCase());
      void this.bot.sendMessage(chatId, matchedOption ? `Got it: "${matchedOption}". Continuing.` : "Got it. Continuing.");
      return true;
    }

    return false;
  }

  private telegramMessageToEnvelope(message: Message): InboundEnvelope {
    const text = message.text?.trim() ?? "";
    const chatId = message.chat.id;
    const senderId = String(message.from?.id ?? chatId);
    const senderName = message.from
      ? [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || null
      : null;

    let command: string | undefined;
    let commandArgs: string | undefined;
    const cmdMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      command = cmdMatch[1].toLowerCase();
      commandArgs = (cmdMatch[2] ?? "").trim();
    }

    const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
    const peerKind = isGroup
      ? (message.message_thread_id ? "thread" : "group")
      : "dm";

    return {
      channelType: "telegram",
      senderId,
      senderName,
      senderLanguageCode: message.from?.language_code ?? null,
      peerId: String(chatId),
      peerKind: peerKind as "dm" | "group" | "thread",
      threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
      text,
      command,
      commandArgs,
      attachments: this.extractAttachments(message),
      replyTo: message.reply_to_message
        ? {
          messageId: String(message.reply_to_message.message_id),
          senderId: String(message.reply_to_message.from?.id ?? ""),
          body: message.reply_to_message.text ?? "",
        }
        : undefined,
      rawEvent: message,
      receivedAt: new Date().toISOString(),
    };
  }

  private extractAttachments(message: Message): InboundEnvelope["attachments"] {
    const attachments: InboundEnvelope["attachments"] = [];
    if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      attachments.push({
        type: "photo",
        url: largest.file_id,
        sizeBytes: largest.file_size,
      });
    }
    if (message.document) {
      attachments.push({
        type: "document",
        url: message.document.file_id,
        mimeType: message.document.mime_type,
        fileName: message.document.file_name,
        sizeBytes: message.document.file_size,
      });
    }
    if (message.video) {
      attachments.push({
        type: "video",
        url: message.video.file_id,
        mimeType: message.video.mime_type,
        sizeBytes: message.video.file_size,
      });
    }
    if (message.audio) {
      attachments.push({
        type: "audio",
        url: message.audio.file_id,
        mimeType: message.audio.mime_type,
        sizeBytes: message.audio.file_size,
      });
    }
    if (message.sticker) {
      attachments.push({
        type: "sticker",
        url: message.sticker.file_id,
      });
    }
    return attachments;
  }

  // -----------------------------------------------------------------------
  // Bot display name sync (Telegram specific)
  // -----------------------------------------------------------------------

  private normalizeBotDisplayName(input: string): string {
    const normalized = input.replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, 64) : "";
  }

  private restoreBotDisplayNameSyncState(): void {
    if (!fs.existsSync(this.botDisplayNameSyncStatePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.botDisplayNameSyncStatePath, "utf-8")) as BotDisplayNameSyncState;
      const cachedName = parsed?.lastSyncedName ? this.normalizeBotDisplayName(parsed.lastSyncedName) : "";
      if (cachedName) this.lastSyncedBotDisplayName = cachedName;
      const retryAfterUntilMs = parsed?.retryAfterUntilMs ?? 0;
      if (Number.isFinite(retryAfterUntilMs) && retryAfterUntilMs > Date.now()) {
        this.botDisplayNameRateLimitedUntilMs = Math.trunc(retryAfterUntilMs);
      }
    } catch { /* ignore corrupt state */ }
  }

  private persistBotDisplayNameSyncState(): void {
    const payload: BotDisplayNameSyncState = {};
    if (this.lastSyncedBotDisplayName) payload.lastSyncedName = this.lastSyncedBotDisplayName;
    if (this.botDisplayNameRateLimitedUntilMs > Date.now()) payload.retryAfterUntilMs = this.botDisplayNameRateLimitedUntilMs;
    try {
      if (!payload.lastSyncedName && !payload.retryAfterUntilMs) {
        if (fs.existsSync(this.botDisplayNameSyncStatePath)) fs.unlinkSync(this.botDisplayNameSyncStatePath);
        return;
      }
      fs.writeFileSync(this.botDisplayNameSyncStatePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    } catch { /* ignore */ }
  }

  private readAssistantNameFromIdentity(): string {
    const identityPath = path.join(this.config.workspaceDir, "IDENTITY.md");
    if (!fs.existsSync(identityPath)) return "";
    try {
      const raw = fs.readFileSync(identityPath, "utf-8");
      const sectionMatch = raw.match(/##\s*Agent\s+Identity\b[\s\S]*?(?=\n##\s|\n#\s|$)/i);
      const section = sectionMatch ? sectionMatch[0] : raw;
      const match = section.match(/^\s*-\s*Name\s*:\s*(.+)$/im);
      return match?.[1] ? this.normalizeBotDisplayName(match[1]) : "";
    } catch { return ""; }
  }

  private async syncBotDisplayNameFromIdentity(): Promise<void> {
    const assistantName = this.readAssistantNameFromIdentity();
    if (!assistantName || assistantName === this.lastSyncedBotDisplayName) return;
    if (this.botDisplayNameRateLimitedUntilMs > Date.now()) {
      this.log(`telegram bot display name startup-sync skipped: rate-limited`);
      return;
    }
    try {
      await this.bot.setMyName({ name: assistantName });
      this.lastSyncedBotDisplayName = assistantName;
      this.botDisplayNameRateLimitedUntilMs = 0;
      this.persistBotDisplayNameSyncState();
      this.log(`telegram bot display name synced name=${JSON.stringify(assistantName)}`);
    } catch (error) {
      const retry = this.parseTelegramRetryAfterSec(error);
      if (retry > 0) {
        this.botDisplayNameRateLimitedUntilMs = Date.now() + retry * 1000;
        this.persistBotDisplayNameSyncState();
      }
      this.log(`telegram bot display name sync failed: ${(error as Error).message}`);
    }
  }

  private parseTelegramRetryAfterSec(error: unknown): number {
    const typed = error as { response?: { body?: { parameters?: { retry_after?: unknown } } } };
    const structured = typed.response?.body?.parameters?.retry_after;
    if (typeof structured === "number" && Number.isFinite(structured) && structured > 0) return Math.ceil(structured);
    const message = String((error as Error)?.message ?? "");
    const match = message.match(/retry after\s+(\d+)/i);
    if (!match) return 0;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 0;
  }

  // -----------------------------------------------------------------------
  // Bot command menu
  // -----------------------------------------------------------------------

  private async configureBotCommandMenu(): Promise<void> {
    try {
      await this.bot.setMyCommands(TELEGRAM_MENU_COMMANDS);
      await this.bot.setChatMenuButton({ menu_button: { type: "commands" } });
      this.log(`telegram command menu configured commands=${TELEGRAM_MENU_COMMANDS.length}`);
    } catch (error) {
      this.log(`telegram command menu setup failed: ${(error as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Polling error
  // -----------------------------------------------------------------------

  private readonly handlePollingError = (error: Error): void => {
    this.log(`polling error: ${error.message}`);
  };

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private log(message: string): void {
    this.writeLogLine(`[OpenPocket][telegram-adapter] ${new Date().toISOString()} ${message}`);
  }

  private inferTaskLocale(text: string): "zh" | "en" {
    return /[一-鿿]/u.test(text) ? "zh" : "en";
  }
}
