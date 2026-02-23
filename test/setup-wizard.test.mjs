import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../dist/config/index.js");
const { runSetupWizard, runCodexCliLoginCommand } = require("../dist/onboarding/setup-wizard.js");

class FakePrompter {
  constructor(script) {
    this.script = {
      selects: [...(script.selects ?? [])],
      confirms: [...(script.confirms ?? [])],
      texts: [...(script.texts ?? [])],
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

  async confirm() {
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
      confirms: [true, true, true],
      selects: ["gpt-5.2-codex", "config", "skip", "keep", "start", "disabled"],
      texts: ["sk-test-openpocket"],
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
      confirms: [true, true],
      selects: ["autoglm-phone", "config", "skip", "keep", "skip", "disabled"],
      texts: ["zai-test-key"],
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

test("setup wizard configures local human-auth ngrok mode", async () => {
  await withTempHome("openpocket-setup-human-auth-ngrok-", async () => {
    const cfg = loadConfig();
    const prevToken = process.env.NGROK_AUTHTOKEN;
    process.env.NGROK_AUTHTOKEN = "ngrok-test-token";
    const prompter = new FakePrompter({
      confirms: [true],
      selects: ["gpt-5.2-codex", "skip", "skip", "keep", "skip", "ngrok", "env"],
      texts: [],
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
      confirms: [true],
      selects: ["gpt-5.2-codex", "skip", "skip", "keep", "skip", "ngrok", "skip"],
      texts: [],
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
      confirms: [true, true],
      selects: ["gpt-5.2-codex", "skip", "config", "set", "skip", "disabled"],
      texts: ["telegram-test-token", "123456789, 987654321"],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.telegram.botToken, "telegram-test-token");
    assert.deepEqual(savedCfg.telegram.allowedChatIds, [123456789, 987654321]);
  });
});

test("setup wizard normalizes invalid telegram botTokenEnv name", async () => {
  await withTempHome("openpocket-setup-telegram-env-normalize-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botTokenEnv = "8368685395:AAH-invalid-token-shape";
    const prompter = new FakePrompter({
      confirms: [true],
      selects: ["gpt-5.2-codex", "skip", "skip", "keep", "skip", "disabled"],
      texts: [],
      pauseCount: 0,
    });
    const emulator = new FakeEmulator();

    await runSetupWizard(cfg, { prompter, emulator, skipTtyCheck: true, printHeader: false });

    const savedCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf-8"));
    assert.equal(savedCfg.telegram.botTokenEnv, "TELEGRAM_BOT_TOKEN");
  });
});

test("setup wizard supports codex cli auth option in model selection", async () => {
  await withTempHome("openpocket-setup-codex-cli-auth-", async () => {
    await withTempCodexHome("openpocket-codex-home-", async (codexHome) => {
      const cfg = loadConfig();
      let loginCalled = 0;
      const prompter = new FakePrompter({
        confirms: [true],
        selects: ["gpt-5.2-codex::codex-cli", "skip", "keep", "skip", "disabled"],
        texts: [],
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
        confirms: [true],
        selects: ["gpt-5.2-codex::codex-cli", "skip", "keep", "skip", "disabled"],
        texts: [],
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
      selects: ["gpt-5.2-codex::codex-cli"],
      texts: [],
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
