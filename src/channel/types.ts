import type {
  AgentProgressUpdate,
  HumanAuthCapability,
  UserDecisionRequest,
  UserDecisionResponse,
  UserInputRequest,
  UserInputResponse,
} from "../types.js";

// ---------------------------------------------------------------------------
// Channel identity
// ---------------------------------------------------------------------------

export type ChannelType =
  | "telegram"
  | "discord"
  | "whatsapp"
  | "imessage"
  | "signal"
  | "slack"
  | "wechat"
  | "qq";

// ---------------------------------------------------------------------------
// DM / Group access policy (inspired by OpenClaw pairing model)
// ---------------------------------------------------------------------------

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type GroupPolicy = "allowlist" | "open" | "disabled";

// ---------------------------------------------------------------------------
// Inbound envelope — unified type for all inbound messages and commands
// ---------------------------------------------------------------------------

export type PeerKind = "dm" | "group" | "thread";

export interface Attachment {
  type: "photo" | "video" | "audio" | "document" | "sticker" | "other";
  /** Local path after download, or platform URL. */
  url: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
}

export interface ReplyContext {
  messageId: string;
  senderId: string;
  body: string;
}

export interface InboundEnvelope {
  channelType: ChannelType;

  /** Platform-specific sender ID (Telegram chatId, Discord userId, phone number, etc.). */
  senderId: string;
  /** Human-readable sender display name, if available. */
  senderName: string | null;
  /** Language code from the platform (e.g. "zh-Hans", "en"), if available. */
  senderLanguageCode: string | null;

  /** The peer (conversation target) — equals senderId for DMs, groupId for groups. */
  peerId: string;
  peerKind: PeerKind;

  /** Thread or topic ID within a group (Discord threads, Telegram forum topics). */
  threadId?: string;

  /** Raw text body. Empty string for media-only messages. */
  text: string;

  /** Parsed command name without prefix (e.g. "start", "help"). Undefined for non-command messages. */
  command?: string;
  /** Arguments after the command. */
  commandArgs?: string;

  attachments: Attachment[];
  replyTo?: ReplyContext;

  /** The original platform SDK event object, for adapter-specific logic. */
  rawEvent: unknown;
  receivedAt: string;

  /**
   * When true, the adapter has already validated group/guild access
   * (e.g. Discord guild allowlist + role check). GatewayCore should
   * skip its own group policy check for this envelope.
   */
  adapterPreAuthorized?: boolean;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

export type MessageFormatMode = "plain" | "markdown" | "html";

export interface SendOptions {
  format?: MessageFormatMode;
  disableLinkPreview?: boolean;
  /** Platform-native reply markup (inline buttons, etc.). Adapters that don't support it will ignore. */
  replyMarkup?: unknown;
}

// ---------------------------------------------------------------------------
// User action prompt / response — channel-agnostic escalation
// ---------------------------------------------------------------------------

export type UserActionType = "decision" | "input" | "auth_approval";

export interface UserActionPrompt {
  type: UserActionType;
  question: string;
  options?: string[];
  placeholder?: string;
  timeoutSec: number;
  screenshotPath?: string | null;
}

export interface UserActionResponse {
  selectedOption?: string;
  text?: string;
  approved?: boolean;
  resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Channel capabilities — what each platform supports
// ---------------------------------------------------------------------------

export interface ChannelCapabilities {
  supportsMarkdown: boolean;
  supportsHtml: boolean;
  supportsInlineButtons: boolean;
  supportsReactions: boolean;
  supportsImageUpload: boolean;
  supportsFileUpload: boolean;
  supportsVoiceUpload: boolean;
  supportsTypingIndicator: boolean;
  supportsSlashCommands: boolean;
  supportsThreads: boolean;
  supportsDisplayNameSync: boolean;
  maxMessageLength: number;
  /** Text chunking mode for long messages. */
  textChunkMode: "length" | "newline";
}

// ---------------------------------------------------------------------------
// Channel adapter — the interface each platform connector implements
// ---------------------------------------------------------------------------

export type InboundHandler = (envelope: InboundEnvelope) => void | Promise<void>;

export interface ChannelAdapter {
  readonly channelType: ChannelType;

  /** Start the adapter (connect SDK, begin polling/listening). */
  start(): Promise<void>;
  /** Gracefully stop the adapter. */
  stop(reason?: string): Promise<void>;

  // --- Outbound messaging ---

  sendText(peerId: string, text: string, opts?: SendOptions): Promise<void>;
  sendImage(peerId: string, imagePath: string, caption?: string): Promise<void>;
  sendFile(peerId: string, filePath: string, caption?: string): Promise<void>;
  sendVoice(peerId: string, voicePath: string, caption?: string): Promise<void>;

