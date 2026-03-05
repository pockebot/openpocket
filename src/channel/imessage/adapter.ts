import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

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
  IMessageChannelConfig,
  SendOptions,
} from "../types.js";
import { getDefaultCapabilities } from "../capabilities.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IMessageAdapterOptions {
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

/**
 * Parsed JSON line from `imsg watch --json` (snake_case fields).
 *
 * Actual output example:
 * {
 *   "id": 4,
 *   "guid": "FC6DB6DC-...",
 *   "text": "hello",
 *   "created_at": "2026-02-28T17:40:27.101Z",
 *   "is_from_me": false,
 *   "sender": "alice@icloud.com",
 *   "chat_id": 1,
 *   "destination_caller_id": "mailto:alice@icloud.com",
 *   "attachments": [],
 *   "reactions": []
 * }
 */
interface ImsgWatchEvent {
  id?: number;
  guid?: string;
  text?: string;
  created_at?: string;
  is_from_me?: boolean;
  sender?: string;
  chat_id?: number;
  destination_caller_id?: string;
  display_name?: string | null;
  is_group?: boolean;
  attachments?: Array<{ path?: string; mime?: string; filename?: string }>;
  reactions?: unknown[];
}

// ---------------------------------------------------------------------------
// IMessageAdapter
//
// macOS-only adapter powered by the `imsg` CLI (steipete/imsg).
//
// - Inbound:  `imsg watch --json` streams new messages as JSON lines
// - Outbound: `imsg send --to <id> --text <msg>` sends messages
// - Typing:   `imsg typing --to <id> --duration <sec>s`
// ---------------------------------------------------------------------------

export class IMessageAdapter implements ChannelAdapter {
  readonly channelType = "imessage" as const;

  private readonly config: OpenPocketConfig;
  private readonly imConfig: IMessageChannelConfig;
  private readonly writeLogLine: (line: string) => void;
  private readonly chatDbPath: string;

  private readonly pendingUserDecisions = new Map<string, PendingUserDecision>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();

  private inboundHandler: InboundHandler | null = null;
  private running = false;
  private watchProcess: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(config: OpenPocketConfig, imConfig: IMessageChannelConfig, options?: IMessageAdapterOptions) {
    this.config = config;
    this.imConfig = imConfig;
    this.writeLogLine = options?.logger ?? ((line: string) => { console.log(line); });
    this.chatDbPath = imConfig.chatDbPath ?? path.join(os.homedir(), "Library", "Messages", "chat.db");
  }

  // -----------------------------------------------------------------------
  // ChannelAdapter lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;

    if (process.platform !== "darwin") {
      this.log("iMessage adapter is only supported on macOS — skipping");
      return;
    }

    const imsgPath = await this.findImsg();
    if (!imsgPath) {
      this.log("imsg CLI not found — install with: brew install steipete/tap/imsg");
      return;
    }

