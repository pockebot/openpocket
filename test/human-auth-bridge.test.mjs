import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { HumanAuthBridge } = await import("../dist/human-auth/bridge.js");

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

function sampleRequest(timeoutSec = 5) {
  return {
    sessionId: "session-1",
    sessionPath: "/tmp/session-1.md",
    task: "demo task",
    step: 3,
    capability: "camera",
    instruction: "Please approve camera access.",
    reason: "Need real camera",
    timeoutSec,
    currentApp: "com.example.app",
    screenshotPath: null,
  };
}

test("HumanAuthBridge supports manual approve flow", async () => {
  await withTempHome("openpocket-auth-bridge-approve-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.enabled = false;

    const bridge = new HumanAuthBridge(cfg);
    let openedContext = null;
    const waitDecision = bridge.requestAndWait(
      {
        chatId: 123,
        task: "demo task",
        request: sampleRequest(5),
      },
      (opened) => {
        openedContext = opened;
      },
    );

    assert.equal(Boolean(openedContext?.requestId), true);
    assert.equal(bridge.listPending().length, 1);

    const resolved = bridge.resolvePending(openedContext.requestId, true, "Approved in test.");
    assert.equal(resolved, true);

    const decision = await waitDecision;
    assert.equal(decision.approved, true);
    assert.equal(decision.status, "approved");
    assert.equal(bridge.listPending().length, 0);
  });
});

test("HumanAuthBridge times out when unresolved", async () => {
  await withTempHome("openpocket-auth-bridge-timeout-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.enabled = false;

    const bridge = new HumanAuthBridge(cfg);
    const decision = await bridge.requestAndWait({
      chatId: 123,
      task: "timeout demo",
      request: sampleRequest(1),
    });

    assert.equal(decision.approved, false);
    assert.equal(decision.status, "timeout");
    assert.match(decision.message, /timed out/i);
  });
});

test("HumanAuthBridge saves audio artifacts with audio extension", async () => {
  await withTempHome("openpocket-auth-bridge-audio-artifact-", async () => {
    const cfg = loadConfig();
    cfg.humanAuth.enabled = false;

    const bridge = new HumanAuthBridge(cfg);
    const outPath = bridge.saveArtifact("req-audio-ext", {
      mimeType: "audio/webm;codecs=opus",
      base64: Buffer.from("audio-bytes").toString("base64"),
    });

    assert.equal(Boolean(outPath), true);
    assert.equal(path.extname(outPath), ".webm");
    assert.equal(fs.existsSync(outPath), true);
  });
});
