import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { LocalHumanAuthStack } = await import("../dist/human-auth/local-stack.js");

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0mQAAAAASUVORK5CYII=";

class FakeTakeoverRuntime {
  async captureFrame() {
    return {
      deviceId: "emulator-5554",
      currentApp: "com.example.testapp",
      width: 1,
      height: 1,
      screenshotBase64: ONE_PIXEL_PNG_BASE64,
      capturedAt: new Date().toISOString(),
    };
  }

  async execute() {
    return "noop";
  }
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

test("LocalHumanAuthStack starts local relay without tunnel", async () => {
  await withTempHome("openpocket-human-auth-stack-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.enabled = true;
    cfg.humanAuth.useLocalRelay = true;
    cfg.humanAuth.localRelayHost = "127.0.0.1";
    cfg.humanAuth.localRelayPort = 0;
    cfg.humanAuth.tunnel.provider = "none";
    cfg.humanAuth.tunnel.ngrok.enabled = false;

    const stack = new LocalHumanAuthStack(cfg);
    const started = await stack.start();
    try {
      assert.match(started.relayBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(started.publicBaseUrl, started.relayBaseUrl);
    } finally {
      await stack.stop();
    }
  });
});

test("LocalHumanAuthStack creates a signed screenshot URL served by the relay", async () => {
  await withTempHome("openpocket-human-auth-signed-screenshot-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.enabled = true;
    cfg.humanAuth.useLocalRelay = true;
    cfg.humanAuth.localRelayHost = "127.0.0.1";
    cfg.humanAuth.localRelayPort = 0;
    cfg.humanAuth.tunnel.provider = "none";
    cfg.humanAuth.tunnel.ngrok.enabled = false;

    const stack = new LocalHumanAuthStack(cfg, undefined, { takeoverRuntime: new FakeTakeoverRuntime() });
    await stack.start();
    try {
      const signed = await stack.createSignedScreenshotUrl({ ttlSec: 60 });
      const response = await fetch(signed.url);
      const body = Buffer.from(await response.arrayBuffer());

      assert.equal(response.status, 200);
      assert.match(String(response.headers.get("content-type") || ""), /^image\/png/i);
      assert.equal(body.equals(Buffer.from(ONE_PIXEL_PNG_BASE64, "base64")), true);
      assert.match(signed.expiresAt, /\d{4}-\d{2}-\d{2}T/);
    } finally {
      await stack.stop();
    }
  });
});

test("LocalHumanAuthStack rejects tampered signed screenshot tokens", async () => {
  await withTempHome("openpocket-human-auth-signed-screenshot-deny-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.enabled = true;
    cfg.humanAuth.useLocalRelay = true;
    cfg.humanAuth.localRelayHost = "127.0.0.1";
    cfg.humanAuth.localRelayPort = 0;
    cfg.humanAuth.tunnel.provider = "none";
    cfg.humanAuth.tunnel.ngrok.enabled = false;

    const stack = new LocalHumanAuthStack(cfg, undefined, { takeoverRuntime: new FakeTakeoverRuntime() });
    await stack.start();
    try {
      const signed = await stack.createSignedScreenshotUrl({ ttlSec: 60 });
      const tampered = new URL(signed.url);
      tampered.searchParams.set("token", "bad-token");

      const response = await fetch(tampered);
      assert.equal(response.status, 403);
    } finally {
      await stack.stop();
    }
  });
});

test("LocalHumanAuthStack rejects expired signed screenshot tokens", async () => {
  await withTempHome("openpocket-human-auth-signed-screenshot-expired-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.enabled = true;
    cfg.humanAuth.useLocalRelay = true;
    cfg.humanAuth.localRelayHost = "127.0.0.1";
    cfg.humanAuth.localRelayPort = 0;
    cfg.humanAuth.tunnel.provider = "none";
    cfg.humanAuth.tunnel.ngrok.enabled = false;

    const stack = new LocalHumanAuthStack(cfg, undefined, { takeoverRuntime: new FakeTakeoverRuntime() });
    await stack.start();
    const originalNow = Date.now;
    try {
      const issuedAt = originalNow();
      Date.now = () => issuedAt;
      const signed = await stack.createSignedScreenshotUrl({ ttlSec: 60 });
      Date.now = () => issuedAt + 61_000;

      const response = await fetch(signed.url);
      assert.equal(response.status, 403);
    } finally {
      Date.now = originalNow;
      await stack.stop();
    }
  });
});
