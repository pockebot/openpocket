import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { WhatsAppAdapter } = await import("../dist/channel/whatsapp/adapter.js");

function makeMinimalConfig(home) {
  return {
    projectName: "test-project",
    defaultModel: "test-model",
    stateDir: path.join(home, "state"),
    workspaceDir: home,
    target: { type: "emulator" },
    models: { "test-model": { provider: "openai", model: "test", apiKey: "fake" } },
    telegram: {
      botToken: "",
      botTokenEnv: "",
      pollTimeoutSec: 30,
      allowedChatIds: [],
    },
    humanAuth: { enabled: false, useLocalRelay: false },
    agent: { deviceId: "" },
    cron: { jobs: [] },
  };
}

function makeWaConfig(overrides = {}) {
  return {
    enabled: true,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 4000,
    chunkMode: "newline",
    sendReadReceipts: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Construction and channelType
// ---------------------------------------------------------------------------

test("WhatsAppAdapter: channelType is whatsapp", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-type-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig(), { logger: () => {} });
  assert.equal(adapter.channelType, "whatsapp");
});

test("WhatsAppAdapter: getCapabilities returns WhatsApp capabilities", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-caps-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig(), { logger: () => {} });
  const caps = adapter.getCapabilities();
  assert.equal(caps.supportsMarkdown, false);
  assert.equal(caps.supportsHtml, false);
  assert.equal(caps.supportsInlineButtons, false);
  assert.equal(caps.supportsReactions, true);
  assert.equal(caps.supportsImageUpload, true);
  assert.equal(caps.supportsTypingIndicator, true);
  assert.equal(caps.supportsSlashCommands, false);
  assert.equal(caps.supportsThreads, false);
  assert.equal(caps.maxMessageLength, 4000);
  assert.equal(caps.textChunkMode, "newline");
});

// ---------------------------------------------------------------------------
// Access control: isAllowed
// ---------------------------------------------------------------------------

test("WhatsAppAdapter: isAllowed returns true when no allowlist", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-allow-all-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig({ allowFrom: [] }), { logger: () => {} });
  assert.equal(adapter.isAllowed("1234567890"), true);
  assert.equal(adapter.isAllowed("0987654321"), true);
});

test("WhatsAppAdapter: isAllowed with wildcard allows all", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-allow-wild-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig({ allowFrom: ["*"] }), { logger: () => {} });
  assert.equal(adapter.isAllowed("anyone"), true);
});

test("WhatsAppAdapter: isAllowed filters by phone number", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-allow-filter-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(
    config,
    makeWaConfig({ allowFrom: ["1234567890", "0987654321"] }),
    { logger: () => {} },
  );
  assert.equal(adapter.isAllowed("1234567890"), true);
  assert.equal(adapter.isAllowed("0987654321"), true);
  assert.equal(adapter.isAllowed("5555555555"), false);
});

test("WhatsAppAdapter: isAllowed normalizes JID format", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-allow-jid-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(
    config,
    makeWaConfig({ allowFrom: ["1234567890"] }),
    { logger: () => {} },
  );
  assert.equal(adapter.isAllowed("1234567890@s.whatsapp.net"), true);
  assert.equal(adapter.isAllowed("+1234567890"), true);
  assert.equal(adapter.isAllowed("9999999999@s.whatsapp.net"), false);
});

// ---------------------------------------------------------------------------
// onInbound handler registration
// ---------------------------------------------------------------------------

test("WhatsAppAdapter: onInbound stores handler", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-inbound-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig(), { logger: () => {} });
  let called = false;
  adapter.onInbound(() => { called = true; });
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

test("WhatsAppAdapter: uses default textChunkLimit when not specified", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-defaults-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig({ textChunkLimit: undefined }), { logger: () => {} });
  assert.equal(adapter.channelType, "whatsapp");
});

test("WhatsAppAdapter: custom textChunkLimit is respected", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-custom-chunk-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig({ textChunkLimit: 2000 }), { logger: () => {} });
  assert.equal(adapter.channelType, "whatsapp");
});

test("WhatsAppAdapter: chunkMode can be set to length", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-chunk-length-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig({ chunkMode: "length" }), { logger: () => {} });
  assert.equal(adapter.channelType, "whatsapp");
});

test("WhatsAppAdapter: stop is idempotent before start", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wa-stop-idle-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new WhatsAppAdapter(config, makeWaConfig(), { logger: () => {} });
  await adapter.stop("test");
  assert.equal(adapter.channelType, "whatsapp");
});
