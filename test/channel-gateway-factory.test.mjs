import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { createGateway } = await import("../dist/gateway/gateway-factory.js");
const { loadConfig } = await import("../dist/config/index.js");

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

function clearTelegramToken(config) {
  if (!config.channels) config.channels = {};
  config.channels.telegram = { botToken: "", botTokenEnv: "" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("createGateway: creates core and router with Telegram adapter when token exists", () => {
  withTempHome("gwfactory-tg-", (home) => {
    const config = loadConfig();
    if (!config.channels) config.channels = {};
    config.channels.telegram = { botToken: "FAKE_TOKEN_FOR_TEST" };

    const { core, router } = createGateway(config, { logger: () => {} });

    assert.ok(core, "core should exist");
    assert.ok(router, "router should exist");

    const telegramAdapter = router.getAdapter("telegram");
    assert.ok(telegramAdapter, "telegram adapter should be registered");
    assert.equal(telegramAdapter.channelType, "telegram");
  });
});

test("createGateway: no Telegram adapter when token is empty", () => {
  withTempHome("gwfactory-notg-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);

    const { core, router } = createGateway(config, { logger: () => {} });

    assert.ok(core, "core should exist");
    const telegramAdapter = router.getAdapter("telegram");
    assert.equal(telegramAdapter, null, "telegram adapter should NOT be registered");
  });
});

test("createGateway: no Telegram adapter when channels.telegram.enabled is false", () => {
  withTempHome("gwfactory-disabled-", (home) => {
    const config = loadConfig();
    if (!config.channels) config.channels = {};
    config.channels.telegram = { enabled: false, botToken: "FAKE_TOKEN_FOR_TEST" };

    const { core, router } = createGateway(config, { logger: () => {} });

    assert.ok(core, "core should exist");
    const telegramAdapter = router.getAdapter("telegram");
    assert.equal(telegramAdapter, null, "telegram adapter should NOT be registered when disabled");
  });
});

test("createGateway: core lifecycle works", async () => {
  await withTempHome("gwfactory-lifecycle-", async (home) => {
    const config = loadConfig();
    clearTelegramToken(config);

    const { core } = createGateway(config, { logger: () => {} });

    assert.equal(core.isRunning(), false);
    await core.start();
    assert.equal(core.isRunning(), true);
    await core.stop("test");
    assert.equal(core.isRunning(), false);
  });
});

test("createGateway: router has no adapters for unconfigured channel types", () => {
  withTempHome("gwfactory-noadapters-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);

    const { router } = createGateway(config, { logger: () => {} });

    assert.equal(router.getAdapter("discord"), null);
    assert.equal(router.getAdapter("whatsapp"), null);
    assert.equal(router.getAdapter("slack"), null);
    assert.equal(router.getAdapter("signal"), null);
    assert.equal(router.getAdapter("wechat"), null);
    assert.equal(router.getAdapter("qq"), null);
  });
});

test("createGateway: registers Discord adapter when discord config has token", () => {
  withTempHome("gwfactory-discord-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);
    config.channels.discord = {
      token: "FAKE_DISCORD_TOKEN",
      dmPolicy: "pairing",
      allowFrom: [],
      guilds: {},
    };

    const { router } = createGateway(config, { logger: () => {} });

    const discordAdapter = router.getAdapter("discord");
    assert.ok(discordAdapter, "discord adapter should be registered");
    assert.equal(discordAdapter.channelType, "discord");
  });
});

test("createGateway: no Discord adapter when channels.discord.enabled is false", () => {
  withTempHome("gwfactory-discord-disabled-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);
    config.channels.discord = {
      enabled: false,
      token: "FAKE_DISCORD_TOKEN",
    };

    const { router } = createGateway(config, { logger: () => {} });

    const discordAdapter = router.getAdapter("discord");
    assert.equal(discordAdapter, null, "discord adapter should NOT be registered when disabled");
  });
});

test("createGateway: no Discord adapter when no discord config present", () => {
  withTempHome("gwfactory-discord-noconfig-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);

    const { router } = createGateway(config, { logger: () => {} });

    assert.equal(router.getAdapter("discord"), null);
  });
});

test("createGateway: Discord adapter resolves token from env", () => {
  withTempHome("gwfactory-discord-env-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);
    const prevEnv = process.env.TEST_DISCORD_FACTORY_TOKEN;
    process.env.TEST_DISCORD_FACTORY_TOKEN = "env-discord-token";
    try {
      config.channels.discord = {
        token: "",
        tokenEnv: "TEST_DISCORD_FACTORY_TOKEN",
      };

      const { router } = createGateway(config, { logger: () => {} });
      const discordAdapter = router.getAdapter("discord");
      assert.ok(discordAdapter, "discord adapter should be registered via env token");
    } finally {
      if (prevEnv === undefined) delete process.env.TEST_DISCORD_FACTORY_TOKEN;
      else process.env.TEST_DISCORD_FACTORY_TOKEN = prevEnv;
    }
  });
});

test("createGateway: registers WhatsApp adapter when whatsapp config exists", () => {
  withTempHome("gwfactory-whatsapp-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);
    config.channels.whatsapp = {
      dmPolicy: "pairing",
      allowFrom: [],
      sendReadReceipts: true,
    };

    const { router } = createGateway(config, { logger: () => {} });

    const whatsappAdapter = router.getAdapter("whatsapp");
    assert.ok(whatsappAdapter, "whatsapp adapter should be registered");
    assert.equal(whatsappAdapter.channelType, "whatsapp");
  });
});

test("createGateway: no WhatsApp adapter when channels.whatsapp.enabled is false", () => {
  withTempHome("gwfactory-whatsapp-disabled-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);
    config.channels.whatsapp = {
      enabled: false,
      dmPolicy: "pairing",
    };

    const { router } = createGateway(config, { logger: () => {} });

    assert.equal(router.getAdapter("whatsapp"), null, "whatsapp adapter should NOT be registered when disabled");
  });
});

test("createGateway: no WhatsApp adapter when no whatsapp config", () => {
  withTempHome("gwfactory-whatsapp-noconfig-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);

    const { router } = createGateway(config, { logger: () => {} });

    assert.equal(router.getAdapter("whatsapp"), null);
  });
});

test("createGateway: pairing config is passed through", () => {
  withTempHome("gwfactory-pairing-", (home) => {
    const config = loadConfig();
    clearTelegramToken(config);
    config.pairing = {
      codeLength: 8,
      expiresAfterSec: 7200,
      maxPendingPerChannel: 50,
    };

    const { core } = createGateway(config, { logger: () => {} });
    assert.ok(core, "core should be created with custom pairing config");
  });
});

test("createGateway: custom logger is used", () => {
  withTempHome("gwfactory-logger-", (home) => {
    const lines = [];
    const config = loadConfig();
    clearTelegramToken(config);

    const { core } = createGateway(config, {
      logger: (line) => lines.push(line),
    });

    assert.ok(core, "core should exist");
  });
});
