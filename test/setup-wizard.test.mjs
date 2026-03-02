import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const { loadConfig } = await import("../dist/config/index.js");
const { runSetupWizard, runCodexCliLoginCommand } = await import("../dist/onboarding/setup-wizard.js");

class FakePrompter {
  constructor(script) {
    this.script = {
      selects: [...(script.selects ?? [])],
      confirms: [...(script.confirms ?? [])],
      texts: [...(script.texts ?? [])],
      secrets: [...(script.secrets ?? [])],
      pauseCount: script.pauseCount ?? 0,
    };
    this.notes = [];
    this.closed = false;
  }

  async intro() {}
  async note(title, body) {
    this.notes.push({ title, body });
  }
  async outro() {}

  async select(_message, _options) {
    if (this.script.selects.length === 0) {
      throw new Error("No scripted select value.");
    }
    return this.script.selects.shift();
  }

  async confirm(message) {
    // macOS adds an extra iMessage channel confirmation; tests are scripted for Linux CI flow.
    if (typeof message === "string" && message.startsWith("Enable iMessage?")) {
      return false;
    }
    if (this.script.confirms.length === 0) {
      throw new Error("No scripted confirm value.");
    }
    return this.script.confirms.shift();
  }

  async text() {
    if (this.script.texts.length === 0) {
      throw new Error("No scripted text value.");
    }
    return this.script.texts.shift();
  }

  async secret() {
    if (this.script.secrets.length > 0) {
      return this.script.secrets.shift();
    }
    if (this.script.texts.length > 0) {
      return this.script.texts.shift();
    }
    throw new Error("No scripted secret value.");
  }

  async pause() {
    if (this.script.pauseCount <= 0) {
      throw new Error("Unexpected pause.");
    }
    this.script.pauseCount -= 1;
  }

  async close() {
    this.closed = true;
  }
}

class FakeEmulator {
  constructor() {
    this.started = 0;
    this.shown = 0;
    this.adbCalls = [];
  }

  async start() {
    this.started += 1;
    return "Emulator booted: emulator-5554";
  }

  showWindow() {
    this.shown += 1;
    return "Android Emulator window activated.";
  }

  status() {
    return {
      avdName: "OpenPocket_AVD",
      devices: ["emulator-5554"],
      bootedDevices: ["emulator-5554"],
    };
  }

  runAdb(args) {
    this.adbCalls.push(args);
    return "package:/system/priv-app/Phonesky/Phonesky.apk";
  }
}

async function withTempHome(prefix, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prev;
    }
  }
}

async function withTempCodexHome(prefix, fn) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return await fn(codexHome);
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prev;
    }
  }
}

test("setup wizard aborts when consent is not accepted", async () => {
  await withTempHome("openpocket-setup-consent-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [false],
    });
    const emulator = new FakeEmulator();

    await assert.rejects(
      () => runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false }),
      /consent not accepted/i,
    );
    assert.equal(prompter.closed, true);
    assert.equal(fs.existsSync(path.join(cfg.stateDir, "onboarding.json")), false);
  });
});

test("setup wizard configures OpenAI key and records Gmail onboarding state", async () => {
  await withTempHome("openpocket-setup-full-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true, true, true, false, false, true],
      selects: ["emulator", "gpt-5.2-codex", "config", "skip", "pairing", "start", "disabled"],
      texts: ["", "sk-should-not-be-used"],
      secrets: ["sk-test-openpocket"],
      pauseCount: 1,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    assert.equal(prompter.closed, true);
    assert.equal(emulator.started, 1);
    assert.equal(emulator.shown, 1);
    assert.equal(emulator.adbCalls.length > 0, true);

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.models["gpt-5.2-codex"].apiKey, "sk-test-openpocket");
    assert.equal(savedCfg.models["gpt-5.3-codex"].apiKey, "sk-test-openpocket");

    const statePath = path.join(cfg.stateDir, "onboarding.json");
    assert.equal(fs.existsSync(statePath), true);
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.modelProfile, "gpt-5.2-codex");
    assert.equal(state.apiKeyEnv, "OPENAI_API_KEY");
    assert.equal(state.apiKeySource, "config");
    assert.equal(typeof state.consentAcceptedAt, "string");
    assert.equal(typeof state.gmailLoginConfirmedAt, "string");
    assert.equal(state.playStoreDetected, true);
  });
});

