import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
  type ConnectionState,
} from "baileys";
import { Boom } from "@hapi/boom";
import fs from "node:fs";
import path from "node:path";

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
  WhatsAppChannelConfig,
} from "../types.js";
import { getDefaultCapabilities } from "../capabilities.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhatsAppAdapterOptions {
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
// WhatsAppAdapter
// ---------------------------------------------------------------------------

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelType = "whatsapp" as const;

  private readonly config: OpenPocketConfig;
  private readonly waConfig: WhatsAppChannelConfig;
  private readonly writeLogLine: (line: string) => void;
  private readonly authDir: string;
  private readonly textChunkLimit: number;
  private readonly chunkMode: "length" | "newline";

  private readonly pendingUserDecisions = new Map<string, PendingUserDecision>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();

  private sock: WASocket | null = null;
  private inboundHandler: InboundHandler | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private qrDisplayed = false;

  constructor(config: OpenPocketConfig, waConfig: WhatsAppChannelConfig, options?: WhatsAppAdapterOptions) {
    this.config = config;
    this.waConfig = waConfig;
    this.writeLogLine = options?.logger ?? ((line: string) => { console.log(line); });
    this.authDir = path.join(config.stateDir, "whatsapp-auth");
    this.textChunkLimit = waConfig.textChunkLimit ?? 4000;
    this.chunkMode = waConfig.chunkMode ?? "newline";
  }

  // -----------------------------------------------------------------------
  // ChannelAdapter lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.connect();
  }

  async stop(reason?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearPending();
    if (this.sock) {
      try { this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = null;
    }
    this.log(`whatsapp adapter stopped reason=${reason ?? "unknown"}`);
  }

  // -----------------------------------------------------------------------
  // Outbound messaging
  // -----------------------------------------------------------------------

  async sendText(peerId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!this.sock) return;
    const jid = this.ensureJid(peerId);
    const chunks = this.chunkText(text);
    for (const chunk of chunks) {
      await this.sock.sendMessage(jid, { text: chunk });
    }
  }

  async sendImage(peerId: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.sock) return;
    const jid = this.ensureJid(peerId);

    if (!fs.existsSync(imagePath)) {
      this.log(`sendImage: file not found path=${imagePath}`);
      if (caption) await this.sock.sendMessage(jid, { text: caption });
      return;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    await this.sock.sendMessage(jid, {
      image: imageBuffer,
      caption: caption ?? undefined,
    });
  }

  // -----------------------------------------------------------------------
  // Inbound
  // -----------------------------------------------------------------------

  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler;
  }

  // -----------------------------------------------------------------------
  // Typing indicator (presence)
  // -----------------------------------------------------------------------

  async setTypingIndicator(peerId: string, active: boolean): Promise<void> {
    if (!this.sock) return;
    const jid = this.ensureJid(peerId);
    try {
      await this.sock.sendPresenceUpdate(active ? "composing" : "paused", jid);
    } catch { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // User decision / input
  // -----------------------------------------------------------------------

  async requestUserDecision(peerId: string, request: UserDecisionRequest): Promise<UserDecisionResponse> {
    if (!this.sock) throw new Error("WhatsApp socket not connected.");
    const jid = this.ensureJid(peerId);

    return new Promise<UserDecisionResponse>((resolve, reject) => {
      this.clearExistingDecision(peerId);

      const timeout = setTimeout(() => {
        this.pendingUserDecisions.delete(peerId);
        reject(new Error("User decision timed out."));
      }, Math.max(15_000, request.timeoutSec * 1000));

      this.pendingUserDecisions.set(peerId, { request, resolve, reject, timeout });

      const options = request.options ?? [];
      const optionsList = options.length > 0
        ? options.map((item, index) => `${index + 1}. ${item}`).join("\n")
        : "(no options provided)";
      const prompt = [request.question, "", "Options:", optionsList, "", "Reply with option number or text."].join("\n");
      void this.sock!.sendMessage(jid, { text: prompt.slice(0, this.textChunkLimit) });
    });
  }

  async requestUserInput(peerId: string, request: UserInputRequest): Promise<UserInputResponse> {
    if (!this.sock) throw new Error("WhatsApp socket not connected.");
    const jid = this.ensureJid(peerId);

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
      void this.sock!.sendMessage(jid, { text: prompt.slice(0, this.textChunkLimit) });
    });
  }

  // -----------------------------------------------------------------------
  // Human auth escalation
  // -----------------------------------------------------------------------

  async sendHumanAuthEscalation(peerId: string, htmlBody: string, openUrl?: string): Promise<void> {
    if (!this.sock) return;
    const jid = this.ensureJid(peerId);
    const plainText = this.htmlToPlainText(htmlBody);
    const message = openUrl
      ? `${plainText}\n\nOpen: ${openUrl}`
      : plainText;
    await this.sock.sendMessage(jid, { text: message });
  }

  // -----------------------------------------------------------------------
  // Platform identity
  // -----------------------------------------------------------------------

  async resolveDisplayName(peerId: string): Promise<string | null> {
    if (!this.sock) return null;
    const jid = this.ensureJid(peerId);
    try {
      const results = await this.sock.onWhatsApp(jid);
      const first = results?.[0];
      return first?.jid ?? null;
    } catch {
      return null;
    }
  }

  getCapabilities(): ChannelCapabilities {
    return getDefaultCapabilities("whatsapp");
  }

  // -----------------------------------------------------------------------
  // Access control
  // -----------------------------------------------------------------------

  isAllowed(senderId: string): boolean {
    const allowFrom = this.waConfig.allowFrom;
    if (!allowFrom || allowFrom.length === 0) return true;
    if (allowFrom.includes("*")) return true;
    const normalized = this.normalizePhoneId(senderId);
    return allowFrom.some((a) => this.normalizePhoneId(a) === normalized);
  }

  // -----------------------------------------------------------------------
  // Connection management
  // -----------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (!this.running) return;

    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    const sock = makeWASocket({
      auth: state,
      browser: ["OpenPocket", "Desktop", "1.0.0"],
    });

    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => { void this.handleConnectionUpdate(update); });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        void this.handleIncomingMessage(msg);
      }
    });

    this.log("whatsapp connecting...");
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !this.qrDisplayed) {
      this.qrDisplayed = true;
      this.log(`whatsapp QR code generated — scan with your phone to link. QR data: ${qr.slice(0, 40)}...`);
    }

    if (connection === "open") {
      this.qrDisplayed = false;
      this.log("whatsapp connection established");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      this.log(`whatsapp connection closed statusCode=${statusCode} shouldReconnect=${shouldReconnect}`);

      if (shouldReconnect && this.running) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.connect();
        }, 3000);
      } else if (statusCode === DisconnectReason.loggedOut) {
        this.log("whatsapp logged out — session cleared. Re-scan QR to re-link.");
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal: WAMessage → InboundEnvelope
  // -----------------------------------------------------------------------

  private async handleIncomingMessage(msg: WAMessage): Promise<void> {
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) return;

    const senderId = msg.key.participant ?? remoteJid;
    const text = this.extractText(msg);

    const normalizedSender = this.jidToId(senderId);

    if (this.tryResolveInteractivePending(normalizedSender, text)) return;

    const isGroup = remoteJid.endsWith("@g.us");
    const peerKind = isGroup ? "group" : "dm";
    const peerId = this.jidToId(remoteJid);

    let command: string | undefined;
    let commandArgs: string | undefined;
    const cmdMatch = text.match(/^[!/](\w+)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      command = cmdMatch[1].toLowerCase();
      commandArgs = (cmdMatch[2] ?? "").trim();
    }

    const envelope: InboundEnvelope = {
      channelType: "whatsapp",
      senderId: normalizedSender,
      senderName: msg.pushName ?? null,
      senderLanguageCode: null,
      peerId,
      peerKind,
      text,
      command,
      commandArgs,
      attachments: this.extractAttachments(msg),
      rawEvent: msg,
      receivedAt: new Date().toISOString(),
    };

    if (this.waConfig.sendReadReceipts !== false && this.sock) {
      try {
        await this.sock.readMessages([msg.key]);
      } catch { /* ignore */ }
    }

    try {
      if (this.inboundHandler) {
        await this.inboundHandler(envelope);
      }
    } catch (error) {
      this.log(`handler error jid=${remoteJid} error=${(error as Error).message}`);
      try {
        await this.sock?.sendMessage(remoteJid, {
          text: `OpenPocket error: ${(error as Error).message}`,
        });
      } catch { /* ignore */ }
    }
  }

  private tryResolveInteractivePending(senderId: string, text: string): boolean {
    if (text.startsWith("/") || text.startsWith("!")) return false;
    if (!text) return false;

    const pendingInput = this.pendingUserInputs.get(senderId);
    if (pendingInput) {
      clearTimeout(pendingInput.timeout);
      this.pendingUserInputs.delete(senderId);
      pendingInput.resolve({ text, resolvedAt: new Date().toISOString() });
      return true;
    }

    const pendingDecision = this.pendingUserDecisions.get(senderId);
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
      this.pendingUserDecisions.delete(senderId);
      pendingDecision.resolve({ selectedOption: selected, rawInput: text, resolvedAt: new Date().toISOString() });
      return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Message content extraction
  // -----------------------------------------------------------------------

  private extractText(msg: WAMessage): string {
    const m = msg.message;
    if (!m) return "";

    if (m.conversation) return m.conversation.trim();
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text.trim();
    if (m.imageMessage?.caption) return m.imageMessage.caption.trim();
    if (m.videoMessage?.caption) return m.videoMessage.caption.trim();
    if (m.documentMessage?.caption) return m.documentMessage.caption.trim();
    return "";
  }

  private extractAttachments(msg: WAMessage): InboundEnvelope["attachments"] {
    const m = msg.message;
    if (!m) return [];

    const attachments: InboundEnvelope["attachments"] = [];

    if (m.imageMessage) {
      attachments.push({
        type: "photo",
        url: m.imageMessage.url ?? "",
        mimeType: m.imageMessage.mimetype ?? undefined,
        sizeBytes: Number(m.imageMessage.fileLength ?? 0) || undefined,
      });
    }

    if (m.videoMessage) {
      attachments.push({
        type: "video",
        url: m.videoMessage.url ?? "",
        mimeType: m.videoMessage.mimetype ?? undefined,
        sizeBytes: Number(m.videoMessage.fileLength ?? 0) || undefined,
      });
    }

    if (m.audioMessage) {
      attachments.push({
        type: "audio",
        url: m.audioMessage.url ?? "",
        mimeType: m.audioMessage.mimetype ?? undefined,
        sizeBytes: Number(m.audioMessage.fileLength ?? 0) || undefined,
      });
    }

    if (m.documentMessage) {
      attachments.push({
        type: "document",
        url: m.documentMessage.url ?? "",
        mimeType: m.documentMessage.mimetype ?? undefined,
        fileName: m.documentMessage.fileName ?? undefined,
        sizeBytes: Number(m.documentMessage.fileLength ?? 0) || undefined,
      });
    }

    if (m.stickerMessage) {
      attachments.push({
        type: "sticker",
        url: m.stickerMessage.url ?? "",
        mimeType: m.stickerMessage.mimetype ?? undefined,
      });
    }

    return attachments;
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private ensureJid(peerId: string): string {
    if (peerId.includes("@")) return peerId;
    return `${peerId}@s.whatsapp.net`;
  }

  private jidToId(jid: string): string {
    return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "");
  }

  private normalizePhoneId(id: string): string {
    return id.replace(/@.*$/, "").replace(/[^0-9]/g, "");
  }

  private chunkText(text: string): string[] {
    const maxLen = this.textChunkLimit;
    if (text.length <= maxLen) return [text];

    if (this.chunkMode === "newline") {
      return this.chunkByNewline(text, maxLen);
    }
    return this.chunkByLength(text, maxLen);
  }

  private chunkByLength(text: string, maxLen: number): string[] {
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

  private chunkByNewline(text: string, maxLen: number): string[] {
    const lines = text.split("\n");
    const chunks: string[] = [];
    let current = "";

    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > maxLen && current) {
        chunks.push(current);
        current = line.length > maxLen ? line.slice(0, maxLen) : line;
      } else if (candidate.length > maxLen) {
        chunks.push(candidate.slice(0, maxLen));
        current = "";
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private htmlToPlainText(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?b>/gi, "*")
      .replace(/<\/?i>/gi, "_")
      .replace(/<\/?code>/gi, "```")
      .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
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
    this.writeLogLine(`[OpenPocket][whatsapp-adapter] ${new Date().toISOString()} ${message}`);
  }
}
