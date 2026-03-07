import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

const { loadConfig, saveConfig } = await import("../dist/config/index.js");
const {
  ensureManagerModelTemplateFromConfig,
  loadManagerModelTemplate,
  loadManagerRegistry,
} = await import("../dist/manager/registry.js");

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

test("create agent uses captured model template and isolated storage", () => {
  const home = makeHome("openpocket-multi-agent-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const defaultConfigPath = path.join(home, "config.json");
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    let cfg = loadConfig(defaultConfigPath);
    cfg.defaultModel = "gpt-5.4";
    saveConfig(cfg);
    ensureManagerModelTemplateFromConfig(loadConfig(defaultConfigPath), { overwrite: true });

    cfg = loadConfig(defaultConfigPath);
    cfg.defaultModel = "google/gemini-2.0-flash";
    if (!cfg.channels.telegram) {
      cfg.channels.telegram = {};
    }
    cfg.channels.telegram.botToken = "should-not-copy";
    saveConfig(cfg);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }

  const create = runCli(
    ["create", "agent", "review-bot", "--type", "physical-phone", "--device", "R5CX123456A"],
    { OPENPOCKET_HOME: home },
  );
  assert.equal(create.status, 0, create.stderr || create.stdout);
  assert.match(create.stdout, /Agent 'review-bot' created/);

  const registryPath = path.join(home, "manager", "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  assert.equal(Boolean(registry.agents.default), true);
  assert.equal(Boolean(registry.agents["review-bot"]), true);

  const agentConfigPath = path.join(home, "agents", "review-bot", "config.json");
  const agentConfig = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8"));
  assert.equal(agentConfig.defaultModel, "gpt-5.4");
  assert.equal(agentConfig.workspaceDir, path.join(home, "agents", "review-bot", "workspace"));
  assert.equal(agentConfig.stateDir, path.join(home, "agents", "review-bot", "state"));
  assert.equal(agentConfig.channels?.telegram, undefined);
  assert.equal(fs.existsSync(path.join(home, "agents", "review-bot", "workspace", "AGENTS.md")), true);
  assert.equal(fs.existsSync(path.join(home, "agents", "review-bot", "state")), true);
});

test("agents list/show/delete and --agent config selection work", () => {
  const home = makeHome("openpocket-multi-agent-list-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const create = runCli(
    ["create", "agent", "ops-bot", "--type", "physical-phone", "--device", "DEVICE-OPS-1"],
    { OPENPOCKET_HOME: home },
  );
  assert.equal(create.status, 0, create.stderr || create.stdout);

  const list = runCli(["agents", "list"], { OPENPOCKET_HOME: home });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  assert.match(list.stdout, /default/);
  assert.match(list.stdout, /ops-bot/);

  const show = runCli(["agents", "show", "ops-bot"], { OPENPOCKET_HOME: home });
  assert.equal(show.status, 0, show.stderr || show.stdout);
  assert.match(show.stdout, /Agent: ops-bot/);
  assert.match(show.stdout, /DEVICE-OPS-1/);

  const configShow = runCli(["--agent", "ops-bot", "config-show"], { OPENPOCKET_HOME: home });
  assert.equal(configShow.status, 0, configShow.stderr || configShow.stdout);
  assert.match(configShow.stdout, /OpenPocket \(ops-bot\)/);
  assert.match(configShow.stdout, /DEVICE-OPS-1/);

  const del = runCli(["agents", "delete", "ops-bot"], { OPENPOCKET_HOME: home });
  assert.equal(del.status, 0, del.stderr || del.stdout);
  assert.equal(fs.existsSync(path.join(home, "agents", "ops-bot")), false);
});

test("create agent rejects duplicate target bindings", () => {
  const home = makeHome("openpocket-multi-agent-dup-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const first = runCli(
    ["create", "agent", "alpha", "--type", "physical-phone", "--device", "SAME-DEVICE"],
    { OPENPOCKET_HOME: home },
  );
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const second = runCli(
    ["create", "agent", "beta", "--type", "physical-phone", "--device", "SAME-DEVICE"],
    { OPENPOCKET_HOME: home },
  );
  assert.equal(second.status, 1);
  assert.match(`${second.stderr}\n${second.stdout}`, /already bound to agent 'alpha'/i);
});

test("manager registry rejects corrupted JSON instead of silently recreating default agent only", () => {
  const home = makeHome("openpocket-multi-agent-registry-invalid-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    const managerDir = path.join(home, "manager");
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, "registry.json"), "{invalid-json", "utf-8");

    assert.throws(
      () => loadManagerRegistry(),
      /Invalid manager registry JSON/i,
    );
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
});

test("manager model template rejects corrupted JSON instead of recapturing current default config", () => {
  const home = makeHome("openpocket-multi-agent-template-invalid-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const defaultConfigPath = path.join(home, "config.json");
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    ensureManagerModelTemplateFromConfig(loadConfig(defaultConfigPath), { overwrite: true });
    const managerDir = path.join(home, "manager");
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, "model-template.json"), "{invalid-json", "utf-8");

    assert.throws(
      () => loadManagerModelTemplate(),
      /Invalid manager model template JSON/i,
    );
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
});