test("setup wizard applies provider key to selected provider only", async () => {
  await withTempHome("openpocket-setup-provider-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true, true, true, false, false],
      selects: ["emulator", "autoglm-phone", "config", "skip", "pairing", "skip", "disabled"],
      texts: ["", "zai-test-key"],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.models["autoglm-phone"].apiKey, "zai-test-key");
    assert.equal(savedCfg.models["gpt-5.2-codex"].apiKey, "");
    assert.equal(savedCfg.models["claude-sonnet-4.6"].apiKey, "");
  });
});

test("setup wizard can configure physical phone target and skip emulator onboarding", async () => {
  await withTempHome("openpocket-setup-physical-target-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["physical-phone", "usb", "gpt-5.2-codex", "skip", "skip", "pairing", "disabled"],
      texts: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.target.type, "physical-phone");
    assert.equal(savedCfg.target.adbEndpoint, "");
    assert.equal(emulator.started, 0);
    assert.equal(emulator.shown, 0);
    const skipNote = prompter.notes.find(
      (note) => note.title === "Device Onboarding Check" && /skipping emulator Play Store onboarding/i.test(note.body),
    );
    assert.equal(Boolean(skipNote), true);
  });
});

test("setup wizard configures local human-auth ngrok mode", async () => {
  await withTempHome("openpocket-setup-human-auth-ngrok-", async () => {
    const cfg = loadConfig();
    const prevToken = process.env.NGROK_AUTHTOKEN;
    process.env.NGROK_AUTHTOKEN = "ngrok-test-token";
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "skip", "skip", "pairing", "skip", "ngrok", "env"],
      texts: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    try {
      await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });
    } finally {
      if (prevToken === undefined) {
        delete process.env.NGROK_AUTHTOKEN;
      } else {
        process.env.NGROK_AUTHTOKEN = prevToken;
      }
    }

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.humanAuth.enabled, true);
    assert.equal(savedCfg.humanAuth.useLocalRelay, true);
    assert.equal(savedCfg.humanAuth.tunnel.provider, "ngrok");
    assert.equal(savedCfg.humanAuth.tunnel.ngrok.enabled, true);
    assert.equal(savedCfg.humanAuth.tunnel.ngrok.authtoken, "");
    assert.equal(savedCfg.humanAuth.localRelayHost, "127.0.0.1");
  });
});

test("setup wizard includes ngrok setup guide when ngrok CLI is missing", async () => {
  await withTempHome("openpocket-setup-ngrok-guide-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.tunnel.ngrok.executable = "missing-ngrok-binary-for-test";
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "skip", "skip", "pairing", "skip", "ngrok", "skip"],
      texts: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const ngrokNote = prompter.notes.find(
      (note) => note.title === "ngrok Setup" && note.body.includes("https://ngrok.com/download"),
    );
    assert.equal(Boolean(ngrokNote), true);
    assert.equal(ngrokNote.body.includes("config add-authtoken"), true);
  });
});

test("setup wizard can configure Telegram token and allowlist in config", async () => {
  await withTempHome("openpocket-setup-telegram-config-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true, true, false, false, true],
      selects: ["emulator", "gpt-5.2-codex", "skip", "config", "allowlist", "skip", "disabled"],
      texts: ["", "123456789, 987654321"],
      secrets: ["telegram-test-token"],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.channels?.telegram?.botToken, "telegram-test-token");
    assert.deepEqual(savedCfg.channels?.telegram?.allowFrom, ["123456789", "987654321"]);
  });
});

test("setup wizard can configure ngrok authtoken in config using secret input", async () => {
  await withTempHome("openpocket-setup-ngrok-config-token-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true, true, false, false, true],
      selects: ["emulator", "gpt-5.2-codex", "skip", "skip", "pairing", "skip", "ngrok", "config"],
      texts: [""],
      secrets: ["ngrok-config-token"],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.humanAuth.tunnel.ngrok.authtoken, "ngrok-config-token");
  });
});

test("setup wizard can keep existing API key from config.json", async () => {
  await withTempHome("openpocket-setup-api-key-existing-config-", async () => {
    const cfg = loadConfig();
    cfg.models["gpt-5.2-codex"].apiKey = "sk-existing-openpocket";
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "config-existing", "skip", "pairing", "skip", "disabled"],
      texts: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.models["gpt-5.2-codex"].apiKey, "sk-existing-openpocket");

    const statePath = path.join(cfg.stateDir, "onboarding.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.apiKeySource, "config");
  });
});