    this.running = true;
    this.log(`imessage adapter starting — using imsg at ${imsgPath}`);
    this.spawnWatch(imsgPath);
  }

  async stop(reason?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.watchProcess) {
      this.watchProcess.kill("SIGTERM");
      this.watchProcess = null;
    }

    this.clearPending();
    this.log(`imessage adapter stopped reason=${reason ?? "unknown"}`);
  }

  // -----------------------------------------------------------------------
  // Outbound messaging via `imsg send`
  // -----------------------------------------------------------------------

  async sendText(peerId: string, text: string, _opts?: SendOptions): Promise<void> {
    const chunks = this.chunkText(text, 20000);
    for (const chunk of chunks) {
      await this.imsgSend(peerId, chunk);
    }
  }

  async sendImage(peerId: string, imagePath: string, caption?: string): Promise<void> {
    if (caption) {
      await this.sendText(peerId, caption);
    }
    if (!fs.existsSync(imagePath)) {
      this.log(`sendImage: file not found path=${imagePath}`);
      return;
    }
    await this.imsgSendFile(peerId, imagePath);
  }

  async sendFile(peerId: string, filePath: string, caption?: string): Promise<void> {
    if (caption) {
      await this.sendText(peerId, caption);
    }
    if (!fs.existsSync(filePath)) {
      this.log(`sendFile: file not found path=${filePath}`);
      return;
    }
    await this.imsgSendFile(peerId, filePath);
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
  // Typing indicator via `imsg typing`
  // -----------------------------------------------------------------------

  async setTypingIndicator(peerId: string, active: boolean): Promise<void> {
    try {
      const args = ["typing", "--to", peerId];
      if (!active) {
        args.push("--stop", "true");
      } else {
        args.push("--duration", "10s");
      }
      await execFileAsync("imsg", args, { timeout: 8_000 });
    } catch {
      // typing indicator is best-effort
    }
  }

  // -----------------------------------------------------------------------
  // User decision / input
  // -----------------------------------------------------------------------

  async requestUserDecision(peerId: string, request: UserDecisionRequest): Promise<UserDecisionResponse> {
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
      void this.sendText(peerId, prompt);
    });
  }

  async requestUserInput(peerId: string, request: UserInputRequest): Promise<UserInputResponse> {
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
      void this.sendText(peerId, prompt);
    });
  }

  // -----------------------------------------------------------------------
  // Human auth escalation
  // -----------------------------------------------------------------------

  async sendHumanAuthEscalation(peerId: string, htmlBody: string, openUrl?: string): Promise<void> {
    const plainText = this.htmlToPlainText(htmlBody);
    const message = openUrl ? `${plainText}\n\nOpen: ${openUrl}` : plainText;
    await this.sendText(peerId, message);
  }

  // -----------------------------------------------------------------------
  // Platform identity
  // -----------------------------------------------------------------------

  async resolveDisplayName(_peerId: string): Promise<string | null> {
    return null;
  }

  getCapabilities(): ChannelCapabilities {
    return getDefaultCapabilities("imessage");
  }

  isAllowed(_senderId: string): boolean {
    return true;
  }

  // -----------------------------------------------------------------------
  // imsg watch — stream incoming messages
  // -----------------------------------------------------------------------

  private spawnWatch(imsgPath: string): void {
    const args = ["watch", "--json", "--db", this.chatDbPath];
    this.log(`spawning: ${imsgPath} ${args.join(" ")}`);

    const child = spawn(imsgPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.watchProcess = child;

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      void this.handleWatchLine(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.log(`imsg watch stderr: ${text}`);
    });

    child.on("error", (err) => {
      this.log(`imsg watch process error: ${err.message}`);
      this.scheduleRestart(imsgPath);
    });

    child.on("exit", (code, signal) => {
      this.log(`imsg watch exited code=${code} signal=${signal}`);
      this.watchProcess = null;
      if (this.running) {
        this.scheduleRestart(imsgPath);
      }
    });
  }

  private scheduleRestart(imsgPath: string): void {
    if (!this.running) return;
    if (this.restartTimer) return;
    this.log("imsg watch will restart in 5s...");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.running) {
        this.spawnWatch(imsgPath);
      }
    }, 5_000);
  }

  private async handleWatchLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let event: ImsgWatchEvent;
    try {
      event = JSON.parse(line);
    } catch {
      this.log(`imsg watch: non-JSON line: ${line.slice(0, 200)}`);
      return;
    }

    if (event.is_from_me) return;
    const text = (event.text ?? "").trim();
    if (!text) return;

    const senderId = event.sender ?? "";
    if (!senderId) return;

    this.log(`inbound from=${senderId} text="${text.slice(0, 80)}"`);

    if (this.tryResolveInteractivePending(senderId, text)) return;

    const isGroup = event.is_group ?? false;
    const peerKind = isGroup ? "group" : "dm";
    const peerId = event.destination_caller_id?.replace(/^mailto:/, "") ?? event.sender ?? senderId;

    let command: string | undefined;
    let commandArgs: string | undefined;
    const cmdMatch = text.match(/^[!/](\w+)(?:\s+(.*))?$/s);
    if (cmdMatch) {
      command = cmdMatch[1].toLowerCase();
      commandArgs = (cmdMatch[2] ?? "").trim();
    }

    const envelope: InboundEnvelope = {
      channelType: "imessage",
      senderId,
      senderName: event.display_name ?? null,
      senderLanguageCode: null,
      peerId,
      peerKind,
      text,
      command,
      commandArgs,
      attachments: [],
      rawEvent: event,
      receivedAt: event.created_at ?? new Date().toISOString(),
    };

    try {
      if (this.inboundHandler) {
        await this.inboundHandler(envelope);
      }
    } catch (error) {
      this.log(`handler error peerId=${peerId} error=${(error as Error).message}`);
      try {
        await this.sendText(peerId, `OpenPocket error: ${(error as Error).message}`);
      } catch { /* ignore */ }
    }
  }

  private tryResolveInteractivePending(senderId: string, text: string): boolean {
    if (text.startsWith("/") || text.startsWith("!")) return false;

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
  // imsg send / file helpers
  // -----------------------------------------------------------------------

  private async imsgSend(peerId: string, text: string): Promise<void> {
    try {
      await execFileAsync("imsg", [
        "send", "--to", peerId, "--text", text, "--json",
      ], { timeout: 15_000 });
    } catch (error) {
      this.log(`imsg send failed to=${peerId}: ${(error as Error).message}`);
    }
  }

  private async imsgSendFile(peerId: string, filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);
    try {
      await execFileAsync("imsg", [
        "send", "--to", peerId, "--file", absPath, "--json",
      ], { timeout: 30_000 });
    } catch (error) {
      this.log(`imsg send file failed to=${peerId}: ${(error as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private async findImsg(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("which", ["imsg"], { timeout: 5_000 });
      const p = stdout.trim();
      return p || null;
    } catch {
      for (const candidate of ["/opt/homebrew/bin/imsg", "/usr/local/bin/imsg"]) {
        if (fs.existsSync(candidate)) return candidate;
      }
      return null;
    }
  }

  private chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
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
      .replace(/<\/?code>/gi, "`")
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
    this.writeLogLine(`[OpenPocket][imessage-adapter] ${new Date().toISOString()} ${message}`);
  }
}
