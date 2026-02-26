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

    const portalRes = await fetch(
      `${base}/human-auth/req-test-1?token=${encodeURIComponent(String(openToken || ""))}`,
    );
    assert.equal(portalRes.status, 200);
    const portalHtml = await portalRes.text();
    assert.match(portalHtml, /Camera Preview \(Human Phone\)/);
    assert.match(portalHtml, /Take Photo & Continue/);
    assert.match(portalHtml, /Upload From Album/);
    assert.match(portalHtml, /Requesting camera access on your Human Phone/);

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
    assert.match(portalHtml, /Agent-Generated Authorization Form/);
    assert.match(portalHtml, /Optional Remote Takeover \(Live\)/);
    assert.match(portalHtml, /Open Live Stream/);
    assert.match(portalHtml, /font-family:\s*"Avenir Next", "Segoe UI", sans-serif;/);
    assert.match(portalHtml, /<b>Template<\/b>human-auth-generic \(default-shell\)/);
    assert.match(portalHtml, /new Function\("api",\s*"'use strict';/);
    assert.doesNotMatch(portalHtml, /new Function\("api",\s*""use strict";/);
    assert.doesNotMatch(portalHtml, /fonts\.googleapis\.com\/css2\?family=Poppins/i);

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

test("HumanAuthRelayServer merges uiTemplate and enforces artifact on approve", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-auth-relay-template-"));
  const stateFile = path.join(temp, "relay-state.json");

  const relay = new HumanAuthRelayServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    stateFile,
  });

  await relay.start();
  const base = relay.address;

  try {
    const createResponse = await fetch(`${base}/v1/human-auth/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-template-1",
        task: "payment fill",
        sessionId: "session-template",
        step: 8,
        capability: "payment",
        instruction: "Complete checkout with delegated payment card info.",
        reason: "Need secure human payment authorization.",
        timeoutSec: 180,
        uiTemplate: {
          templateId: "custom-payment-template",
          title: "Checkout Authorization",
          summary: "Provide card details from Human Phone to continue.",
          artifactKind: "payment_card",
          requireArtifactOnApprove: true,
          middleHtml: "<div><label for=\"payment_hint\">Payment Hint</label><input id=\"payment_hint\" type=\"text\" /></div>",
          middleScript: "api.setStatus('custom middle script loaded');",
          approveScript: "const v = api.getValue('payment_hint').trim(); if (!v) return { ok: false, error: 'payment hint is required' }; return { artifactJson: { kind: 'payment_card', fields: { payment_hint: v } } };",
          fields: [
            { id: "card_number", label: "Card Number", type: "card-number", required: true },
            { id: "expiry", label: "Expiration", type: "expiry", required: true },
            { id: "cvc", label: "CVC", type: "cvc", required: true },
          ],
          style: {
            brandColor: "#228be6",
            backgroundCss: "linear-gradient(145deg, #f7fbff 0%, #eef6ff 100%)",
            fontFamily: "Poppins, serif",
          },
        },
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    const openUrl = new URL(created.openUrl);
    const token = String(openUrl.searchParams.get("token") || "");
    assert.equal(Boolean(token), true);

    const portalRes = await fetch(`${base}/human-auth/req-template-1?token=${encodeURIComponent(token)}`);
    assert.equal(portalRes.status, 200);
    const portalHtml = await portalRes.text();
    assert.match(portalHtml, /custom-payment-template/);
    assert.match(portalHtml, /Checkout Authorization/);
    assert.match(portalHtml, /<b>Template<\/b>custom-payment-template \(agent-generated-ui-template\)/);
    assert.match(portalHtml, /#228be6/);
    assert.match(portalHtml, /payment_hint/);
    assert.match(portalHtml, /custom middle script loaded/);
    assert.match(portalHtml, /Approval script timed out\. Please retry\./);
    assert.match(portalHtml, /Attach data below, then tap Approve and Continue again\./);
    assert.match(portalHtml, /This request requires a photo from your Human Phone\./);
    assert.match(portalHtml, /font-family:\s*"Avenir Next", "Segoe UI", sans-serif;/);
    assert.doesNotMatch(portalHtml, /Poppins, serif/);

    const resolveWithoutArtifact = await fetch(`${base}/v1/human-auth/requests/req-template-1/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        approved: true,
        note: "approve without artifact should fail",
      }),
    });
    assert.equal(resolveWithoutArtifact.status, 400);
    const resolveWithoutArtifactBody = await resolveWithoutArtifact.json();
    assert.match(String(resolveWithoutArtifactBody.error || ""), /requires delegated data artifact/i);

    const pollPending = await fetch(
      `${base}/v1/human-auth/requests/req-template-1?pollToken=${encodeURIComponent(created.pollToken)}`,
    );
    assert.equal(pollPending.status, 200);
    const pendingBody = await pollPending.json();
    assert.equal(pendingBody.status, "pending");

    const resolveWithArtifact = await fetch(`${base}/v1/human-auth/requests/req-template-1/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        approved: true,
        note: "approved with payment artifact",
        artifact: {
          mimeType: "application/json",
          base64: Buffer.from(JSON.stringify({
            kind: "payment_card",
            card_number: "4111111111111111",
            expiry: "12/29",
            cvc: "123",
          })).toString("base64"),
        },
      }),
    });
    assert.equal(resolveWithArtifact.status, 200);
    const resolved = await resolveWithArtifact.json();
    assert.equal(resolved.status, "approved");
  } finally {
    await relay.stop();
  }
});

test("HumanAuthRelayServer does not persist payment artifacts to state file", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-auth-relay-payment-"));
  const stateFile = path.join(temp, "relay-state.json");

  const relay = new HumanAuthRelayServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    stateFile,
  });

  await relay.start();
  const base = relay.address;

  try {
    const createResponse = await fetch(`${base}/v1/human-auth/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-payment-1",
        task: "pay parking",
        sessionId: "session-payment",
        step: 16,
        capability: "payment",
        instruction: "Enter card details",
        reason: "Sensitive payment data required",
        timeoutSec: 180,
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    const openUrl = new URL(created.openUrl);
    const token = String(openUrl.searchParams.get("token") || "");
    assert.equal(Boolean(token), true);

    const paymentArtifact = {
      kind: "payment_card_v1",
      cardNumber: "4111111111111111",
      expiry: "02/32",
      cvc: "182",
      capability: "payment",
    };
    const resolveResponse = await fetch(`${base}/v1/human-auth/requests/req-payment-1/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        token,
        approved: true,
        note: "4111111111111111 02/32 182",
        artifact: {
          mimeType: "application/json",
          base64: Buffer.from(JSON.stringify(paymentArtifact), "utf-8").toString("base64"),
        },
      }),
    });
    assert.equal(resolveResponse.status, 200);

    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    const record = persisted.find((item) => item.requestId === "req-payment-1");
    assert.equal(Boolean(record), true);
    assert.equal(record.artifact, null);
    assert.equal(record.note, "");
  } finally {
    await relay.stop();
  }
});
