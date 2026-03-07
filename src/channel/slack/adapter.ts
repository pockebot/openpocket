import { App, type SlackEventMiddlewareArgs, type AllMiddlewareArgs } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import fs from "node:fs";

import type {
  OpenPocketConfig,
  UserDecisionRequest,
  UserDecisionResponse,
  UserInputRequest,
  UserInputResponse,
} from "../../types.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundEnvelope,
  InboundHandler,
  SendOptions,
  SlackChannelConfig,
} from "../types.js";
import { getDefaultCapabilities } from "../capabilities.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackAdapterOptions {
  logger?: (line: string) => void;
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

// ---------------------------------------------------------------------------
// SlackAdapter
// ---------------------------------------------------------------------------

export class SlackAdapter implements ChannelAdapter {
  readonly channelType = "slack" as const;

  private readonly config: OpenPocketConfig;
  private readonly slackConfig: SlackChannelConfig;
  private readonly writeLogLine: (line: string) => void;

  private app: App | null = null;
  private webClient: WebClient | null = null;
  private botUserId: string | null = null;

  private readonly pendingUserDecisions = new Map<string, PendingUserDecision>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();

  private inboundHandler: InboundHandler | null = null;
  private running = false;

  constructor(config: OpenPocketConfig, slackConfig: SlackChannelConfig, options?: SlackAdapterOptions) {
    this.config = config;
    this.slackConfig = slackConfig;
    this.writeLogLine = options?.logger ?? ((line: string) => { console.log(line); });
  }

  // -----------------------------------------------------------------------
  // ChannelAdapter lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const botToken = this.resolveBotToken();
    if (!botToken) {
      throw new Error(
        "Slack bot token is empty. Set channels.slack.botToken, env SLACK_BOT_TOKEN, or channels.slack.botTokenEnv.",
      );
    }

    const appToken = this.resolveAppToken();
    if (!appToken) {
      throw new Error(
        "Slack app-level token is empty. Set channels.slack.appToken, env SLACK_APP_TOKEN, or channels.slack.appTokenEnv.",
      );
    }

    const proxyAgent = await this.resolveProxyAgent();

    const appOptions: Record<string, unknown> = {
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: undefined,
      clientOptions: {
        slackApiUrl: "https://slack.com/api/",
        clientPingTimeout: 30_000,
        serverPingTimeout: 30_000,
      },
    };
    if (proxyAgent) {
      appOptions.agent = proxyAgent;
    }

    this.app = new App(appOptions as ConstructorParameters<typeof App>[0]);

    this.webClient = this.app.client;

    const authResult = await this.webClient.auth.test();
    this.botUserId = authResult.user_id as string;
    this.log(`authenticated as bot user=${this.botUserId}`);

    this.registerEventHandlers();

