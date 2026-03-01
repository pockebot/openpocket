import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { HumanAuthBridge } = await import("../dist/human-auth/bridge.js");
const { HumanAuthRelayServer } = await import("../dist/human-auth/relay-server.js");

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

async function readFirstSseDecision(response, timeoutMs = 5_000) {
  assert.ok(response.body, "Expected SSE response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  const readWithTimeout = async (remainingMs) => {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for SSE decision event.")), remainingMs);
      }),
    ]);
  };

  try {
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const { done, value } = await readWithTimeout(remainingMs);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const parsed = JSON.parse(line.slice(6));
        if (parsed && typeof parsed.status === "string" && parsed.status !== "pending") {
          return parsed;
        }
      }
    }
    throw new Error("No resolved SSE decision event was received.");
  } finally {
    await reader.cancel();
  }
}

function makeBridgeRequest(capability, timeoutSec = 60) {
  return {
    sessionId: `session-${Date.now()}`,
    sessionPath: "/tmp/session.md",
    task: `human auth ${capability} test`,
    step: 1,
    capability,
    instruction: `Please authorize ${capability}.`,
    reason: `e2e_no_browser_${capability}`,
    timeoutSec,
    currentApp: "com.example.app",
    screenshotPath: null,
  };
}

test("HumanAuthRelayServer SSE decision stream works without browser", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-auth-sse-e2e-"));
  const relay = new HumanAuthRelayServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    stateFile: path.join(temp, "relay-state.json"),
  });

  await relay.start();
  const base = relay.address;
  try {
    const requestId = `req-sse-${Date.now()}`;
    const createdResponse = await fetch(`${base}/v1/human-auth/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId,
        task: "SSE no-browser test",
        sessionId: "session-sse",
        step: 3,
        capability: "camera",
        instruction: "Approve camera delegation",
        reason: "sse-no-browser",
        timeoutSec: 120,
      }),
    });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    const openUrl = new URL(created.openUrl);
    const openToken = String(openUrl.searchParams.get("token") || "");
    assert.equal(Boolean(openToken), true);

    const sseResponse = await fetch(
      `${base}/v1/human-auth/requests/${encodeURIComponent(requestId)}/events?pollToken=${encodeURIComponent(created.pollToken)}`,
      { headers: { accept: "text/event-stream" } },
    );
    assert.equal(sseResponse.status, 200);
    assert.match(String(sseResponse.headers.get("content-type") || ""), /text\/event-stream/i);

    const decisionPromise = readFirstSseDecision(sseResponse, 8_000);
    const resolveResponse = await fetch(`${base}/v1/human-auth/requests/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: openToken,
        approved: true,
        note: "Approved from SSE test",
        artifact: {
          mimeType: "application/json",
          base64: Buffer.from(JSON.stringify({ kind: "text", value: "ok" })).toString("base64"),
        },
      }),
    });
    assert.equal(resolveResponse.status, 200);

    const sseDecision = await decisionPromise;
    assert.equal(sseDecision.requestId, requestId);
    assert.equal(sseDecision.status, "approved");
    assert.equal(sseDecision.note, "Approved from SSE test");
    assert.equal(sseDecision.artifact.mimeType, "application/json");
  } finally {
    await relay.stop();
  }
});

