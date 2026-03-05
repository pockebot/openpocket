import assert from "node:assert/strict";
import test from "node:test";

const { DefaultSessionKeyResolver } = await import("../dist/channel/session-keys.js");
const { DefaultChannelRouter } = await import("../dist/channel/router.js");
const { getDefaultCapabilities } = await import("../dist/channel/capabilities.js");

// ---------------------------------------------------------------------------
// Helpers: minimal mock adapter
// ---------------------------------------------------------------------------

function makeEnvelope(overrides = {}) {
  return {
    channelType: "telegram",
    senderId: "user-1",
    senderName: "Alice",
    senderLanguageCode: "en",
    peerId: "user-1",
    peerKind: "dm",
    text: "hello",
    attachments: [],
    rawEvent: {},
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAdapter(channelType = "telegram") {
  const sent = [];
  const images = [];
  const files = [];
  const voices = [];
  let inboundHandler = null;
  let started = false;
  let stopped = false;

  return {
    channelType,
    sent,
    images,
    files,
    voices,
    get started() { return started; },
    get stopped() { return stopped; },

    async start() { started = true; },
    async stop() { stopped = true; },

    async sendText(peerId, text, opts) {
      sent.push({ peerId, text, opts });
    },
    async sendImage(peerId, imagePath, caption) {
      images.push({ peerId, imagePath, caption });
    },
    async sendFile(peerId, filePath, caption) {
      files.push({ peerId, filePath, caption });
    },
    async sendVoice(peerId, voicePath, caption) {
      voices.push({ peerId, voicePath, caption });
    },

    onInbound(handler) { inboundHandler = handler; },

    async setTypingIndicator() {},
    async requestUserDecision() { return { selectedOption: "ok", rawInput: "ok", resolvedAt: new Date().toISOString() }; },
    async requestUserInput() { return { text: "input", resolvedAt: new Date().toISOString() }; },
    async sendHumanAuthEscalation() {},
    async resolveDisplayName() { return null; },
    getCapabilities() { return getDefaultCapabilities(channelType); },
    isAllowed() { return true; },

    simulateInbound(envelope) {
      if (inboundHandler) return inboundHandler(envelope);
    },
  };
}

// ---------------------------------------------------------------------------
// SessionKeyResolver tests
// ---------------------------------------------------------------------------

test("SessionKeyResolver: DM resolves to agent:main:main", () => {
  const resolver = new DefaultSessionKeyResolver();
  const key = resolver.resolve(makeEnvelope({ peerKind: "dm" }));
  assert.equal(key, "agent:main:main");
});

test("SessionKeyResolver: DM with custom agentId", () => {
  const resolver = new DefaultSessionKeyResolver("support");
  const key = resolver.resolve(makeEnvelope({ peerKind: "dm" }));
  assert.equal(key, "agent:support:main");
});

test("SessionKeyResolver: group resolves with channel and peerId", () => {
  const resolver = new DefaultSessionKeyResolver();
  const key = resolver.resolve(makeEnvelope({
    peerKind: "group",
    channelType: "discord",
    peerId: "guild-123",
  }));
  assert.equal(key, "agent:main:discord:group:guild-123");
});

test("SessionKeyResolver: thread resolves with topic", () => {
  const resolver = new DefaultSessionKeyResolver();
  const key = resolver.resolve(makeEnvelope({
    peerKind: "thread",
    channelType: "telegram",
    peerId: "group-456",
    threadId: "topic-99",
  }));
  assert.equal(key, "agent:main:telegram:group:group-456:topic:topic-99");
});

test("SessionKeyResolver: thread without threadId falls back to group key", () => {
  const resolver = new DefaultSessionKeyResolver();
  const key = resolver.resolve(makeEnvelope({
    peerKind: "thread",
    channelType: "telegram",
    peerId: "group-456",
  }));
  assert.equal(key, "agent:main:telegram:group:group-456");
});

test("SessionKeyResolver: different channels produce different keys", () => {
  const resolver = new DefaultSessionKeyResolver();
  const tgKey = resolver.resolve(makeEnvelope({ peerKind: "group", channelType: "telegram", peerId: "g1" }));
  const dcKey = resolver.resolve(makeEnvelope({ peerKind: "group", channelType: "discord", peerId: "g1" }));
  assert.notEqual(tgKey, dcKey);
});

// ---------------------------------------------------------------------------
// ChannelRouter tests
// ---------------------------------------------------------------------------

test("ChannelRouter: register and get adapter", () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const adapter = createMockAdapter("telegram");
  router.register(adapter);

  assert.equal(router.getAdapter("telegram"), adapter);
  assert.equal(router.getAdapter("discord"), null);
  assert.equal(router.getAllAdapters().length, 1);
});

test("ChannelRouter: register multiple adapters", () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  router.register(createMockAdapter("telegram"));
  router.register(createMockAdapter("discord"));
  router.register(createMockAdapter("whatsapp"));

  assert.equal(router.getAllAdapters().length, 3);
  assert.ok(router.getAdapter("telegram"));
  assert.ok(router.getAdapter("discord"));
  assert.ok(router.getAdapter("whatsapp"));
});

test("ChannelRouter: replace adapter for same channelType", () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const adapter1 = createMockAdapter("telegram");
  const adapter2 = createMockAdapter("telegram");
  router.register(adapter1);
  router.register(adapter2);

  assert.equal(router.getAdapter("telegram"), adapter2);
  assert.equal(router.getAllAdapters().length, 1);
});

