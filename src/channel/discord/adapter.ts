import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType as DjsChannelType,
  ButtonStyle,
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  type Message as DjsMessage,
  type Interaction,
  type DMChannel,
  type TextChannel,
  type PublicThreadChannel,
  type PrivateThreadChannel,
} from "discord.js";
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
  DiscordChannelConfig,
  InboundEnvelope,
  InboundHandler,
  SendOptions,
} from "../types.js";
import { getDefaultCapabilities } from "../capabilities.js";

type SendableChannel = DMChannel | TextChannel | PublicThreadChannel | PrivateThreadChannel;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscordAdapterOptions {
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
// DiscordAdapter
// ---------------------------------------------------------------------------

export class DiscordAdapter implements ChannelAdapter {
  readonly channelType = "discord" as const;

  private readonly config: OpenPocketConfig;
  private readonly discordConfig: DiscordChannelConfig;
  private readonly client: Client;
  private readonly writeLogLine: (line: string) => void;

  private readonly pendingUserDecisions = new Map<string, PendingUserDecision>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();

  private inboundHandler: InboundHandler | null = null;
  private running = false;
  private readyResolve: (() => void) | null = null;

  constructor(config: OpenPocketConfig, discordConfig: DiscordChannelConfig, options?: DiscordAdapterOptions) {
    this.config = config;
    this.discordConfig = discordConfig;
    this.writeLogLine = options?.logger ?? ((line: string) => { console.log(line); });

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  // -----------------------------------------------------------------------
  // ChannelAdapter lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const token = this.resolveToken();
    if (!token) {
      throw new Error(
        "Discord bot token is empty. Set channels.discord.token or env variable via channels.discord.tokenEnv.",
      );
    }

    this.client.on("messageCreate", this.handleMessage);
    this.client.on("interactionCreate", this.handleInteraction);

    const readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.client.once("ready", () => {
      this.log(`discord adapter ready as ${this.client.user?.tag}`);
      this.readyResolve?.();
      this.readyResolve = null;
    });

    await this.client.login(token);
    await readyPromise;
    this.log("discord adapter started");
  }

  async stop(reason?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.client.removeListener("messageCreate", this.handleMessage);
    this.client.removeListener("interactionCreate", this.handleInteraction);
    this.clearPending();
    try { await this.client.destroy(); } catch { /* ignore */ }
    this.log(`discord adapter stopped reason=${reason ?? "unknown"}`);
  }

  // -----------------------------------------------------------------------
  // Outbound messaging
  // -----------------------------------------------------------------------

  async sendText(peerId: string, text: string, opts?: SendOptions): Promise<void> {
    const channel = await this.resolveChannel(peerId);
    if (!channel) return;

    const maxLen = 2000;
    const chunks = this.chunkText(text, maxLen);
    for (const chunk of chunks) {
      await channel.send({ content: chunk });
    }
  }

  async sendImage(peerId: string, imagePath: string, caption?: string): Promise<void> {
    const channel = await this.resolveChannel(peerId);
    if (!channel) return;

    if (!fs.existsSync(imagePath)) {
      this.log(`sendImage: file not found path=${imagePath}`);
      if (caption) await channel.send({ content: caption });
      return;
    }

    const attachment = new AttachmentBuilder(imagePath);
    await channel.send({
      content: caption ?? undefined,
      files: [attachment],
    });
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
    if (!active) return;
    const channel = await this.resolveChannel(peerId);
    if (!channel) return;
    try { await channel.sendTyping(); } catch { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // User decision / input
  // -----------------------------------------------------------------------

  async requestUserDecision(peerId: string, request: UserDecisionRequest): Promise<UserDecisionResponse> {
    const channel = await this.resolveChannel(peerId);
    if (!channel) throw new Error("Cannot resolve Discord channel for user decision.");

    return new Promise<UserDecisionResponse>((resolve, reject) => {
      this.clearExistingDecision(peerId);

      const timeout = setTimeout(() => {
        this.pendingUserDecisions.delete(peerId);
        reject(new Error("User decision timed out."));
      }, Math.max(15_000, request.timeoutSec * 1000));

      this.pendingUserDecisions.set(peerId, { request, resolve, reject, timeout });

      const options = request.options ?? [];
      if (options.length > 0 && options.length <= 5) {
        const row = new ActionRowBuilder<ButtonBuilder>();
        for (let i = 0; i < options.length; i++) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`openpocket_decision_${i}`)
              .setLabel(options[i].slice(0, 80))
              .setStyle(ButtonStyle.Primary),
          );
        }
        void channel.send({
          content: request.question.slice(0, 2000),
          components: [row],
        });
      } else {
        const optionsList = options.length > 0
          ? options.map((item, index) => `${index + 1}. ${item}`).join("\n")
          : "(no options provided)";
        const prompt = [request.question, "", "Options:", optionsList, "", "Reply with option number or text."].join("\n");
        void channel.send({ content: prompt.slice(0, 2000) });
      }
    });
  }

  async requestUserInput(peerId: string, request: UserInputRequest): Promise<UserInputResponse> {
    const channel = await this.resolveChannel(peerId);
    if (!channel) throw new Error("Cannot resolve Discord channel for user input.");

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
      void channel.send({ content: prompt.slice(0, 2000) });
    });
  }

  // -----------------------------------------------------------------------
  // Human auth escalation
  // -----------------------------------------------------------------------

  async sendHumanAuthEscalation(peerId: string, htmlBody: string, openUrl?: string): Promise<void> {
    const channel = await this.resolveChannel(peerId);
    if (!channel) return;

    const plainText = this.htmlToPlainText(htmlBody);
    const embed = new EmbedBuilder()
      .setTitle("Human Auth Required")
      .setDescription(plainText.slice(0, 4096))
      .setColor(0xFF6600);

    if (openUrl) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel("Open Human Auth")
          .setStyle(ButtonStyle.Link)
          .setURL(openUrl),
      );
      await channel.send({ embeds: [embed], components: [row] });
    } else {
      await channel.send({ embeds: [embed] });
    }
  }

  // -----------------------------------------------------------------------
  // Platform identity
  // -----------------------------------------------------------------------

  async resolveDisplayName(peerId: string): Promise<string | null> {
    try {
      const user = await this.client.users.fetch(peerId);
      return user.displayName ?? user.username ?? null;
    } catch {
      return null;
    }
  }

  getCapabilities(): ChannelCapabilities {
    return getDefaultCapabilities("discord");
  }

  // -----------------------------------------------------------------------
  // Access control
  // -----------------------------------------------------------------------

  isAllowed(_senderId: string): boolean {
    return true;
  }

  isGuildAllowed(guildId: string, userId: string): boolean {
    const guilds = this.discordConfig.guilds;
    if (!guilds) return false;

    const guildConfig = guilds[guildId];
    if (!guildConfig) return false;

    if (guildConfig.users && guildConfig.users.length > 0) {
      return guildConfig.users.includes(userId);
    }
    return true;
  }

  shouldRequireMention(guildId: string): boolean {
    return this.discordConfig.guilds?.[guildId]?.requireMention ?? true;
  }

  // -----------------------------------------------------------------------
  // Internal: Discord message → InboundEnvelope
  // -----------------------------------------------------------------------

  private readonly handleMessage = async (message: DjsMessage): Promise<void> => {
    if (message.author.bot) return;
    if (!this.running) return;

    const isDM = message.channel.type === DjsChannelType.DM;
    const isGuild =
      message.channel.type === DjsChannelType.GuildText ||
      message.channel.type === DjsChannelType.PublicThread ||
      message.channel.type === DjsChannelType.PrivateThread;

    if (!isDM && !isGuild) return;

    const userId = message.author.id;
    const text = message.content?.trim() ?? "";

    if (isDM && this.tryResolveInteractivePending(userId, text)) return;

    if (isGuild && message.guildId) {
      if (!this.isGuildAllowed(message.guildId, userId)) return;

      if (this.shouldRequireMention(message.guildId)) {
        const botId = this.client.user?.id;
        if (!botId || !message.mentions.has(botId)) return;
      }
    }

    const envelope = this.discordMessageToEnvelope(message);
    try {
      if (this.inboundHandler) {
        await this.inboundHandler(envelope);
      }
    } catch (error) {
      this.log(`handler error channel=${message.channel.id} error=${(error as Error).message}`);
      try { await message.reply(`OpenPocket error: ${(error as Error).message}`); } catch { /* ignore */ }
    }
  };

  private readonly handleInteraction = async (interaction: Interaction): Promise<void> => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    if (!customId.startsWith("openpocket_decision_")) return;

    const userId = interaction.user.id;
    const pending = this.pendingUserDecisions.get(userId);
    if (!pending) {
      try { await interaction.reply({ content: "No pending decision.", ephemeral: true }); } catch { /* ignore */ }
      return;
    }

    const index = parseInt(customId.replace("openpocket_decision_", ""), 10);
    const options = pending.request.options ?? [];
    const selected = (index >= 0 && index < options.length) ? options[index] : `option_${index}`;

    clearTimeout(pending.timeout);
    this.pendingUserDecisions.delete(userId);
    pending.resolve({
      selectedOption: selected,
      rawInput: selected,
      resolvedAt: new Date().toISOString(),
    });

    try {
      await interaction.update({
        content: `Got it: "${selected}". Continuing.`,
        components: [],
      });
    } catch { /* ignore */ }
  };

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

  private discordMessageToEnvelope(message: DjsMessage): InboundEnvelope {
    const text = message.content?.trim() ?? "";
    const userId = message.author.id;
    const senderName = message.member?.displayName ?? message.author.displayName ?? message.author.username;

    const isDM = message.channel.type === DjsChannelType.DM;
    const isThread =
      message.channel.type === DjsChannelType.PublicThread ||
      message.channel.type === DjsChannelType.PrivateThread;

    let peerKind: "dm" | "group" | "thread";
    let peerId: string;
    let threadId: string | undefined;

    if (isDM) {
      peerKind = "dm";
      peerId = userId;
    } else if (isThread) {
      peerKind = "thread";
      peerId = message.channel.parentId ?? message.channel.id;
      threadId = message.channel.id;
    } else {
      peerKind = "group";
      peerId = message.channel.id;
    }

    let command: string | undefined;
    let commandArgs: string | undefined;

    const botMention = this.client.user ? `<@${this.client.user.id}>` : null;
    let cleanText = text;
    if (botMention && cleanText.startsWith(botMention)) {
      cleanText = cleanText.slice(botMention.length).trim();
    }

    const cmdMatch = cleanText.match(/^[!/](\w+)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      command = cmdMatch[1].toLowerCase();
      commandArgs = (cmdMatch[2] ?? "").trim();
    }

    const attachments: InboundEnvelope["attachments"] = [];
    for (const att of message.attachments.values()) {
      let type: "photo" | "video" | "audio" | "document" | "other" = "document";
      if (att.contentType?.startsWith("image/")) type = "photo";
      else if (att.contentType?.startsWith("video/")) type = "video";
      else if (att.contentType?.startsWith("audio/")) type = "audio";

      attachments.push({
        type,
        url: att.url,
        mimeType: att.contentType ?? undefined,
        fileName: att.name ?? undefined,
        sizeBytes: att.size,
      });
    }

    return {
      channelType: "discord",
      senderId: userId,
      senderName,
      senderLanguageCode: null,
      peerId,
      peerKind,
      threadId,
      text: cleanText,
      command,
      commandArgs,
      attachments,
      replyTo: message.reference?.messageId
        ? {
            messageId: message.reference.messageId,
            senderId: "",
            body: "",
          }
        : undefined,
      rawEvent: message,
      receivedAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private resolveToken(): string {
    const direct = this.discordConfig.token?.trim();
    if (direct) return direct;

    const envKey = this.discordConfig.tokenEnv;
    if (envKey) {
      const envVal = process.env[envKey]?.trim();
      if (envVal) return envVal;
    }
    return "";
  }

  private async resolveChannel(peerId: string): Promise<SendableChannel | null> {
    try {
      const channel = await this.client.channels.fetch(peerId);
      if (channel && this.isSendable(channel)) return channel;

      const user = await this.client.users.fetch(peerId);
      if (user) return await user.createDM();
    } catch {
      this.log(`failed to resolve channel peerId=${peerId}`);
    }
    return null;
  }

  private isSendable(channel: { type: DjsChannelType }): channel is SendableChannel {
    return (
      channel.type === DjsChannelType.DM ||
      channel.type === DjsChannelType.GuildText ||
      channel.type === DjsChannelType.PublicThread ||
      channel.type === DjsChannelType.PrivateThread
    );
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

  private htmlToPlainText(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?b>/gi, "**")
      .replace(/<\/?i>/gi, "*")
      .replace(/<\/?code>/gi, "`")
      .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "[$2]($1)")
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
    this.writeLogLine(`[OpenPocket][discord-adapter] ${new Date().toISOString()} ${message}`);
  }
}
