import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { LocalHumanAuthStack } = await import("../dist/human-auth/local-stack.js");

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