    await this.app.start();
    this.log("slack adapter started (socket mode)");
  }

  async stop(reason?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.clearPending();

    if (this.app) {
      try { await this.app.stop(); } catch { /* ignore */ }
      this.app = null;
    }
    this.webClient = null;
    this.botUserId = null;

    this.log(`slack adapter stopped reason=${reason ?? "unknown"}`);
  }

  // -----------------------------------------------------------------------
  // Event registration
  // -----------------------------------------------------------------------

  private registerEventHandlers(): void {
    if (!this.app) return;

    this.app.message(async (args) => {
      await this.handleMessage(args as SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs);
    });

    this.app.event("app_mention", async (args) => {
      await this.handleAppMention(args as SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs);
    });

    if (this.slackConfig.slashCommands !== false) {
      for (const cmd of ["/status", "/help", "/model", "/skills", "/clear", "/new", "/stop", "/screen"]) {
        this.app.command(cmd, async ({ command, ack }) => {
          await ack();
          await this.handleSlashCommand(command.command.replace("/", ""), command.text, command.user_id, command.channel_id);
        });
      }
    }

    this.app.action(/^openpocket_decision_\d+$/, async ({ action, ack, body }) => {
      await ack();
      if (action.type !== "button") return;
      const userId = body.user.id;
      const pending = this.pendingUserDecisions.get(userId);
      if (!pending) return;

      const actionId = "action_id" in action ? (action as { action_id: string }).action_id : "";
      const index = parseInt(actionId.replace("openpocket_decision_", ""), 10);
      const options = pending.request.options ?? [];
      const selected = (index >= 0 && index < options.length) ? options[index] : `option_${index}`;

      clearTimeout(pending.timeout);
      this.pendingUserDecisions.delete(userId);
      pending.resolve({
        selectedOption: selected,
        rawInput: selected,
        resolvedAt: new Date().toISOString(),
      });
    });
  }

  // -----------------------------------------------------------------------
  // Outbound messaging
  // -----------------------------------------------------------------------

  async sendText(peerId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!this.webClient) return;

    const maxLen = 4000;
    const chunks = this.chunkText(text, maxLen);
    for (const chunk of chunks) {
      await this.webClient.chat.postMessage({
        channel: peerId,
        text: chunk,
      });
    }
  }

  async sendImage(peerId: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.webClient) return;

    if (!fs.existsSync(imagePath)) {
      this.log(`sendImage: file not found path=${imagePath}`);
      if (caption) await this.sendText(peerId, caption);
      return;
    }

    await this.webClient.filesUploadV2({
      channel_id: peerId,
      file: fs.createReadStream(imagePath),
      filename: imagePath.split("/").pop() ?? "image.png",
      initial_comment: caption ?? undefined,
    });
  }

  async sendFile(peerId: string, filePath: string, caption?: string): Promise<void> {
    if (!this.webClient) return;

    if (!fs.existsSync(filePath)) {
      this.log(`sendFile: file not found path=${filePath}`);
      if (caption) await this.sendText(peerId, caption);
      return;
    }

    await this.webClient.filesUploadV2({
      channel_id: peerId,
      file: fs.createReadStream(filePath),
      filename: filePath.split("/").pop() ?? "file",
      initial_comment: caption ?? undefined,
    });
  }

  async sendVoice(peerId: string, voicePath: string, caption?: string): Promise<void> {
    await this.sendFile(peerId, voicePath, caption);
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

  async setTypingIndicator(_peerId: string, _active: boolean): Promise<void> {
    // Slack doesn't have a public API for persistent typing indicators
    // in bot context. No-op.
  }

  // -----------------------------------------------------------------------
  // User decision / input
  // -----------------------------------------------------------------------

  async requestUserDecision(peerId: string, request: UserDecisionRequest): Promise<UserDecisionResponse> {
    if (!this.webClient) throw new Error("Slack client not ready for user decision.");

    return new Promise<UserDecisionResponse>((resolve, reject) => {
      this.clearExistingDecision(peerId);

      const timeout = setTimeout(() => {
        this.pendingUserDecisions.delete(peerId);
        reject(new Error("User decision timed out."));
      }, Math.max(15_000, request.timeoutSec * 1000));

      this.pendingUserDecisions.set(peerId, { request, resolve, reject, timeout });

      const options = request.options ?? [];
      if (options.length > 0 && options.length <= 5) {
        const buttons = options.map((opt, i) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: opt.slice(0, 75) },
          action_id: `openpocket_decision_${i}`,
        }));

        void this.webClient!.chat.postMessage({
          channel: peerId,
          text: request.question,
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: request.question.slice(0, 3000) },
            },
            {
              type: "actions",
              elements: buttons,
            },
          ],
        });
      } else {
        const optionsList = options.length > 0
          ? options.map((item, index) => `${index + 1}. ${item}`).join("\n")
          : "(no options provided)";
        const prompt = [request.question, "", "Options:", optionsList, "", "Reply with option number or text."].join("\n");
        void this.webClient!.chat.postMessage({
          channel: peerId,
          text: prompt,
        });
      }
    });
  }

  async requestUserInput(peerId: string, request: UserInputRequest): Promise<UserInputResponse> {
    if (!this.webClient) throw new Error("Slack client not ready for user input.");

    return new Promise<UserInputResponse>((resolve, reject) => {
      this.clearExistingInput(peerId);

      const timeout = setTimeout(() => {
        this.pendingUserInputs.delete(peerId);
        reject(new Error("User input timed out."));
      }, Math.max(15_000, request.timeoutSec * 1000));

      this.pendingUserInputs.set(peerId, { request, resolve, reject, timeout });

      const placeholderLine = request.placeholder ? `Format hint: ${request.placeholder}` : "";
      const prompt = ["Requested value:", request.question, placeholderLine, "", "Reply with the text value."]
        .filter(Boolean)
        .join("\n");
      void this.webClient!.chat.postMessage({
        channel: peerId,
        text: prompt,
      });
    });
  }

  // -----------------------------------------------------------------------
  // Human auth escalation
  // -----------------------------------------------------------------------

  async sendHumanAuthEscalation(peerId: string, htmlBody: string, openUrl?: string): Promise<void> {
    if (!this.webClient) return;

    const plainText = this.htmlToMrkdwn(htmlBody);
    const blocks: any[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "Human Auth Required" },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: plainText.slice(0, 3000) },
      },
    ];

    if (openUrl) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open Human Auth" },
            url: openUrl,
            style: "primary",
            action_id: "openpocket_human_auth_open",
          },
        ],
      });
    }

    await this.webClient.chat.postMessage({
      channel: peerId,
      text: `Human Auth Required: ${plainText.slice(0, 200)}`,
      blocks,
    });
  }

  // -----------------------------------------------------------------------
  // Platform identity
  // -----------------------------------------------------------------------

  async resolveDisplayName(peerId: string): Promise<string | null> {
    if (!this.webClient) return null;
    try {
      const result = await this.webClient.users.info({ user: peerId });
      const user = result.user as Record<string, unknown> | undefined;
      if (!user) return null;
      const profile = user.profile as Record<string, unknown> | undefined;
      return (profile?.display_name as string) || (profile?.real_name as string) || (user.name as string) || null;
    } catch {
      return null;
    }
  }

  getCapabilities(): ChannelCapabilities {
    return getDefaultCapabilities("slack");
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  // -----------------------------------------------------------------------
  // Access control
  // -----------------------------------------------------------------------

  isAllowed(_senderId: string): boolean {
    const allowFrom = this.slackConfig.allowFrom;
    if (!allowFrom || allowFrom.length === 0) return true;
    return allowFrom.includes(_senderId);
  }

  isChannelAllowed(channelId: string): boolean {
    const allowChannels = this.slackConfig.allowChannels;
    if (!allowChannels || allowChannels.length === 0) return true;
    return allowChannels.includes(channelId);
  }

  // -----------------------------------------------------------------------
  // Internal: Slack message handling
  // -----------------------------------------------------------------------

  private async handleMessage(args: SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs): Promise<void> {
    if (!this.running) return;

    const event = args.event;
    if (event.subtype) return;
    if (!("user" in event) || !event.user) return;
    if (event.user === this.botUserId) return;

    const userId = event.user;
    const text = ("text" in event ? event.text : "") ?? "";
    const channelId = event.channel;

    const isDM = event.channel_type === "im";

    if (isDM && this.tryResolveInteractivePending(userId, text)) return;

    if (!isDM && !this.isChannelAllowed(channelId)) return;

    await this.sendAckReaction(channelId, event.ts);

    const peerKind = isDM ? "dm" as const : ("thread_ts" in event && event.thread_ts ? "thread" as const : "group" as const);
    const peerId = isDM ? userId : channelId;
    const threadId = "thread_ts" in event ? (event.thread_ts ?? undefined) : undefined;

    let command: string | undefined;
    let commandArgs: string | undefined;
    const cleanText = this.stripBotMention(text);

    const cmdMatch = cleanText.match(/^[!/](\w+)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      command = cmdMatch[1].toLowerCase();
      commandArgs = (cmdMatch[2] ?? "").trim();
    }

    const envelope: InboundEnvelope = {
      channelType: "slack",
      senderId: userId,
      senderName: null,
      senderLanguageCode: null,
      peerId,
      peerKind,
      threadId,
      text: cleanText,
      command,
      commandArgs,
      attachments: this.extractAttachments(event as unknown as Record<string, unknown>),
      rawEvent: event,
      receivedAt: new Date().toISOString(),
      adapterPreAuthorized: peerKind === "group" || peerKind === "thread",
    };

    try {
      if (this.inboundHandler) {
        await this.inboundHandler(envelope);
      }
    } catch (error) {
      this.log(`handler error channel=${channelId} error=${(error as Error).message}`);
    }
  }

  private async handleAppMention(args: SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs): Promise<void> {
    if (!this.running) return;

    const event = args.event;
    const userId = event.user ?? "";
    if (!userId) return;
    const text = event.text ?? "";
    const channelId = event.channel;

    if (!this.isChannelAllowed(channelId)) return;

    const cleanText = this.stripBotMention(text);

    let command: string | undefined;
    let commandArgs: string | undefined;
    const cmdMatch = cleanText.match(/^[!/](\w+)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      command = cmdMatch[1].toLowerCase();
      commandArgs = (cmdMatch[2] ?? "").trim();
    }

    const threadId = event.thread_ts ?? undefined;
    const peerKind = threadId ? "thread" as const : "group" as const;

    const envelope: InboundEnvelope = {
      channelType: "slack",
      senderId: userId,
      senderName: null,
      senderLanguageCode: null,
      peerId: channelId,
      peerKind,
      threadId,
      text: cleanText,
      command,
      commandArgs,
      attachments: [],
      rawEvent: event,
      receivedAt: new Date().toISOString(),
      adapterPreAuthorized: true,
    };

    try {
      if (this.inboundHandler) {
        await this.inboundHandler(envelope);
      }
    } catch (error) {
      this.log(`handler error (app_mention) channel=${channelId} error=${(error as Error).message}`);
    }
  }

  private async handleSlashCommand(
    commandName: string,
    argsText: string,
    userId: string,
    channelId: string,
  ): Promise<void> {
    const envelope: InboundEnvelope = {
      channelType: "slack",
      senderId: userId,
      senderName: null,
      senderLanguageCode: null,
      peerId: channelId,
      peerKind: "group",
      text: `/${commandName}${argsText ? ` ${argsText}` : ""}`,
      command: commandName,
      commandArgs: argsText.trim(),
      attachments: [],
      rawEvent: { command: commandName, text: argsText, user_id: userId, channel_id: channelId },
      receivedAt: new Date().toISOString(),
      adapterPreAuthorized: true,
    };

    try {
      if (this.inboundHandler) {
        await this.inboundHandler(envelope);
      }
    } catch (error) {
      this.log(`slash command error cmd=${commandName} error=${(error as Error).message}`);
    }
  }

  private tryResolveInteractivePending(userId: string, text: string): boolean {
    if (text.startsWith("/") || text.startsWith("!")) return false;
    if (!text) return false;

    const pendingInput = this.pendingUserInputs.get(userId);
    if (pendingInput) {
      clearTimeout(pendingInput.timeout);
      this.pendingUserInputs.delete(userId);
      pendingInput.resolve({ text, resolvedAt: new Date().toISOString() });
      return true;
    }

    const pendingDecision = this.pendingUserDecisions.get(userId);
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
      this.pendingUserDecisions.delete(userId);
      pendingDecision.resolve({ selectedOption: selected, rawInput: text, resolvedAt: new Date().toISOString() });
      return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Ack reaction
  // -----------------------------------------------------------------------

  private async sendAckReaction(channel: string, timestamp: string): Promise<void> {
    if (!this.webClient) return;
    const emoji = this.slackConfig.ackReaction;
    if (!emoji) return;
    try {
      await this.webClient.reactions.add({ channel, timestamp, name: emoji });
    } catch {
      this.log(`ack reaction failed emoji=${emoji}`);
    }
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private resolveBotToken(): string {
    const direct = this.slackConfig.botToken?.trim();
    if (direct) return direct;

    const envKey = this.slackConfig.botTokenEnv || "SLACK_BOT_TOKEN";
    const envVal = process.env[envKey]?.trim();
    if (envVal) return envVal;

    return "";
  }

  private resolveAppToken(): string {
    const direct = this.slackConfig.appToken?.trim();
    if (direct) return direct;

    const envKey = this.slackConfig.appTokenEnv || "SLACK_APP_TOKEN";
    const envVal = process.env[envKey]?.trim();
    if (envVal) return envVal;

    return "";
  }

  private resolveProxyUrl(): string | null {
    if (this.slackConfig.proxyUrl) return this.slackConfig.proxyUrl;
    return process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || process.env.ALL_PROXY || process.env.all_proxy
      || null;
  }

  private async resolveProxyAgent(): Promise<unknown | null> {
    const proxyUrl = this.resolveProxyUrl();
    if (!proxyUrl) return null;

    try {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      this.log(`using proxy: ${proxyUrl}`);
      return new HttpsProxyAgent(proxyUrl);
    } catch {
      this.log("https-proxy-agent not available, connecting directly");
      return null;
    }
  }

  private stripBotMention(text: string): string {
    if (!this.botUserId) return text;
    return text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
  }

  private extractAttachments(event: Record<string, unknown>): InboundEnvelope["attachments"] {
    const files = event.files as Array<Record<string, unknown>> | undefined;
    if (!files || !Array.isArray(files)) return [];

    return files.map((file) => {
      const mimetype = String(file.mimetype ?? "");
      let type: "photo" | "video" | "audio" | "document" | "other" = "document";
      if (mimetype.startsWith("image/")) type = "photo";
      else if (mimetype.startsWith("video/")) type = "video";
      else if (mimetype.startsWith("audio/")) type = "audio";

      return {
        type,
        url: String(file.url_private ?? file.permalink ?? ""),
        mimeType: mimetype || undefined,
        fileName: file.name ? String(file.name) : undefined,
        sizeBytes: typeof file.size === "number" ? file.size : undefined,
      };
    });
  }

  private chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }
    return chunks;
  }

  private htmlToMrkdwn(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?b>/gi, "*")
      .replace(/<\/?i>/gi, "_")
      .replace(/<\/?code>/gi, "`")
      .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "<$1|$2>")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim();
  }

  private clearExistingDecision(peerId: string): void {
    const existing = this.pendingUserDecisions.get(peerId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.pendingUserDecisions.delete(peerId);
      existing.reject(new Error("Superseded by a newer user-decision request."));
    }
  }

  private clearExistingInput(peerId: string): void {
    const existing = this.pendingUserInputs.get(peerId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.pendingUserInputs.delete(peerId);
      existing.reject(new Error("Superseded by a newer user-input request."));
    }
  }

  private clearPending(): void {
    for (const [, pending] of this.pendingUserDecisions) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Adapter stopping."));
    }
    this.pendingUserDecisions.clear();
    for (const [, pending] of this.pendingUserInputs) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Adapter stopping."));
    }
    this.pendingUserInputs.clear();
  }

  private log(message: string): void {
    this.writeLogLine(`[OpenPocket][slack-adapter] ${new Date().toISOString()} ${message}`);
  }
}