test("HumanAuthBridge audio artifact roundtrip works without browser", async () => {
  await withTempHome("openpocket-auth-bridge-audio-e2e-", async (home) => {
    const relay = new HumanAuthRelayServer({
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "",
      apiKey: "",
      apiKeyEnv: "",
      stateFile: path.join(home, "relay-state.json"),
    });
    await relay.start();

    try {
      const cfg = loadConfig();
      cfg.humanAuth.enabled = true;
      cfg.humanAuth.relayBaseUrl = relay.address;
      cfg.humanAuth.publicBaseUrl = "";
      cfg.humanAuth.apiKey = "";
      cfg.humanAuth.apiKeyEnv = "";
      cfg.humanAuth.pollIntervalMs = 150;

      const bridge = new HumanAuthBridge(cfg);
      let openedContext = null;

      let resolveOpened;
      const openedContextPromise = new Promise((resolve) => {
        resolveOpened = resolve;
      });

      const decisionPromise = bridge.requestAndWait(
        {
          chatId: 12345,
          task: "no-browser audio roundtrip",
          request: makeBridgeRequest("microphone"),
        },
        (opened) => {
          openedContext = opened;
          resolveOpened(opened);
        },
      );

      await openedContextPromise;
      const openUrl = new URL(String(openedContext?.openUrl || ""));
      const token = String(openUrl.searchParams.get("token") || "");
      const requestId = String(openedContext?.requestId || "");
      assert.equal(Boolean(token), true);
      assert.equal(Boolean(requestId), true);
      assert.equal(Boolean(openedContext?.relayEnabled), true);

      const resolveResponse = await fetch(
        `${relay.address}/v1/human-auth/requests/${encodeURIComponent(requestId)}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            approved: true,
            note: "audio approved",
            artifact: {
              mimeType: "audio/webm;codecs=opus",
              base64: Buffer.from("audio-e2e-no-browser").toString("base64"),
            },
          }),
        },
      );
      assert.equal(resolveResponse.status, 200);

      const decision = await decisionPromise;
      assert.equal(decision.status, "approved");
      assert.equal(decision.approved, true);
      assert.equal(path.extname(String(decision.artifactPath || "")), ".webm");
      assert.equal(fs.existsSync(String(decision.artifactPath || "")), true);
      const raw = fs.readFileSync(String(decision.artifactPath), "utf-8");
      assert.equal(raw, "audio-e2e-no-browser");
      assert.equal(bridge.listPending().length, 0);
      if (decision.artifactPath) {
        fs.rmSync(decision.artifactPath, { force: true });
      }
    } finally {
      await relay.stop();
    }
  });
});

test("HumanAuthBridge photos_multi artifact roundtrip works without browser", async () => {
  await withTempHome("openpocket-auth-bridge-photos-e2e-", async (home) => {
    const relay = new HumanAuthRelayServer({
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: "",
      apiKey: "",
      apiKeyEnv: "",
      stateFile: path.join(home, "relay-state.json"),
    });
    await relay.start();

    try {
      const cfg = loadConfig();
      cfg.humanAuth.enabled = true;
      cfg.humanAuth.relayBaseUrl = relay.address;
      cfg.humanAuth.publicBaseUrl = "";
      cfg.humanAuth.apiKey = "";
      cfg.humanAuth.apiKeyEnv = "";
      cfg.humanAuth.pollIntervalMs = 150;

      const bridge = new HumanAuthBridge(cfg);
      let resolveOpened;
      const openedContextPromise = new Promise((resolve) => {
        resolveOpened = resolve;
      });

      const decisionPromise = bridge.requestAndWait(
        {
          chatId: 12345,
          task: "no-browser photos_multi roundtrip",
          request: makeBridgeRequest("files"),
        },
        (opened) => {
          resolveOpened(opened);
        },
      );

      const opened = await openedContextPromise;
      const openUrl = new URL(String(opened?.openUrl || ""));
      const token = String(openUrl.searchParams.get("token") || "");
      const requestId = String(opened?.requestId || "");
      assert.equal(Boolean(token), true);
      assert.equal(Boolean(requestId), true);

      const payload = {
        kind: "photos_multi",
        count: 2,
        photos: [
          {
            name: "a.jpg",
            mimeType: "image/jpeg",
            base64: Buffer.from("img-a").toString("base64"),
          },
          {
            name: "b.png",
            mimeType: "image/png",
            base64: Buffer.from("img-b").toString("base64"),
          },
        ],
      };

      const resolveResponse = await fetch(
        `${relay.address}/v1/human-auth/requests/${encodeURIComponent(requestId)}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            approved: true,
            note: "photos approved",
            artifact: {
              mimeType: "application/json",
              base64: Buffer.from(JSON.stringify(payload)).toString("base64"),
            },
          }),
        },
      );
      assert.equal(resolveResponse.status, 200);

      const decision = await decisionPromise;
      assert.equal(decision.status, "approved");
      assert.equal(path.extname(String(decision.artifactPath || "")), ".json");
      const decoded = JSON.parse(fs.readFileSync(String(decision.artifactPath), "utf-8"));
      assert.equal(decoded.kind, "photos_multi");
      assert.equal(decoded.count, 2);
      assert.equal(Array.isArray(decoded.photos), true);
      assert.equal(decoded.photos.length, 2);
      assert.equal(bridge.listPending().length, 0);
      if (decision.artifactPath) {
        fs.rmSync(decision.artifactPath, { force: true });
      }
    } finally {
      await relay.stop();
    }
  });
});