  // --- Inbound message registration ---

  onInbound(handler: InboundHandler): void;

  // --- Typing indicator ---

  setTypingIndicator(peerId: string, active: boolean): Promise<void>;

  // --- User interaction prompts ---

  /**
   * Send a decision prompt (options list) and await user reply.
   * Adapter handles platform-native rendering (buttons, numbered list, etc.).
   */
  requestUserDecision(peerId: string, request: UserDecisionRequest): Promise<UserDecisionResponse>;

  /**
   * Send a free-text input prompt and await user reply.
   */
  requestUserInput(peerId: string, request: UserInputRequest): Promise<UserInputResponse>;

  // --- Human auth escalation ---

  /**
   * Send a human-auth escalation message with optional web link and inline button.
   * `htmlBody` is pre-formatted; adapter converts to platform-native format as needed.
   */
  sendHumanAuthEscalation(
    peerId: string,
    htmlBody: string,
    openUrl?: string,
  ): Promise<void>;

  // --- Platform identity ---

  resolveDisplayName(peerId: string): Promise<string | null>;
  getCapabilities(): ChannelCapabilities;

  // --- Access control ---

  isAllowed(senderId: string): boolean;
}

// ---------------------------------------------------------------------------
// Channel router — multi-channel orchestrator
// ---------------------------------------------------------------------------

export interface ChannelRouter {
  /** Register an adapter. Replaces any existing adapter for the same channelType. */
  register(adapter: ChannelAdapter): void;

  /** Get adapter by channel type. */
  getAdapter(channelType: ChannelType): ChannelAdapter | null;

  /** All registered adapters. */
  getAllAdapters(): ChannelAdapter[];

  /** Start all registered adapters. */
  startAll(): Promise<void>;

  /** Stop all registered adapters. */
  stopAll(reason?: string): Promise<void>;

  // --- Deterministic reply routing ---

  /** Reply with text on the originating channel. */
  replyText(envelope: InboundEnvelope, text: string, opts?: SendOptions): Promise<void>;
  /** Reply with image on the originating channel. */
  replyImage(envelope: InboundEnvelope, imagePath: string, caption?: string): Promise<void>;
  /** Reply with file on the originating channel. */
  replyFile(envelope: InboundEnvelope, filePath: string, caption?: string): Promise<void>;
  /** Reply with voice/audio on the originating channel. */
  replyVoice(envelope: InboundEnvelope, voicePath: string, caption?: string): Promise<void>;