test("setup wizard can keep existing Telegram token from config.json", async () => {
  await withTempHome("openpocket-setup-telegram-existing-config-", async () => {
    const cfg = loadConfig();
    if (!cfg.telegram) cfg.telegram = { botToken: "", botTokenEnv: "TELEGRAM_BOT_TOKEN", allowedChatIds: [], pollTimeoutSec: 25 };
    cfg.telegram.botToken = "telegram-existing-token";
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "skip", "config-existing", "pairing", "skip", "disabled"],
      texts: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.channels?.telegram?.botToken, "telegram-existing-token");

    const statePath = path.join(cfg.stateDir, "onboarding.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.telegramTokenSource, "config");
  });
});

test("setup wizard can keep existing ngrok token from config.json", async () => {
  await withTempHome("openpocket-setup-ngrok-existing-config-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.tunnel.ngrok.authtoken = "ngrok-existing-token";
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "skip", "skip", "pairing", "skip", "ngrok", "config-existing"],
      texts: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.humanAuth.tunnel.ngrok.authtoken, "ngrok-existing-token");
    assert.equal(savedCfg.humanAuth.tunnel.provider, "ngrok");
  });
});

test("setup wizard allows skipping API key config after empty secret input", async () => {
  await withTempHome("openpocket-setup-api-key-empty-skip-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "config", "skip", "skip", "pairing", "skip", "disabled"],
      texts: [""],
      secrets: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.models["gpt-5.2-codex"].apiKey, "");

    const statePath = path.join(cfg.stateDir, "onboarding.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.apiKeySource, "skipped");
  });
});

test("setup wizard allows skipping Telegram token config after empty secret input", async () => {
  await withTempHome("openpocket-setup-telegram-empty-skip-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "skip", "config", "skip", "pairing", "skip", "disabled"],
      texts: [""],
      secrets: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.channels?.telegram?.botToken ?? "", "");

    const statePath = path.join(cfg.stateDir, "onboarding.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.telegramTokenSource, "skip");
  });
});

test("setup wizard allows skipping ngrok token config after empty secret input", async () => {
  await withTempHome("openpocket-setup-ngrok-empty-skip-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "skip", "skip", "pairing", "skip", "ngrok", "config", "skip"],
      texts: [""],
      secrets: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.humanAuth.tunnel.ngrok.authtoken, "");
    assert.equal(savedCfg.humanAuth.tunnel.provider, "ngrok");
  });
});

test("setup wizard normalizes invalid telegram botTokenEnv name", async () => {
  await withTempHome("openpocket-setup-telegram-env-normalize-", async () => {
    const cfg = loadConfig();
    if (!cfg.telegram) cfg.telegram = { botToken: "", botTokenEnv: "TELEGRAM_BOT_TOKEN", allowedChatIds: [], pollTimeoutSec: 25 };
    cfg.telegram.botTokenEnv = "8368685395:AAH-invalid-token-shape";
    const prompter = new FakePrompter({
      confirms: [true, true, false, false],
      selects: ["emulator", "gpt-5.2-codex", "skip", "skip", "pairing", "skip", "disabled"],
      texts: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.channels?.telegram?.botTokenEnv, "TELEGRAM_BOT_TOKEN");
  });
});

test("setup wizard supports codex cli auth option in model selection", async () => {
  await withTempHome("openpocket-setup-codex-cli-auth-", async () => {
    await withTempCodexHome("openpocket-codex-home-", async (codexHome) => {
      const cfg = loadConfig();
      let loginCalled = 0;
      const prompter = new FakePrompter({
        confirms: [true, true, false, false],
        selects: ["emulator", "gpt-5.2-codex::codex-cli", "skip", "pairing", "skip", "disabled"],
        texts: [""],
        pauseCount: 0,
      });
      const emulator = new FakeEmulator();

      await runSetupWizard(cfg, {
        prompter,
        emulator,
        skipTtyCheck: true,
        printHeader: false,
        codexCliLoginRunner: async () => {
          loginCalled += 1;
          fs.writeFileSync(
            path.join(codexHome, "auth.json"),
            JSON.stringify({
              tokens: {
                access_token: "codex-access-token",
                refresh_token: "codex-refresh-token",
              },
            }),
            "utf-8",
          );
          return {
            ok: true,
            detail: "codex login simulated",
          };
        },
      });

      assert.equal(loginCalled, 1);

      const statePath = path.join(cfg.stateDir, "onboarding.json");
      assert.equal(fs.existsSync(statePath), true);
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      assert.equal(state.modelProfile, "gpt-5.2-codex");
      assert.equal(state.apiKeySource, "codex-cli");
      assert.equal(typeof state.apiKeyConfiguredAt, "string");
    });
  });
});

test("setup wizard uses existing codex credential when codex login command fails", async () => {
  await withTempHome("openpocket-setup-codex-cli-existing-credential-", async () => {
    await withTempCodexHome("openpocket-codex-home-existing-", async (codexHome) => {
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: "existing-codex-access-token",
            refresh_token: "existing-codex-refresh-token",
          },
        }),
        "utf-8",
      );

      const cfg = loadConfig();
      let loginCalled = 0;
      const prompter = new FakePrompter({
        confirms: [true, true, false, false],
        selects: ["emulator", "gpt-5.2-codex::codex-cli", "skip", "pairing", "skip", "disabled"],
        texts: [""],
        pauseCount: 0,
      });
      const emulator = new FakeEmulator();

      await runSetupWizard(cfg, {
        prompter,
        emulator,
        skipTtyCheck: true,
        printHeader: false,
        codexCliLoginRunner: async () => {
          loginCalled += 1;
          return {
            ok: false,
            detail: "codex command not found",
          };
        },
      });

      assert.equal(loginCalled, 1);

      const statePath = path.join(cfg.stateDir, "onboarding.json");
      assert.equal(fs.existsSync(statePath), true);
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      assert.equal(state.modelProfile, "gpt-5.2-codex");
      assert.equal(state.apiKeySource, "codex-cli");
      assert.equal(typeof state.apiKeyConfiguredAt, "string");
    });
  });
});

