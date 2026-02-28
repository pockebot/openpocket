import type { ChannelCapabilities, ChannelType } from "./types.js";

const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: true,
  supportsHtml: true,
  supportsInlineButtons: true,
  supportsReactions: false,
  supportsImageUpload: true,
  supportsTypingIndicator: true,
  supportsSlashCommands: true,
  supportsThreads: true,
  supportsDisplayNameSync: true,
  maxMessageLength: 4096,
  textChunkMode: "length",
};

const DISCORD_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: true,
  supportsHtml: false,
  supportsInlineButtons: true,
  supportsReactions: true,
  supportsImageUpload: true,
  supportsTypingIndicator: true,
  supportsSlashCommands: true,
  supportsThreads: true,
  supportsDisplayNameSync: false,
  maxMessageLength: 2000,
  textChunkMode: "length",
};

const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: false,
  supportsHtml: false,
  supportsInlineButtons: false,
  supportsReactions: true,
  supportsImageUpload: true,
  supportsTypingIndicator: true,
  supportsSlashCommands: false,
  supportsThreads: false,
  supportsDisplayNameSync: false,
  maxMessageLength: 4000,
  textChunkMode: "newline",
};

const SIGNAL_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: false,
  supportsHtml: false,
  supportsInlineButtons: false,
  supportsReactions: true,
  supportsImageUpload: true,
  supportsTypingIndicator: true,
  supportsSlashCommands: false,
  supportsThreads: false,
  supportsDisplayNameSync: false,
  maxMessageLength: 6000,
  textChunkMode: "length",
};

const SLACK_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: true,
  supportsHtml: false,
  supportsInlineButtons: true,
  supportsReactions: true,
  supportsImageUpload: true,
  supportsTypingIndicator: true,
  supportsSlashCommands: true,
  supportsThreads: true,
  supportsDisplayNameSync: false,
  maxMessageLength: 4000,
  textChunkMode: "length",
};

const WECHAT_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: false,
  supportsHtml: false,
  supportsInlineButtons: false,
  supportsReactions: false,
  supportsImageUpload: true,
  supportsTypingIndicator: false,
  supportsSlashCommands: false,
  supportsThreads: false,
  supportsDisplayNameSync: false,
  maxMessageLength: 2048,
  textChunkMode: "length",
};

const QQ_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: true,
  supportsHtml: false,
  supportsInlineButtons: false,
  supportsReactions: true,
  supportsImageUpload: true,
  supportsTypingIndicator: false,
  supportsSlashCommands: false,
  supportsThreads: false,
  supportsDisplayNameSync: false,
  maxMessageLength: 4000,
  textChunkMode: "length",
};

const IMESSAGE_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: false,
  supportsHtml: false,
  supportsInlineButtons: false,
  supportsReactions: true,
  supportsImageUpload: true,
  supportsTypingIndicator: true,
  supportsSlashCommands: false,
  supportsThreads: false,
  supportsDisplayNameSync: false,
  maxMessageLength: 20000,
  textChunkMode: "newline",
};

const CAPABILITIES_MAP: Record<ChannelType, ChannelCapabilities> = {
  telegram: TELEGRAM_CAPABILITIES,
  discord: DISCORD_CAPABILITIES,
  whatsapp: WHATSAPP_CAPABILITIES,
  imessage: IMESSAGE_CAPABILITIES,
  signal: SIGNAL_CAPABILITIES,
  slack: SLACK_CAPABILITIES,
  wechat: WECHAT_CAPABILITIES,
  qq: QQ_CAPABILITIES,
};

export function getDefaultCapabilities(channelType: ChannelType): ChannelCapabilities {
  return { ...CAPABILITIES_MAP[channelType] };
}