  /** Set the unified inbound handler (GatewayCore registers this). */
  onInbound(handler: InboundHandler): void;
}

// ---------------------------------------------------------------------------
// Session key resolver
// ---------------------------------------------------------------------------

export interface SessionKeyResolver {
  /**
   * Deterministic session key from inbound envelope.
   *
   * DM:     "agent:main:main"  (DMs collapse to main session)
   * Group:  "agent:main:<channel>:group:<peerId>"
   * Thread: "agent:main:<channel>:group:<peerId>:topic:<threadId>"
   */
  resolve(envelope: InboundEnvelope): string;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface PairingRequest {
  code: string;
  channelType: ChannelType;
  senderId: string;
  senderName: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface PairingStore {
  createPairing(channelType: ChannelType, senderId: string, senderName: string | null): PairingRequest | null;
  approvePairing(channelType: ChannelType, code: string): boolean;
  rejectPairing(channelType: ChannelType, code: string): boolean;
  listPending(channelType?: ChannelType): PairingRequest[];
  isApproved(channelType: ChannelType, senderId: string): boolean;
  addToAllowlist(channelType: ChannelType, senderId: string): void;
  isAllowlistEmpty(channelType: ChannelType): boolean;
  listApproved(channelType: ChannelType): string[];
}

// ---------------------------------------------------------------------------
// Gateway core callbacks — how GatewayCore communicates back to the channel
// ---------------------------------------------------------------------------

export interface GatewayCoreCallbacks {
  /** Send text to the originating peer. */
  sendText(envelope: InboundEnvelope, text: string, opts?: SendOptions): Promise<void>;
  /** Send image to the originating peer. */
  sendImage(envelope: InboundEnvelope, imagePath: string, caption?: string): Promise<void>;
  /** Send file to the originating peer. */
  sendFile(envelope: InboundEnvelope, filePath: string, caption?: string): Promise<void>;
  /** Send voice/audio to the originating peer. */
  sendVoice(envelope: InboundEnvelope, voicePath: string, caption?: string): Promise<void>;
  /** Set typing indicator on the originating channel. */
  setTypingIndicator(envelope: InboundEnvelope, active: boolean): Promise<void>;
  /** Request user decision on the originating channel. */
  requestUserDecision(envelope: InboundEnvelope, request: UserDecisionRequest): Promise<UserDecisionResponse>;
  /** Request user input on the originating channel. */
  requestUserInput(envelope: InboundEnvelope, request: UserInputRequest): Promise<UserInputResponse>;
  /** Send human-auth escalation. */
  sendHumanAuthEscalation(envelope: InboundEnvelope, htmlBody: string, openUrl?: string): Promise<void>;
  /** Get capabilities of the originating channel. */
  getCapabilities(envelope: InboundEnvelope): ChannelCapabilities;
}

// ---------------------------------------------------------------------------
// Channel config (per-channel config block in OpenPocketConfig)
// ---------------------------------------------------------------------------

export interface ChannelDefaults {
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
}

export interface TelegramChannelConfig {
  enabled?: boolean;
  botToken?: string;
  botTokenEnv?: string;
  dmPolicy?: DmPolicy;
  groupPolicy?: GroupPolicy;
  allowFrom?: string[];
  pollTimeoutSec?: number;
}

export interface DiscordChannelConfig {
  enabled?: boolean;
  token?: string;
  tokenEnv?: string;
  dmPolicy?: DmPolicy;
  groupPolicy?: GroupPolicy;
  allowFrom?: string[];
  guilds?: Record<string, DiscordGuildConfig>;
  /** Emoji sent as ack when a message is received (e.g. "👀"). Empty string disables. */
  ackReaction?: string;
  /** Register native slash commands on startup. Default: true when token is present. */
  slashCommands?: boolean;
}

export interface DiscordGuildConfig {
  requireMention?: boolean;
  /** Allowed user IDs. If set, only these users can interact in this guild. */
  users?: string[];
  /** Allowed role IDs. If set, users with any of these roles are allowed. Checked OR with users[]. */
  roles?: string[];
  /** Per-channel allowlist. If set, only listed channels are allowed. Key is channel ID. */
  channels?: Record<string, { allow?: boolean; requireMention?: boolean }>;
}

export interface WhatsAppChannelConfig {
  enabled?: boolean;
  dmPolicy?: DmPolicy;
  groupPolicy?: GroupPolicy;
  allowFrom?: string[];
  /** Allowed group JIDs (digits-only form). When empty + groupPolicy is "open", all groups are allowed. */
  allowGroups?: string[];
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  sendReadReceipts?: boolean;
  /** HTTP/SOCKS proxy URL for Baileys WebSocket connection (e.g. "http://127.0.0.1:7897") */
  proxyUrl?: string;
}

export interface IMessageChannelConfig {
  enabled?: boolean;
  dmPolicy?: DmPolicy;
  groupPolicy?: GroupPolicy;
  allowFrom?: string[];
  /** Polling interval in seconds for checking new messages in chat.db. Default: 3 */
  pollIntervalSec?: number;
  /** Path to chat.db. Default: ~/Library/Messages/chat.db */
  chatDbPath?: string;
}

export interface SlackChannelConfig {
  enabled?: boolean;
  /** Bot User OAuth Token (xoxb-...). */
  botToken?: string;
  /** Env var name for bot token. Default: SLACK_BOT_TOKEN */
  botTokenEnv?: string;
  /** App-Level Token for Socket Mode (xapp-...). */
  appToken?: string;
  /** Env var name for app token. Default: SLACK_APP_TOKEN */
  appTokenEnv?: string;
  /** Signing Secret for HTTP verification (only used if not using socket mode). */
  signingSecret?: string;
  /** Env var name for signing secret. Default: SLACK_SIGNING_SECRET */
  signingSecretEnv?: string;
  dmPolicy?: DmPolicy;
  groupPolicy?: GroupPolicy;
  allowFrom?: string[];
  /** Allowed channel IDs. When empty + groupPolicy is "open", all channels are allowed. */
  allowChannels?: string[];
  /** Emoji sent as ack when a message is received (e.g. "eyes"). Empty string disables. */
  ackReaction?: string;
  /** Register slash commands on startup. Default: true */
  slashCommands?: boolean;
  /** HTTP/SOCKS proxy URL for Slack WebSocket connection (e.g. "http://127.0.0.1:7897") */
  proxyUrl?: string;
}

export interface ChannelsConfig {
  defaults?: ChannelDefaults;
  telegram?: TelegramChannelConfig;
  discord?: DiscordChannelConfig;
  whatsapp?: WhatsAppChannelConfig;
  imessage?: IMessageChannelConfig;
  slack?: SlackChannelConfig;
}

export interface PairingConfig {
  codeLength?: number;
  expiresAfterSec?: number;
  maxPendingPerChannel?: number;
  stateDir?: string;
}
