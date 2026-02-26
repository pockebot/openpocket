import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { TelegramAdapter, TELEGRAM_MENU_COMMANDS } = await import("../dist/channel/telegram/adapter.js");

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

function makeMinimalConfig(home) {
  return {
    projectName: "test-project",
    defaultModel: "test-model",
    stateDir: path.join(home, "state"),
    workspaceDir: home,
    target: { type: "emulator" },
    models: { "test-model": { provider: "openai", model: "test", apiKey: "fake" } },
    telegram: {
      botToken: "FAKE_TOKEN_12345",
      botTokenEnv: "",
      pollTimeoutSec: 30,
      allowedChatIds: [],
    },
    humanAuth: { enabled: false, useLocalRelay: false },
    agent: { deviceId: "" },
    cron: { jobs: [] },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("TELEGRAM_MENU_COMMANDS has expected commands", () => {
  const names = TELEGRAM_MENU_COMMANDS.map((cmd) => cmd.command);
  assert.ok(names.includes("start"));
  assert.ok(names.includes("help"));
  assert.ok(names.includes("status"));
  assert.ok(names.includes("run"));
  assert.ok(names.includes("stop"));
  assert.ok(names.includes("screen"));
  assert.ok(names.length >= 15, `Expected at least 15 commands, got ${names.length}`);
});

test("TelegramAdapter: channelType is telegram", () => {
  withTempHome("tg-type-", (home) => {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    const config = makeMinimalConfig(home);
    const adapter = new TelegramAdapter(config, { logger: () => {} });
    assert.equal(adapter.channelType, "telegram");
  });
});

test("TelegramAdapter: throws on empty bot token", () => {
  withTempHome("tg-notoken-", (home) => {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    const config = makeMinimalConfig(home);
    config.telegram.botToken = "";
    assert.throws(() => new TelegramAdapter(config, { logger: () => {} }), /token is empty/i);
  });
});

test("TelegramAdapter: getCapabilities returns Telegram capabilities", () => {
  withTempHome("tg-caps-", (home) => {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    const config = makeMinimalConfig(home);
    const adapter = new TelegramAdapter(config, { logger: () => {} });
    const caps = adapter.getCapabilities();
    assert.equal(caps.supportsMarkdown, true);
    assert.equal(caps.supportsHtml, true);
    assert.equal(caps.supportsInlineButtons, true);
    assert.equal(caps.supportsImageUpload, true);
    assert.equal(caps.supportsTypingIndicator, true);
    assert.equal(caps.maxMessageLength, 4096);
  });
});

test("TelegramAdapter: isAllowed returns true when no allowlist", () => {
  withTempHome("tg-allow-all-", (home) => {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    const config = makeMinimalConfig(home);
    const adapter = new TelegramAdapter(config, { logger: () => {} });
    assert.equal(adapter.isAllowed("12345"), true);
    assert.equal(adapter.isAllowed("67890"), true);
  });
});

test("TelegramAdapter: isAllowed filters by allowedChatIds", () => {
  withTempHome("tg-allow-filter-", (home) => {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    const config = makeMinimalConfig(home);
    config.telegram.allowedChatIds = [111, 222];
    const adapter = new TelegramAdapter(config, { logger: () => {} });
    assert.equal(adapter.isAllowed("111"), true);
    assert.equal(adapter.isAllowed("222"), true);
    assert.equal(adapter.isAllowed("333"), false);
    assert.equal(adapter.isAllowed("999"), false);
  });
});

test("TelegramAdapter: onInbound stores handler", () => {
  withTempHome("tg-inbound-", (home) => {
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    const config = makeMinimalConfig(home);
    const adapter = new TelegramAdapter(config, { logger: () => {} });
    let called = false;
    adapter.onInbound(() => { called = true; });
    // Handler is stored but not invoked without actual Telegram messages
    assert.equal(called, false);
  });
});

test("TelegramAdapter: bot display name sync state path", () => {
  withTempHome("tg-syncstate-", (home) => {
    const stateDir = path.join(home, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const config = makeMinimalConfig(home);
    const adapter = new TelegramAdapter(config, { logger: () => {} });
    // Adapter should be created without errors even if state dir is empty
    assert.equal(adapter.channelType, "telegram");
  });
});

test("TelegramAdapter: restores bot display name sync state from file", () => {
  withTempHome("tg-restore-sync-", (home) => {
    const stateDir = path.join(home, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const syncStatePath = path.join(stateDir, "telegram-bot-name-sync.json");
    fs.writeFileSync(syncStatePath, JSON.stringify({
      lastSyncedName: "TestBot",
      retryAfterUntilMs: Date.now() + 999999,
    }), "utf-8");
    const config = makeMinimalConfig(home);
    const adapter = new TelegramAdapter(config, { logger: () => {} });
    // Should not throw when reading existing state
    assert.equal(adapter.channelType, "telegram");
  });
});

test("TelegramAdapter: handles corrupt sync state gracefully", () => {
  withTempHome("tg-corrupt-sync-", (home) => {
    const stateDir = path.join(home, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "telegram-bot-name-sync.json"), "not json at all", "utf-8");
    const config = makeMinimalConfig(home);
    // Should not throw on corrupt state
    const adapter = new TelegramAdapter(config, { logger: () => {} });
    assert.equal(adapter.channelType, "telegram");
  });
});

test("TelegramAdapter: TELEGRAM_MENU_COMMANDS all have descriptions", () => {
  for (const cmd of TELEGRAM_MENU_COMMANDS) {
    assert.ok(cmd.command, "command name must not be empty");
    assert.ok(cmd.description, `command ${cmd.command} must have a description`);
    assert.ok(cmd.description.length > 0, `command ${cmd.command} description must not be empty`);
  }
});