test("ChannelRouter: startAll starts all adapters", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  const dc = createMockAdapter("discord");
  router.register(tg);
  router.register(dc);

  await router.startAll();
  assert.equal(tg.started, true);
  assert.equal(dc.started, true);
});

test("ChannelRouter: stopAll stops all adapters", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  const dc = createMockAdapter("discord");
  router.register(tg);
  router.register(dc);

  await router.startAll();
  await router.stopAll("test");
  assert.equal(tg.stopped, true);
  assert.equal(dc.stopped, true);
});

test("ChannelRouter: replyText routes to originating channel", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  const dc = createMockAdapter("discord");
  router.register(tg);
  router.register(dc);

  const envelope = makeEnvelope({ channelType: "telegram", peerId: "chat-42" });
  await router.replyText(envelope, "hello back");

  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].peerId, "chat-42");
  assert.equal(tg.sent[0].text, "hello back");
  assert.equal(dc.sent.length, 0);
});

test("ChannelRouter: replyImage routes to originating channel", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  const dc = createMockAdapter("discord");
  router.register(tg);
  router.register(dc);

  const envelope = makeEnvelope({ channelType: "discord", peerId: "channel-99" });
  await router.replyImage(envelope, "/tmp/screen.png", "screenshot");

  assert.equal(dc.images.length, 1);
  assert.equal(dc.images[0].peerId, "channel-99");
  assert.equal(dc.images[0].caption, "screenshot");
  assert.equal(tg.images.length, 0);
});

test("ChannelRouter: replyFile routes to originating channel", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  const dc = createMockAdapter("discord");
  router.register(tg);
  router.register(dc);

  const envelope = makeEnvelope({ channelType: "discord", peerId: "channel-99" });
  await router.replyFile(envelope, "/tmp/report.pdf", "report");

  assert.equal(dc.files.length, 1);
  assert.equal(dc.files[0].peerId, "channel-99");
  assert.equal(dc.files[0].caption, "report");
  assert.equal(tg.files.length, 0);
});

test("ChannelRouter: replyVoice routes to originating channel", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  const dc = createMockAdapter("discord");
  router.register(tg);
  router.register(dc);

  const envelope = makeEnvelope({ channelType: "telegram", peerId: "chat-42" });
  await router.replyVoice(envelope, "/tmp/voice.ogg", "voice");

  assert.equal(tg.voices.length, 1);
  assert.equal(tg.voices[0].peerId, "chat-42");
  assert.equal(tg.voices[0].caption, "voice");
  assert.equal(dc.voices.length, 0);
});

test("ChannelRouter: replyText to unregistered channel is no-op", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const envelope = makeEnvelope({ channelType: "whatsapp", peerId: "phone-1" });
  // Should not throw
  await router.replyText(envelope, "test");
});

test("ChannelRouter: inbound handler receives messages from adapters", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  router.register(tg);

  const received = [];
  router.onInbound((env) => { received.push(env); });

  const envelope = makeEnvelope({ text: "user message" });
  await tg.simulateInbound(envelope);

  assert.equal(received.length, 1);
  assert.equal(received[0].text, "user message");
});

test("ChannelRouter: inbound from multiple adapters routes to single handler", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  const dc = createMockAdapter("discord");
  router.register(tg);
  router.register(dc);

  const received = [];
  router.onInbound((env) => { received.push(env); });

  await tg.simulateInbound(makeEnvelope({ channelType: "telegram", text: "from tg" }));
  await dc.simulateInbound(makeEnvelope({ channelType: "discord", text: "from dc" }));

  assert.equal(received.length, 2);
  assert.equal(received[0].channelType, "telegram");
  assert.equal(received[1].channelType, "discord");
});

test("ChannelRouter: inbound without handler does not throw", async () => {
  const router = new DefaultChannelRouter({ log: () => {} });
  const tg = createMockAdapter("telegram");
  router.register(tg);

  // No handler registered — should not throw
  await tg.simulateInbound(makeEnvelope());
});

// ---------------------------------------------------------------------------
// Capabilities tests
// ---------------------------------------------------------------------------

test("getDefaultCapabilities returns Telegram capabilities", () => {
  const caps = getDefaultCapabilities("telegram");
  assert.equal(caps.supportsMarkdown, true);
  assert.equal(caps.supportsHtml, true);
  assert.equal(caps.supportsInlineButtons, true);
  assert.equal(caps.supportsFileUpload, true);
  assert.equal(caps.supportsVoiceUpload, true);
  assert.equal(caps.maxMessageLength, 4096);
});

test("getDefaultCapabilities returns Discord capabilities", () => {
  const caps = getDefaultCapabilities("discord");
  assert.equal(caps.supportsMarkdown, true);
  assert.equal(caps.supportsHtml, false);
  assert.equal(caps.supportsReactions, true);
  assert.equal(caps.supportsSlashCommands, true);
  assert.equal(caps.maxMessageLength, 2000);
});

test("getDefaultCapabilities returns WhatsApp capabilities", () => {
  const caps = getDefaultCapabilities("whatsapp");
  assert.equal(caps.supportsMarkdown, false);
  assert.equal(caps.supportsInlineButtons, false);
  assert.equal(caps.supportsReactions, true);
  assert.equal(caps.textChunkMode, "newline");
  assert.equal(caps.maxMessageLength, 4000);
});

test("getDefaultCapabilities returns a copy (not shared reference)", () => {
  const caps1 = getDefaultCapabilities("telegram");
  const caps2 = getDefaultCapabilities("telegram");
  caps1.maxMessageLength = 999;
  assert.equal(caps2.maxMessageLength, 4096);
});