test("setup wizard exits immediately when codex oauth login is cancelled", async () => {
  await withTempHome("openpocket-setup-codex-cli-cancelled-", async () => {
    const cfg = loadConfig();
    const prompter = new FakePrompter({
      confirms: [true],
      selects: ["emulator", "gpt-5.2-codex::codex-cli"],
      texts: [""],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await assert.rejects(
      () => runSetupWizard(cfg, {
        prompter,
        emulator,
        skipTtyCheck: true,
        printHeader: false,
        codexCliLoginRunner: async () => ({
          ok: false,
          detail: "codex login cancelled by user",
          cancelled: true,
        }),
      }),
      /setup cancelled by user/i,
    );
    assert.equal(prompter.closed, true);
    assert.equal(fs.existsSync(path.join(cfg.stateDir, "onboarding.json")), false);
  });
});

test("codex login runner cancels cleanly on interrupt signal", async () => {
  class FakeChildProcess extends EventEmitter {
    constructor() {
      super();
      this.exitCode = null;
      this.killSignals = [];
    }

    kill(signal = "SIGTERM") {
      this.killSignals.push(signal);
      if (this.exitCode !== null) {
        return true;
      }
      this.exitCode = signal === "SIGINT" ? 130 : 1;
      setImmediate(() => {
        this.emit("exit", this.exitCode, null);
      });
      return true;
    }
  }

  const signalSource = new EventEmitter();
  const child = new FakeChildProcess();
  const spawnCalls = [];

  const resultPromise = runCodexCliLoginCommand({
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    signalSource,
    timeoutMs: 10_000,
  });

  setTimeout(() => {
    signalSource.emit("SIGINT");
  }, 5);

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.detail, "codex login cancelled by user");
  assert.equal(result.cancelled, true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "codex");
  assert.deepEqual(spawnCalls[0].args, ["login"]);
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "inherit", "inherit"]);
  assert.equal(child.killSignals.includes("SIGINT"), true);
});

test("codex login runner returns timeout when oauth flow does not complete", async () => {
  class FakeChildProcess extends EventEmitter {
    constructor() {
      super();
      this.exitCode = null;
      this.killSignals = [];
    }

    kill(signal = "SIGTERM") {
      this.killSignals.push(signal);
      if (this.exitCode !== null) {
        return true;
      }
      this.exitCode = 1;
      setImmediate(() => {
        this.emit("exit", this.exitCode, signal);
      });
      return true;
    }
  }

  const child = new FakeChildProcess();
  const result = await runCodexCliLoginCommand({
    spawnProcess: () => child,
    signalSource: new EventEmitter(),
    timeoutMs: 25,
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /timed out/i);
  assert.equal(child.killSignals.includes("SIGINT"), true);
});
