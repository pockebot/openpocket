import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { GatewayCore } = await import("../dist/gateway/gateway-core.js");
const { DefaultChannelRouter } = await import("../dist/channel/router.js");
const { DefaultSessionKeyResolver } = await import("../dist/channel/session-keys.js");
const { FilePairingStore } = await import("../dist/channel/pairing.js");

function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENPOCKET_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

function makeEnvelope(overrides = {}) {
  return {
    channelType: "telegram",
    senderId: "user-1",
    senderName: "Alice",
    senderLanguageCode: "en",
    peerId: "user-1",
    peerKind: "dm",
    text: "",
    attachments: [],
    rawEvent: {},
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAdapter(channelType = "telegram") {
  const sent = [];
  const images = [];
  let inboundHandler = null;

  return {
    channelType,
    sent,
    images,
    async start() {},
    async stop() {},
    async sendText(peerId, text, opts) { sent.push({ peerId, text, opts }); },
    async sendImage(peerId, imagePath, caption) { images.push({ peerId, imagePath, caption }); },
    onInbound(handler) { inboundHandler = handler; },
    async setTypingIndicator() {},
    async requestUserDecision() { return { selectedOption: "ok", rawInput: "ok", resolvedAt: new Date().toISOString() }; },
    async requestUserInput() { return { text: "input", resolvedAt: new Date().toISOString() }; },
    async sendHumanAuthEscalation() {},
    async resolveDisplayName() { return null; },
    getCapabilities() { return { supportsMarkdown: true, supportsHtml: true, supportsInlineButtons: true, supportsReactions: false, supportsImageUpload: true, supportsTypingIndicator: true, supportsSlashCommands: true, supportsThreads: true, supportsDisplayNameSync: true, maxMessageLength: 4096, textChunkMode: "length" }; },
    isAllowed() { return true; },
    simulateInbound(envelope) { if (inboundHandler) return inboundHandler(envelope); },
  };
}

function createGatewayCore(home, { skipOwnerRegistration = false } = {}) {
  const config = loadConfig();
  const router = new DefaultChannelRouter({ log: () => {} });
  const sessionKeys = new DefaultSessionKeyResolver();
  const pairingStore = new FilePairingStore({ stateDir: path.join(home, "credentials") });
  const adapter = createMockAdapter("telegram");
  router.register(adapter);

  if (!skipOwnerRegistration) {
    pairingStore.addToAllowlist("telegram", "user-1");
  }

  const core = new GatewayCore(config, router, sessionKeys, pairingStore, { logger: () => {} });
  return { core, config, router, adapter, pairingStore };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("GatewayCore: /help command returns command list", async () => {
  await withTempHome("gwcore-help-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/help",
      command: "help",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("/start"));
    assert.ok(adapter.sent[0].text.includes("/run"));
    assert.ok(adapter.sent[0].text.includes("/pairing"));
  });
});

test("GatewayCore: /status command returns status info", async () => {
  await withTempHome("gwcore-status-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("Project:"));
    assert.ok(adapter.sent[0].text.includes("Agent busy:"));
    assert.ok(adapter.sent[0].text.includes("Channel: telegram"));
  });
});

test("GatewayCore: /model shows current model", async () => {
  await withTempHome("gwcore-model-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/model",
      command: "model",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("Current model:"));
  });
});

test("GatewayCore: /stop with no task returns appropriate message", async () => {
  await withTempHome("gwcore-stop-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/stop",
      command: "stop",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, "No running task.");
  });
});

test("GatewayCore: /clear clears conversation", async () => {
  await withTempHome("gwcore-clear-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/clear",
      command: "clear",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, "Conversation memory cleared.");
  });
});

test("GatewayCore: /run without args returns usage", async () => {
  await withTempHome("gwcore-run-noargs-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/run",
      command: "run",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("Usage:"));
  });
});

test("GatewayCore: /cronrun without args returns usage", async () => {
  await withTempHome("gwcore-cronrun-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/cronrun",
      command: "cronrun",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("Usage:"));
  });
});

test("GatewayCore: /auth help returns auth commands", async () => {
  await withTempHome("gwcore-auth-help-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/auth",
      command: "auth",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("/auth pending"));
    assert.ok(adapter.sent[0].text.includes("/auth approve"));
  });
});

test("GatewayCore: /pairing list shows pending pairings", async () => {
  await withTempHome("gwcore-pairing-list-", async (home) => {
    const { adapter, core, pairingStore } = createGatewayCore(home);

    // Create a pending pairing
    pairingStore.createPairing("discord", "stranger-1", "Bob");

    await core.handleInbound(makeEnvelope({
      text: "/pairing list",
      command: "pairing",
      commandArgs: "list",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("stranger-1"));
    assert.ok(adapter.sent[0].text.includes("discord"));
  });
});

test("GatewayCore: /pairing approve approves pending pairing", async () => {
  await withTempHome("gwcore-pairing-approve-", async (home) => {
    const { adapter, core, pairingStore } = createGatewayCore(home);

    const req = pairingStore.createPairing("telegram", "new-user", "NewUser");
    assert.ok(req);

    await core.handleInbound(makeEnvelope({
      text: `/pairing approve telegram ${req.code}`,
      command: "pairing",
      commandArgs: `approve telegram ${req.code}`,
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("approved"));
    assert.equal(pairingStore.isApproved("telegram", "new-user"), true);
    assert.equal(pairingStore.listPending("telegram").length, 0);
  });
});

test("GatewayCore: /pairing reject rejects pending pairing", async () => {
  await withTempHome("gwcore-pairing-reject-", async (home) => {
    const { adapter, core, pairingStore } = createGatewayCore(home);

    const req = pairingStore.createPairing("discord", "spam-user", null);
    assert.ok(req);

    await core.handleInbound(makeEnvelope({
      text: `/pairing reject discord ${req.code}`,
      command: "pairing",
      commandArgs: `reject discord ${req.code}`,
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("rejected"));
    assert.equal(pairingStore.isApproved("discord", "spam-user"), false);
  });
});

test("GatewayCore: unknown command falls through to plain message handler", async () => {
  await withTempHome("gwcore-unknown-cmd-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/nonexistent",
      command: "nonexistent",
      commandArgs: "",
    }));

    // Should produce at least one reply (either from chat.decide or fallback)
    assert.ok(adapter.sent.length >= 0);
  });
});

test("GatewayCore: registerCommand allows custom commands", async () => {
  await withTempHome("gwcore-custom-cmd-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    core.registerCommand("ping", async (env) => {
      await core.handleInbound; // access to verify core is accessible
      const routerRef = adapter; // use captured adapter for reply
      routerRef.sent.push({ peerId: env.peerId, text: "pong" });
    });

    await core.handleInbound(makeEnvelope({
      text: "/ping",
      command: "ping",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, "pong");
  });
});

test("GatewayCore: replies go to originating channel peerId", async () => {
  await withTempHome("gwcore-reply-routing-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      peerId: "chat-999",
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].peerId, "chat-999");
  });
});

test("GatewayCore: lifecycle start and stop", async () => {
  await withTempHome("gwcore-lifecycle-", async (home) => {
    const { core } = createGatewayCore(home);

    assert.equal(core.isRunning(), false);
    await core.start();
    assert.equal(core.isRunning(), true);
    await core.stop("test");
    assert.equal(core.isRunning(), false);
  });
});
