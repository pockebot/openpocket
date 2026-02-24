import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { HumanAuthRelayServer } = await import("../dist/human-auth/relay-server.js");

test("HumanAuthRelayServer create, resolve, and poll lifecycle", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-auth-relay-"));
  const stateFile = path.join(temp, "relay-state.json");
  const apiKey = "relay-test-key";

  const relay = new HumanAuthRelayServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "",
    apiKey,
    apiKeyEnv: "OPENPOCKET_HUMAN_AUTH_KEY",
    stateFile,
  });

  await relay.start();
  const base = relay.address;
  assert.equal(base.startsWith("http://"), true);

  try {
    const createResponse = await fetch(`${base}/v1/human-auth/requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        requestId: "req-test-1",
        task: "camera unblock",
        sessionId: "session-1",
        step: 2,
        capability: "camera",
        instruction: "Take a photo",
        reason: "Need real camera",
        timeoutSec: 90,
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();

    assert.equal(created.requestId, "req-test-1");
    assert.match(created.openUrl, /\/human-auth\/req-test-1\?token=/);
    assert.equal(typeof created.pollToken, "string");

    const openUrl = new URL(created.openUrl);
    const openToken = openUrl.searchParams.get("token");
    assert.equal(Boolean(openToken), true);

    const pollPending = await fetch(
      `${base}/v1/human-auth/requests/req-test-1?pollToken=${encodeURIComponent(created.pollToken)}`,
    );
    assert.equal(pollPending.status, 200);
    const pendingBody = await pollPending.json();
    assert.equal(pendingBody.status, "pending");

    const resolveResponse = await fetch(`${base}/v1/human-auth/requests/req-test-1/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        token: openToken,
        approved: true,
        note: "Approved from test",
        artifact: {
          mimeType: "image/jpeg",
          base64: Buffer.from("ok").toString("base64"),
        },
      }),
    });
    assert.equal(resolveResponse.status, 200);
    const resolvedBody = await resolveResponse.json();
    assert.equal(resolvedBody.status, "approved");

    const pollApproved = await fetch(
      `${base}/v1/human-auth/requests/req-test-1?pollToken=${encodeURIComponent(created.pollToken)}`,
    );
    assert.equal(pollApproved.status, 200);
    const approvedBody = await pollApproved.json();
    assert.equal(approvedBody.status, "approved");
    assert.equal(approvedBody.note, "Approved from test");
    assert.equal(approvedBody.artifact.mimeType, "image/jpeg");

    assert.equal(fs.existsSync(stateFile), true);
  } finally {
    await relay.stop();
  }
});

test("HumanAuthRelayServer exposes takeover snapshot/action APIs with open token", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-auth-relay-takeover-"));
  const stateFile = path.join(temp, "relay-state.json");
  const executed = [];
  const frame = {
    deviceId: "emulator-5554",
    currentApp: "com.android.chrome",
    width: 1080,
    height: 2400,
    screenshotBase64: Buffer.from("png").toString("base64"),
    capturedAt: new Date().toISOString(),
  };

  const relay = new HumanAuthRelayServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    stateFile,
    takeoverRuntime: {
      captureFrame: async () => frame,
      execute: async (action) => {
        executed.push(action);
        return "action-ok";
      },
    },
  });

  await relay.start();
  const base = relay.address;

  try {
    const createResponse = await fetch(`${base}/v1/human-auth/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-takeover-1",
        task: "oauth login",
        sessionId: "session-takeover",
        step: 3,
        capability: "oauth",
        instruction: "Remote login takeover",
        reason: "Need human account authorization",
        timeoutSec: 180,
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    const openUrl = new URL(created.openUrl);
    const token = openUrl.searchParams.get("token");
    assert.equal(Boolean(token), true);

    const portalRes = await fetch(
      `${base}/human-auth/req-takeover-1?token=${encodeURIComponent(String(token || ""))}`,
    );
    assert.equal(portalRes.status, 200);
    const portalHtml = await portalRes.text();
    assert.match(portalHtml, /Authorization Required/);
    assert.match(portalHtml, /Username \/ Email/);
    assert.match(portalHtml, /Optional Remote Takeover \(Live\)/);
    assert.match(portalHtml, /Open Live Stream/);

    const snapshotRes = await fetch(
      `${base}/v1/human-auth/requests/req-takeover-1/takeover/snapshot?token=${encodeURIComponent(token)}`,
    );
    assert.equal(snapshotRes.status, 200);
    const snapshotBody = await snapshotRes.json();
    assert.equal(snapshotBody.frame.currentApp, "com.android.chrome");
    assert.equal(snapshotBody.frame.width, 1080);

    const actionRes = await fetch(`${base}/v1/human-auth/requests/req-takeover-1/takeover/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        action: { type: "tap", x: 320, y: 640 },
      }),
    });
    assert.equal(actionRes.status, 200);
    const actionBody = await actionRes.json();
    assert.equal(actionBody.message, "action-ok");
    assert.equal(executed.length, 1);
    assert.equal(executed[0].type, "tap");
    assert.equal(executed[0].x, 320);
    assert.equal(executed[0].y, 640);

    const streamRes = await fetch(
      `${base}/v1/human-auth/requests/req-takeover-1/takeover/stream?token=${encodeURIComponent(token)}`,
    );
    assert.equal(streamRes.status, 200);
    assert.match(String(streamRes.headers.get("content-type") || ""), /multipart\/x-mixed-replace/i);
    const reader = streamRes.body?.getReader();
    if (reader) {
      await reader.read();
      await reader.cancel();
    }
  } finally {
    await relay.stop();
  }
});
