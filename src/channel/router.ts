import type {
  ChannelAdapter,
  ChannelRouter,
  ChannelType,
  InboundEnvelope,
  InboundHandler,
  SendOptions,
} from "./types.js";

/**
 * Default ChannelRouter implementation.
 *
 * - Registers adapters by channelType (one per type).
 * - Deterministic reply routing: replies go back to the originating channel.
 * - Fans out inbound messages from all adapters to a single handler (GatewayCore).
 */
export class DefaultChannelRouter implements ChannelRouter {
  private readonly adapters = new Map<ChannelType, ChannelAdapter>();
  private inboundHandler: InboundHandler | null = null;
  private readonly writeLine: (line: string) => void;

  constructor(options?: { log?: (line: string) => void }) {
    this.writeLine =
      options?.log ??
      ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      });
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);

    adapter.onInbound((envelope) => {
      if (!this.inboundHandler) {
        this.log("warn", `no inbound handler registered, dropping message channel=${envelope.channelType} sender=${envelope.senderId}`);
        return;
      }
      void Promise.resolve(this.inboundHandler(envelope)).catch((error) => {
        this.log("error", `inbound handler error channel=${envelope.channelType} sender=${envelope.senderId} error=${(error as Error).message}`);
      });
    });

    this.log("info", `adapter registered channel=${adapter.channelType}`);
  }

  getAdapter(channelType: ChannelType): ChannelAdapter | null {
    return this.adapters.get(channelType) ?? null;
  }

  getAllAdapters(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  async startAll(): Promise<void> {
    const entries = [...this.adapters.entries()];
    for (const [channelType, adapter] of entries) {
      try {
        await adapter.start();
        this.log("info", `adapter started channel=${channelType}`);
      } catch (error) {
        this.log("error", `adapter start failed channel=${channelType} error=${(error as Error).message}`);
      }
    }
  }

  async stopAll(reason?: string): Promise<void> {
    const entries = [...this.adapters.entries()];
    for (const [channelType, adapter] of entries) {
      try {
        await adapter.stop(reason);
        this.log("info", `adapter stopped channel=${channelType} reason=${reason ?? "shutdown"}`);
      } catch (error) {
        this.log("error", `adapter stop failed channel=${channelType} error=${(error as Error).message}`);
      }
    }
  }

  async replyText(envelope: InboundEnvelope, text: string, opts?: SendOptions): Promise<void> {
    const adapter = this.adapters.get(envelope.channelType);
    if (!adapter) {
      this.log("warn", `no adapter for reply channel=${envelope.channelType}`);
      return;
    }
    await adapter.sendText(envelope.peerId, text, opts);
  }

  async replyImage(envelope: InboundEnvelope, imagePath: string, caption?: string): Promise<void> {
    const adapter = this.adapters.get(envelope.channelType);
    if (!adapter) {
      this.log("warn", `no adapter for reply channel=${envelope.channelType}`);
      return;
    }
    await adapter.sendImage(envelope.peerId, imagePath, caption);
  }

  async replyFile(envelope: InboundEnvelope, filePath: string, caption?: string): Promise<void> {
    const adapter = this.adapters.get(envelope.channelType);
    if (!adapter) {
      this.log("warn", `no adapter for reply channel=${envelope.channelType}`);
      return;
    }
    await adapter.sendFile(envelope.peerId, filePath, caption);
  }

  async replyVoice(envelope: InboundEnvelope, voicePath: string, caption?: string): Promise<void> {
    const adapter = this.adapters.get(envelope.channelType);
    if (!adapter) {
      this.log("warn", `no adapter for reply channel=${envelope.channelType}`);
      return;
    }
    await adapter.sendVoice(envelope.peerId, voicePath, caption);
  }

  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.writeLine(`[OpenPocket][channel-router][${level}] ${new Date().toISOString()} ${message}`);
  }
}
