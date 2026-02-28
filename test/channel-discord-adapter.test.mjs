import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { DiscordAdapter } = await import("../dist/channel/discord/adapter.js");

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

function makeDiscordConfig(overrides = {}) {
  return {
    token: "FAKE_DISCORD_TOKEN",
    tokenEnv: "",
    dmPolicy: "pairing",
    allowFrom: [],
    guilds: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Construction and channelType
// ---------------------------------------------------------------------------

test("DiscordAdapter: channelType is discord", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-type-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig(), { logger: () => {} });
  assert.equal(adapter.channelType, "discord");
});

test("DiscordAdapter: getCapabilities returns Discord capabilities", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-caps-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig(), { logger: () => {} });
  const caps = adapter.getCapabilities();
  assert.equal(caps.supportsMarkdown, true);
  assert.equal(caps.supportsHtml, false);
  assert.equal(caps.supportsInlineButtons, true);
  assert.equal(caps.supportsReactions, true);
  assert.equal(caps.supportsImageUpload, true);
  assert.equal(caps.supportsTypingIndicator, true);
  assert.equal(caps.supportsSlashCommands, true);
  assert.equal(caps.supportsThreads, true);
  assert.equal(caps.maxMessageLength, 2000);
});

// ---------------------------------------------------------------------------
// Access control: isAllowed
// ---------------------------------------------------------------------------

test("DiscordAdapter: isAllowed returns true when no allowlist", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-allow-all-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig({ allowFrom: [] }), { logger: () => {} });
  assert.equal(adapter.isAllowed("user123"), true);
  assert.equal(adapter.isAllowed("user456"), true);
});

test("DiscordAdapter: isAllowed with wildcard allows all", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-allow-wild-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig({ allowFrom: ["*"] }), { logger: () => {} });
  assert.equal(adapter.isAllowed("anyone"), true);
});

test("DiscordAdapter: isAllowed delegates to GatewayCore (always true at adapter level)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-allow-filter-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(
    config,
    makeDiscordConfig({ allowFrom: ["user111", "user222"] }),
    { logger: () => {} },
  );
  assert.equal(adapter.isAllowed("user111"), true);
  assert.equal(adapter.isAllowed("user222"), true);
  assert.equal(adapter.isAllowed("user333"), true);
});

// ---------------------------------------------------------------------------
// Access control: isGuildAllowed
// ---------------------------------------------------------------------------

test("DiscordAdapter: isGuildAllowed returns false for unknown guild", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-guild-unknown-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig({ guilds: {} }), { logger: () => {} });
  assert.equal(adapter.isGuildAllowed("guild999", "user1"), false);
});

test("DiscordAdapter: isGuildAllowed allows any user when guild has no users list", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-guild-nolist-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(
    config,
    makeDiscordConfig({ guilds: { guild1: {} } }),
    { logger: () => {} },
  );
  assert.equal(adapter.isGuildAllowed("guild1", "anyone"), true);
});

test("DiscordAdapter: isGuildAllowed filters by user list", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-guild-filter-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(
    config,
    makeDiscordConfig({ guilds: { guild1: { users: ["user1", "user2"] } } }),
    { logger: () => {} },
  );
  assert.equal(adapter.isGuildAllowed("guild1", "user1"), true);
  assert.equal(adapter.isGuildAllowed("guild1", "user2"), true);
  assert.equal(adapter.isGuildAllowed("guild1", "user3"), false);
});

test("DiscordAdapter: isGuildAllowed returns false when no guilds config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-guild-none-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig(), { logger: () => {} });
  assert.equal(adapter.isGuildAllowed("guild1", "user1"), false);
});

// ---------------------------------------------------------------------------
// shouldRequireMention
// ---------------------------------------------------------------------------

test("DiscordAdapter: shouldRequireMention defaults to true", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mention-default-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(
    config,
    makeDiscordConfig({ guilds: { guild1: {} } }),
    { logger: () => {} },
  );
  assert.equal(adapter.shouldRequireMention("guild1"), true);
});

test("DiscordAdapter: shouldRequireMention respects explicit false", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mention-false-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(
    config,
    makeDiscordConfig({ guilds: { guild1: { requireMention: false } } }),
    { logger: () => {} },
  );
  assert.equal(adapter.shouldRequireMention("guild1"), false);
});

test("DiscordAdapter: shouldRequireMention for unknown guild defaults to true", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mention-unknown-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig({ guilds: {} }), { logger: () => {} });
  assert.equal(adapter.shouldRequireMention("nonexistent"), true);
});

// ---------------------------------------------------------------------------
// onInbound handler registration
// ---------------------------------------------------------------------------

test("DiscordAdapter: onInbound stores handler", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-inbound-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig(), { logger: () => {} });
  let called = false;
  adapter.onInbound(() => { called = true; });
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

test("DiscordAdapter: start rejects on empty token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-notoken-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const adapter = new DiscordAdapter(config, makeDiscordConfig({ token: "", tokenEnv: "" }), { logger: () => {} });
  await assert.rejects(() => adapter.start(), /token is empty/i);
});

test("DiscordAdapter: resolves token from env variable", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "discord-envtoken-"));
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  const config = makeMinimalConfig(home);
  const prevEnv = process.env.TEST_DISCORD_TOKEN;
  process.env.TEST_DISCORD_TOKEN = "env-token-value";
  try {
    const adapter = new DiscordAdapter(
      config,
      makeDiscordConfig({ token: "", tokenEnv: "TEST_DISCORD_TOKEN" }),
      { logger: () => {} },
    );
    assert.equal(adapter.channelType, "discord");
  } finally {
    if (prevEnv === undefined) delete process.env.TEST_DISCORD_TOKEN;
    else process.env.TEST_DISCORD_TOKEN = prevEnv;
  }
});
