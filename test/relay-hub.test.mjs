import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

const { loadConfig } = await import("../dist/config/index.js");
const { RelayHubServer } = await import("../dist/manager/relay-hub.js");
const { loadManagerPorts, saveManagerPorts } = await import("../dist/manager/ports.js");
const { LocalHumanAuthStack } = await import("../dist/human-auth/local-stack.js");

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0mQAAAAASUVORK5CYII=";

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

async function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test("managed local human-auth stack registers through relay hub and returns prefixed URLs", async () => {
  await withTempHome("openpocket-relay-hub-", async (home) => {
    const init = runCli(["init"], { OPENPOCKET_HOME: home });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const create = runCli(
      ["create", "agent", "auth-bot", "--type", "physical-phone", "--device", "AUTH-DEVICE-1"],
      { OPENPOCKET_HOME: home },
    );
    assert.equal(create.status, 0, create.stderr || create.stdout);

    const hub = new RelayHubServer({ host: "127.0.0.1", port: 0 });
    await hub.start();
    const ports = loadManagerPorts();
    saveManagerPorts({ ...ports, relayHubPort: Number(new URL(hub.address).port) });

    const cfg = loadConfig(path.join(home, "agents", "auth-bot", "config.json"));
    cfg.humanAuth.enabled = true;
    cfg.humanAuth.useLocalRelay = true;
    cfg.humanAuth.tunnel.provider = "none";
    cfg.humanAuth.tunnel.ngrok.enabled = false;

    const stack = new LocalHumanAuthStack(cfg);
    const started = await stack.start();
    try {
      assert.equal(started.relayBaseUrl, `${hub.address}/a/auth-bot`);
      assert.equal(started.publicBaseUrl, `${hub.publicBaseUrl}/a/auth-bot`);

      const health = await fetch(`${hub.address}/api/health`).then((res) => res.json());
      assert.equal(health.ok, true);
      assert.equal(health.registrations.some((entry) => entry.agentId === "auth-bot"), true);

      const requestId = `req-${Date.now()}`;
      const createdResponse = await fetch(`${started.relayBaseUrl}/v1/human-auth/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          task: "Relay hub proxy test",
          sessionId: "session-hub",
          step: 2,
          capability: "camera",
          instruction: "Approve camera delegation",
          reason: "relay-hub-proxy",
          timeoutSec: 120,
          publicBaseUrl: started.publicBaseUrl,
        }),
      });
      assert.equal(createdResponse.status, 200);
      const created = await createdResponse.json();
      assert.match(created.openUrl, /^http:\/\/127\.0\.0\.1:\d+\/a\/auth-bot\/human-auth\//);
      assert.match(
        created.takeover?.streamUrl,
        /^http:\/\/127\.0\.0\.1:\d+\/a\/auth-bot\/v1\/human-auth\//,
      );
    } finally {
      await stack.stop();
      await hub.stop();
    }
  });
});

test("managed relay hub proxies signed screenshot URLs", async () => {
  await withTempHome("openpocket-relay-hub-screenshot-", async (home) => {
    const init = runCli(["init"], { OPENPOCKET_HOME: home });
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const create = runCli(
      ["create", "agent", "auth-bot", "--type", "physical-phone", "--device", "AUTH-DEVICE-1"],
      { OPENPOCKET_HOME: home },
    );
    assert.equal(create.status, 0, create.stderr || create.stdout);

    const hub = new RelayHubServer({ host: "127.0.0.1", port: 0 });
    await hub.start();
    const ports = loadManagerPorts();
    saveManagerPorts({ ...ports, relayHubPort: Number(new URL(hub.address).port) });

    const cfg = loadConfig(path.join(home, "agents", "auth-bot", "config.json"));
    cfg.humanAuth.enabled = true;
    cfg.humanAuth.useLocalRelay = true;
    cfg.humanAuth.tunnel.provider = "none";
    cfg.humanAuth.tunnel.ngrok.enabled = false;

    const stack = new LocalHumanAuthStack(cfg, undefined, {
      takeoverRuntime: {
        captureFrame: async () => ({
          deviceId: "emulator-5554",
          currentApp: "com.example.camera",
          width: 1,
          height: 1,
          screenshotBase64: ONE_PIXEL_PNG_BASE64,
          capturedAt: new Date().toISOString(),
        }),
        execute: async () => "noop",
      },
    });

    await stack.start();
    try {
      const signed = await stack.createSignedScreenshotUrl({ ttlSec: 60 });
      assert.match(signed.url, /^http:\/\/127\.0\.0\.1:\d+\/a\/auth-bot\/v1\/human-auth\/takeover\/screenshot\?token=/);

      const response = await fetch(signed.url);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200);
      assert.match(String(response.headers.get("content-type") || ""), /^image\/png/i);
      assert.equal(body.equals(Buffer.from(ONE_PIXEL_PNG_BASE64, "base64")), true);
    } finally {
      await stack.stop();
      await hub.stop();
    }
  });
});
