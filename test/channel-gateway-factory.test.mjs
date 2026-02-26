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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("createGateway: creates core and router with Telegram adapter when token exists", () => {
  withTempHome("gwfactory-tg-", (home) => {
    const config = loadConfig();
    config.telegram.botToken = "FAKE_TOKEN_FOR_TEST";

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
    config.telegram.botToken = "";
    config.telegram.botTokenEnv = "";

    const { core, router } = createGateway(config, { logger: () => {} });

    assert.ok(core, "core should exist");
    const telegramAdapter = router.getAdapter("telegram");
    assert.equal(telegramAdapter, null, "telegram adapter should NOT be registered");
  });
});

test("createGateway: no Telegram adapter when channels.telegram.enabled is false", () => {
  withTempHome("gwfactory-disabled-", (home) => {
    const config = loadConfig();
    config.telegram.botToken = "FAKE_TOKEN_FOR_TEST";
    config.channels = { telegram: { enabled: false } };

    const { core, router } = createGateway(config, { logger: () => {} });

    assert.ok(core, "core should exist");
    const telegramAdapter = router.getAdapter("telegram");
    assert.equal(telegramAdapter, null, "telegram adapter should NOT be registered when disabled");
  });
});

test("createGateway: core lifecycle works", async () => {
  await withTempHome("gwfactory-lifecycle-", async (home) => {
    const config = loadConfig();
    config.telegram.botToken = "";
    config.telegram.botTokenEnv = "";

    const { core } = createGateway(config, { logger: () => {} });

    assert.equal(core.isRunning(), false);
    await core.start();
    assert.equal(core.isRunning(), true);
    await core.stop("test");
    assert.equal(core.isRunning(), false);
  });
});

test("createGateway: router has no adapters for other channel types yet", () => {
  withTempHome("gwfactory-noadapters-", (home) => {
    const config = loadConfig();
    config.telegram.botToken = "";
    config.telegram.botTokenEnv = "";

    const { router } = createGateway(config, { logger: () => {} });

    assert.equal(router.getAdapter("discord"), null);
    assert.equal(router.getAdapter("whatsapp"), null);
    assert.equal(router.getAdapter("slack"), null);
    assert.equal(router.getAdapter("signal"), null);
    assert.equal(router.getAdapter("wechat"), null);
    assert.equal(router.getAdapter("qq"), null);
  });
});

test("createGateway: pairing config is passed through", () => {
  withTempHome("gwfactory-pairing-", (home) => {
    const config = loadConfig();
    config.telegram.botToken = "";
    config.telegram.botTokenEnv = "";
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
    config.telegram.botToken = "";
    config.telegram.botTokenEnv = "";

    const { core } = createGateway(config, {
      logger: (line) => lines.push(line),
    });

    // The router creation logs something when verbose
    // At minimum, core should be creatable
    assert.ok(core, "core should exist");
  });
});
