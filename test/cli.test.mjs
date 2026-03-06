import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function runCli(args, env = {}) {
  return spawnSync("node", [cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENPOCKET_SKIP_ENV_SETUP: "1",
      OPENPOCKET_SKIP_GATEWAY_PID_CHECK: "1",
      ...env,
    },
    encoding: "utf-8",
  });
}

function makeHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("init creates config and workspace files", () => {
  const home = makeHome("openpocket-ts-init-");
  const result = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const cfgPath = path.join(home, "config.json");
  assert.equal(fs.existsSync(cfgPath), true, "config.json should exist");

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.projectName, "OpenPocket");
  assert.equal(cfg.defaultModel, "gpt-5.2-codex");
  assert.equal(cfg.target.type, "emulator");
  assert.equal(cfg.target.pin, "1234");
  assert.equal(cfg.target.wakeupIntervalSec, 3);

  const mustFiles = [
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "IDENTITY.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "MEMORY.md",
    path.join("cron", "jobs.json"),
  ];
  for (const file of mustFiles) {
    assert.equal(
      fs.existsSync(path.join(home, "workspace", file)),
      true,
      `workspace file missing: ${file}`,
    );
  }
});

test("init does not install CLI shortcut implicitly", () => {
  const runtimeHome = makeHome("openpocket-ts-init-runtime-");
  const shellHome = makeHome("openpocket-ts-init-shell-");

  const result = runCli(["init"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  assert.equal(
    fs.existsSync(path.join(shellHome, ".local", "bin", "openpocket")),
    false,
    "init should not create launcher without install-cli",
  );
  assert.equal(fs.existsSync(path.join(shellHome, ".zshrc")), false, "init should not touch .zshrc");
  assert.equal(fs.existsSync(path.join(shellHome, ".bashrc")), false, "init should not touch .bashrc");
});

test("onboard installs CLI launcher once on first run", () => {
  const runtimeHome = makeHome("openpocket-ts-onboard-runtime-");
  const shellHome = makeHome("openpocket-ts-onboard-shell-");

  const init = runCli(["init"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const firstRun = runCli(["onboard"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(firstRun.status, 1);
  assert.match(firstRun.stderr, /interactive terminal/i);
  assert.match(firstRun.stdout, /\[OpenPocket\]\[onboard\] CLI launcher installed:/);

  const commandPath = path.join(shellHome, ".local", "bin", "openpocket");
  const markerPath = path.join(runtimeHome, "state", "cli-shortcut.json");
  assert.equal(fs.existsSync(commandPath), true, "onboard should install CLI launcher on first run");
  assert.equal(fs.existsSync(markerPath), true, "onboard should persist CLI shortcut marker on first run");

  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  assert.equal(typeof marker.installedAt, "string");
  assert.equal(marker.commandPath, commandPath);

  const secondRun = runCli(["onboard"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(secondRun.status, 1);
  assert.match(secondRun.stderr, /interactive terminal/i);
  assert.equal(
    secondRun.stdout.includes("[OpenPocket][onboard] CLI launcher installed:"),
    false,
    "onboard should skip CLI launcher install after marker exists",
  );
});

test("onboard reuses existing config values when --force is not provided", () => {
  const runtimeHome = makeHome("openpocket-ts-onboard-reuse-runtime-");
  const shellHome = makeHome("openpocket-ts-onboard-reuse-shell-");
  const cfgPath = path.join(runtimeHome, "config.json");
  const onboardingPath = path.join(runtimeHome, "state", "onboarding.json");

  const init = runCli(["init"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  cfg.models["gpt-5.2-codex"].apiKey = "sk-existing-openpocket";
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.telegram) cfg.channels.telegram = {};
  cfg.channels.telegram.botToken = "telegram-existing-token";
  cfg.humanAuth.tunnel.ngrok.authtoken = "ngrok-existing-token";
  cfg.emulator.dataPartitionSizeGb = 64;
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
  fs.mkdirSync(path.dirname(onboardingPath), { recursive: true });
  fs.writeFileSync(onboardingPath, JSON.stringify({ marker: "keep-me" }), "utf-8");

  const onboard = runCli(["onboard"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(onboard.status, 1);
  assert.match(onboard.stderr, /interactive terminal/i);

  const saved = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(saved.models["gpt-5.2-codex"].apiKey, "sk-existing-openpocket");
  assert.equal(saved.channels?.telegram?.botToken, "telegram-existing-token");
  assert.equal(saved.humanAuth.tunnel.ngrok.authtoken, "ngrok-existing-token");
  assert.equal(saved.emulator.dataPartitionSizeGb, 64);
  assert.equal(fs.existsSync(onboardingPath), true);
});

test("onboard --force clears previous config and onboarding state", () => {
  const runtimeHome = makeHome("openpocket-ts-onboard-force-runtime-");
  const shellHome = makeHome("openpocket-ts-onboard-force-shell-");
  const cfgPath = path.join(runtimeHome, "config.json");
  const onboardingPath = path.join(runtimeHome, "state", "onboarding.json");

  const init = runCli(["init"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  cfg.models["gpt-5.2-codex"].apiKey = "sk-existing-openpocket";
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.telegram) cfg.channels.telegram = {};
  cfg.channels.telegram.botToken = "telegram-existing-token";
  cfg.humanAuth.tunnel.ngrok.authtoken = "ngrok-existing-token";
  cfg.emulator.dataPartitionSizeGb = 64;
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
  fs.mkdirSync(path.dirname(onboardingPath), { recursive: true });
  fs.writeFileSync(onboardingPath, JSON.stringify({ marker: "clear-me" }), "utf-8");

  const onboard = runCli(["onboard", "--force"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(onboard.status, 1);
  assert.match(onboard.stderr, /interactive terminal/i);
  assert.match(onboard.stdout, /--force enabled: cleared previous config/i);

  const saved = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(saved.models["gpt-5.2-codex"].apiKey, "");
  assert.equal(saved.channels?.telegram?.botToken ?? "", "");
  assert.equal(saved.humanAuth.tunnel.ngrok.authtoken, "");
  assert.equal(saved.emulator.dataPartitionSizeGb, 24);
  assert.equal(fs.existsSync(onboardingPath), false);
});

test("onboard --target presets deployment target before interactive setup", () => {
  const runtimeHome = makeHome("openpocket-ts-onboard-target-runtime-");
  const shellHome = makeHome("openpocket-ts-onboard-target-shell-");
  const cfgPath = path.join(runtimeHome, "config.json");

  const init = runCli(["init"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const onboard = runCli(["onboard", "--target", "physical-phone"], {
    OPENPOCKET_HOME: runtimeHome,
    HOME: shellHome,
  });
  assert.equal(onboard.status, 1);
  assert.match(onboard.stderr, /interactive terminal/i);

  const saved = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(saved.target.type, "physical-phone");
  assert.match(onboard.stdout, /target preset/i);
});

test("legacy snake_case config is migrated to camelCase by init", () => {
  const home = makeHome("openpocket-ts-migrate-");
  const cfgPath = path.join(home, "config.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    cfgPath,
    `${JSON.stringify(
      {
        project_name: "OpenPocket",
        workspace_dir: path.join(home, "workspace"),
        state_dir: path.join(home, "state"),
        default_model: "gpt-5.2-codex",
        emulator: {
          avd_name: "TestAVD",
          android_sdk_root: "",
          headless: false,
          boot_timeout_sec: 120,
        },
        telegram: {
          bot_token: "",
          bot_token_env: "TELEGRAM_BOT_TOKEN",
          allowed_chat_ids: [],
          poll_timeout_sec: 20,
        },
        agent: {
          max_steps: 10,
          lang: "en",
          verbose: true,
          device_id: null,
        },
        models: {
          "gpt-5.2-codex": {
            base_url: "https://api.openai.com/v1",
            model: "gpt-5.2-codex",
            api_key: "",
            api_key_env: "OPENAI_API_KEY",
            max_tokens: 4096,
            reasoning_effort: "medium",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const result = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const newCfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(typeof newCfg.projectName, "string");
  assert.equal(newCfg.project_name, undefined);
  assert.equal(newCfg.emulator.avdName, "TestAVD");
  assert.equal(newCfg.emulator.avd_name, undefined);
  assert.equal(newCfg.models["gpt-5.2-codex"].baseUrl, "https://api.openai.com/v1");
  assert.equal(newCfg.models["gpt-5.2-codex"].base_url, undefined);
});

test("agent command without API key fails and writes session/memory", () => {
  const home = makeHome("openpocket-ts-agent-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const codexHome = path.join(home, "codex-empty");
  fs.mkdirSync(codexHome, { recursive: true });

  const run = runCli(["agent", "Open Chrome"], {
    OPENPOCKET_HOME: home,
    OPENAI_API_KEY: "",
    CODEX_HOME: codexHome,
  });

  assert.equal(run.status, 1);
  assert.match(run.stdout, /Missing API key/);
  assert.match(run.stdout, /Session:/);

  const sessionsDir = path.join(home, "workspace", "sessions");
  const sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".md"));
  assert.equal(sessionFiles.length > 0, true, "session markdown should exist");

  const sessionBody = fs.readFileSync(path.join(sessionsDir, sessionFiles[0]), "utf-8");
  assert.match(sessionBody, /Missing API key/);

  const date = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dayName = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
  const memoryPath = path.join(home, "workspace", "memory", dayName);
  assert.equal(fs.existsSync(memoryPath), true, "daily memory file should exist");
  const memoryBody = fs.readFileSync(memoryPath, "utf-8");
  assert.match(memoryBody, /FAIL/);
});

test("help output uses onboard as primary command and lists legacy aliases", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /install-cli/);
  assert.match(result.stdout, /onboard/);
  assert.match(result.stdout, /(channels whoami|telegram whoami)/);
  assert.match(result.stdout, /Legacy aliases/);
  assert.match(result.stdout, /\binit\b/);
  assert.match(result.stdout, /\bsetup\b/);
  assert.match(result.stdout, /gateway \[start\|telegram\]/);
  assert.match(result.stdout, /dashboard start/);
});

test("telegram whoami prints DM policy without requiring token", () => {
  const home = makeHome("openpocket-ts-telegram-whoami-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["telegram", "whoami"], {
    OPENPOCKET_HOME: home,
    TELEGRAM_BOT_TOKEN: "",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /DM policy/i);
});

test("telegram without subcommand shows help", () => {
  const home = makeHome("openpocket-ts-telegram-noarg-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["telegram"], { OPENPOCKET_HOME: home });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Telegram Commands/);
  assert.match(run.stdout, /whoami/);
});

test("gateway start command is accepted (reaches startup)", () => {
  const home = makeHome("openpocket-ts-gateway-start-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = spawnSync("node", [cliPath, "gateway", "start"], {
    cwd: repoRoot,
    env: { ...process.env, OPENPOCKET_SKIP_ENV_SETUP: "1", OPENPOCKET_HOME: home, TELEGRAM_BOT_TOKEN: "" },
    encoding: "utf-8",
    timeout: 5000,
  });
  // The gateway starts successfully (no unknown command error); it gets killed by timeout
  assert.doesNotMatch(run.stderr || "", /Unknown.*command/i);
});

test("gateway defaults to start when subcommand is omitted", () => {
  const home = makeHome("openpocket-ts-gateway-default-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = spawnSync("node", [cliPath, "gateway"], {
    cwd: repoRoot,
    env: { ...process.env, OPENPOCKET_SKIP_ENV_SETUP: "1", OPENPOCKET_HOME: home, TELEGRAM_BOT_TOKEN: "" },
    encoding: "utf-8",
    timeout: 5000,
  });
  assert.doesNotMatch(run.stderr || "", /Unknown.*command/i);
});

test("dashboard command validates subcommand", () => {
  const run = runCli(["dashboard", "noop"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown dashboard subcommand/);
});

test("target show prints deployment target summary", () => {
  const home = makeHome("openpocket-ts-target-show-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["target", "show"], {
    OPENPOCKET_HOME: home,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Deployment Target/i);
  assert.match(run.stdout, /emulator/i);
  assert.match(run.stdout, /Phone PIN/i);
  assert.match(run.stdout, /Wakeup interval/i);
});

test("model show prints current default model profile summary", () => {
  const home = makeHome("openpocket-ts-model-show-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["model", "show"], {
    OPENPOCKET_HOME: home,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Model Profile/i);
  assert.match(run.stdout, /Default/i);
  assert.match(run.stdout, /gpt-5.2-codex/i);
});

test("model list prints configured profiles including Gemini 3.1", () => {
  const home = makeHome("openpocket-ts-model-list-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["model", "list"], {
    OPENPOCKET_HOME: home,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Model Profiles/i);
  assert.match(run.stdout, /google\/gemini-3\.1-pro-preview/i);
  assert.match(run.stdout, /gpt-5\.4/i);
});

test("model set updates default model persistently", () => {
  const home = makeHome("openpocket-ts-model-set-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    ["model", "set", "--name", "google/gemini-3.1-pro-preview"],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Default model updated/i);
  assert.match(run.stdout, /google\/gemini-3\.1-pro-preview/i);

  const cfgPath = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.defaultModel, "google/gemini-3.1-pro-preview");
});

test("model set supports provider+model upsert and switches default profile", () => {
  const home = makeHome("openpocket-ts-model-set-provider-model-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    ["model", "set", "--provider", "anthropic", "--model", "claude-opus-4-6"],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Default model updated/i);
  assert.match(run.stdout, /anthropic\/claude-opus-4-6/i);
  assert.match(run.stdout, /Anthropic/i);

  const cfgPath = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.defaultModel, "anthropic/claude-opus-4-6");
  assert.equal(cfg.models["anthropic/claude-opus-4-6"].baseUrl, "https://api.anthropic.com");
  assert.equal(cfg.models["anthropic/claude-opus-4-6"].model, "claude-opus-4-6");
  assert.equal(cfg.models["anthropic/claude-opus-4-6"].apiKeyEnv, "ANTHROPIC_API_KEY");
});

test("model set --provider rejects unknown provider key", () => {
  const home = makeHome("openpocket-ts-model-set-provider-unknown-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    ["model", "set", "--provider", "unknown-provider", "--model", "claude-opus-4-6"],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown provider/i);
});

test("model set rejects unknown profile", () => {
  const home = makeHome("openpocket-ts-model-set-unknown-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    ["model", "set", "google/gemini-9-pro-preview"],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown model profile/i);
});

test("target set updates config for physical phone deployment", () => {
  const home = makeHome("openpocket-ts-target-set-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const setRun = runCli(
    [
      "target",
      "set",
      "--type",
      "physical-phone",
      "--adb-endpoint",
      "192.168.50.10",
      "--device",
      "R5CX123456A",
      "--pin",
      "2468",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(setRun.status, 0, setRun.stderr || setRun.stdout);
  assert.match(setRun.stdout, /Deployment target updated/i);

  const cfgPath = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.target.type, "physical-phone");
  assert.equal(cfg.target.adbEndpoint, "192.168.50.10:5555");
  assert.equal(cfg.target.pin, "2468");
  assert.equal(cfg.target.wakeupIntervalSec, 3);
  assert.equal(cfg.agent.deviceId, "R5CX123456A");
});

test("target set-target alias updates config for Android TV deployment", () => {
  const home = makeHome("openpocket-ts-target-set-target-alias-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const setRun = runCli(
    [
      "target",
      "set-target",
      "--type",
      "android-tv",
      "--adb-endpoint",
      "192.168.10.50:5555",
      "--device",
      "192.168.10.50:5555",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(setRun.status, 0, setRun.stderr || setRun.stdout);

  const cfgPath = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.target.type, "android-tv");
  assert.equal(cfg.target.adbEndpoint, "192.168.10.50:5555");
  assert.equal(cfg.agent.deviceId, "192.168.10.50:5555");
});

test("target set supports updating target PIN", () => {
  const home = makeHome("openpocket-ts-target-set-virtual-pin-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const setRun = runCli(
    [
      "target",
      "set",
      "--type",
      "emulator",
      "--pin",
      "9876",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(setRun.status, 0, setRun.stderr || setRun.stdout);

  const cfgPath = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.target.type, "emulator");
  assert.equal(cfg.target.pin, "9876");
});

test("target set supports updating wakeup interval", () => {
  const home = makeHome("openpocket-ts-target-set-wakeup-interval-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const setRun = runCli(
    [
      "target",
      "set",
      "--wakeup-interval",
      "7",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(setRun.status, 0, setRun.stderr || setRun.stdout);

  const cfgPath = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.target.wakeupIntervalSec, 7);
});

test("target set uses default physical phone PIN for physical target", () => {
  const home = makeHome("openpocket-ts-target-set-pin-required-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    [
      "target",
      "set",
      "--type",
      "physical-phone",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const cfgPath = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.target.type, "physical-phone");
  assert.equal(cfg.target.pin, "1234");
});

test("target set rejects non-4-digit PIN", () => {
  const home = makeHome("openpocket-ts-target-set-pin-invalid-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    [
      "target",
      "set",
      "--pin",
      "12ab",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /4 digits/i);
});

test("target set rejects invalid wakeup interval", () => {
  const home = makeHome("openpocket-ts-target-set-wakeup-invalid-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    [
      "target",
      "set",
      "--wakeup-interval",
      "0",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /1-3600/i);
});

test("target pair validates required host/port/code in non-interactive mode", () => {
  const home = makeHome("openpocket-ts-target-pair-required-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    [
      "target",
      "pair",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Missing host|pair-endpoint/i);
});

test("target pair dry-run updates target adb endpoint and preferred device", () => {
  const home = makeHome("openpocket-ts-target-pair-dry-run-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    [
      "target",
      "pair",
      "--host",
      "192.168.10.88",
      "--pair-port",
      "37099",
      "--connect-port",
      "5555",
      "--code",
      "123456",
      "--type",
      "android-tv",
      "--dry-run",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /ADB pairing flow completed/i);
  assert.match(run.stdout, /dry-run/i);

  const cfgPath = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  assert.equal(cfg.target.type, "android-tv");
  assert.equal(cfg.target.adbEndpoint, "192.168.10.88:5555");
  assert.equal(cfg.agent.deviceId, "192.168.10.88:5555");
});

test("target pair rejects unsupported target type", () => {
  const home = makeHome("openpocket-ts-target-pair-type-invalid-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(
    [
      "target",
      "pair",
      "--host",
      "192.168.10.88",
      "--pair-port",
      "37099",
      "--code",
      "123456",
      "--type",
      "emulator",
      "--dry-run",
    ],
    {
      OPENPOCKET_HOME: home,
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /physical-phone \| android-tv/i);
});

test("test permission-app task prints recommended telegram flow", () => {
  const run = runCli(["test", "permission-app", "task"]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /request_human_auth/i);
  assert.match(run.stdout, /OpenPocket PermissionLab/i);
  assert.match(run.stdout, /--send/);
});

test("test permission-app task supports scenario-specific prompt", () => {
  const run = runCli(["test", "permission-app", "task", "--case", "location"]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Request Location Permission/);
  assert.match(run.stdout, /request_human_auth/i);
});

test("test permission-app cases prints scenario list", () => {
  const run = runCli(["test", "permission-app", "cases"]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /camera/i);
  assert.match(run.stdout, /2fa/i);
});

test("test command validates unknown target", () => {
  const run = runCli(["test", "unknown-target"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown test target/);
});

test("test permission-app task --send requires telegram token", () => {
  const home = makeHome("openpocket-ts-test-task-send-token-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["test", "permission-app", "task", "--send"], {
    OPENPOCKET_HOME: home,
    TELEGRAM_BOT_TOKEN: "",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Telegram bot token is empty/);
});

test("test permission-app task --send requires chat id when allowlist is empty", () => {
  const home = makeHome("openpocket-ts-test-task-send-chat-");
  const init = runCli(["init"], {
    OPENPOCKET_HOME: home,
    TELEGRAM_BOT_TOKEN: "token-from-env",
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["test", "permission-app", "task", "--send"], {
    OPENPOCKET_HOME: home,
    TELEGRAM_BOT_TOKEN: "token-from-env",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No default chat ID found/);
});

test("test permission-app run requires telegram token", () => {
  const home = makeHome("openpocket-ts-test-run-token-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["test", "permission-app", "run"], {
    OPENPOCKET_HOME: home,
    TELEGRAM_BOT_TOKEN: "",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Telegram bot token is empty/);
});
