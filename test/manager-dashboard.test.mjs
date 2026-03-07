import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

const { ManagerDashboardServer } = await import("../dist/manager/dashboard-server.js");
const { loadManagerPorts, saveManagerPorts } = await import("../dist/manager/ports.js");

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

async function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = makeHome(prefix);
  process.env.OPENPOCKET_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("manager ports default and persist", async () => {
  await withTempHome("openpocket-manager-ports-", async (home) => {
    const ports = loadManagerPorts();
    assert.equal(ports.managerDashboardPort, 51880);
    assert.equal(ports.relayHubPort, 8787);

    saveManagerPorts({ ...ports, managerDashboardPort: 51980 });
    const reloaded = loadManagerPorts();
    assert.equal(reloaded.managerDashboardPort, 51980);
    assert.equal(fs.existsSync(path.join(home, "manager", "ports.json")), true);
  });
});

test("manager ports rejects corrupted JSON instead of resetting to defaults", async () => {
  await withTempHome("openpocket-manager-ports-invalid-", async (home) => {
    const managerDir = path.join(home, "manager");
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(managerDir, "ports.json"), "{invalid-json", "utf-8");

    assert.throws(
      () => loadManagerPorts(),
      /Invalid manager ports JSON/i,
    );
  });
});

test("manager dashboard exposes agent summaries and HTML index", async () => {
  await withTempHome("openpocket-manager-dashboard-", async (home) => {
    const init = runCli(["init"], { OPENPOCKET_HOME: home });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const create = runCli(
      ["create", "agent", "triage-bot", "--type", "physical-phone", "--device", "TRIAGE-DEVICE-1"],
      { OPENPOCKET_HOME: home },
    );
    assert.equal(create.status, 0, create.stderr || create.stdout);

    const server = new ManagerDashboardServer({ host: "127.0.0.1", port: 0 });
    await server.start();
    try {
      const health = await fetch(`${server.address}/api/health`).then((res) => res.json());
      assert.equal(health.ok, true);

      const payload = await fetch(`${server.address}/api/agents`).then((res) => res.json());
      assert.equal(payload.ok, true);
      assert.equal(Array.isArray(payload.agents), true);
      assert.equal(payload.agents.some((agent) => agent.id === "default"), true);
      const triage = payload.agents.find((agent) => agent.id === "triage-bot");
      assert.equal(Boolean(triage), true);
      assert.equal(triage.targetFingerprint, "physical-phone:TRIAGE-DEVICE-1");
      assert.match(triage.dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

      const html = await fetch(server.address).then((res) => res.text());
      assert.match(html, /Agent Manager/);
      assert.match(html, /triage-bot/);
      assert.match(html, /Open agent dashboard/);
    } finally {
      await server.stop();
    }
  });
});
