import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { AgentRuntime } = await import("../dist/agent/agent-runtime.js");

function makeSnapshot(overrides = {}) {
  return {
    deviceId: "emulator-5554",
    currentApp: "com.android.launcher3",
    width: 1080,
    height: 2400,
    screenshotBase64: Buffer.from("snapshot").toString("base64"),
    somScreenshotBase64: null,
    capturedAt: new Date().toISOString(),
    scaleX: 1,
    scaleY: 1,
    scaledWidth: 1080,
    scaledHeight: 2400,
    uiElements: [],
    ...overrides,
  };
}

function makePhoneCtx(task = "legacy coding path off test") {
  return {
    task,
    profileKey: "gpt-5.2-codex",
    profile: { model: "gpt-5.2-codex" },
    session: { id: "session-test", path: "/tmp/session-test.jsonl" },
    stepCount: 1,
    maxSteps: 10,
    latestSnapshot: makeSnapshot(),
    recentSnapshotWindow: [],
    lastScreenshotPath: null,
    history: [],
    traces: [],
    finishMessage: null,
    failMessage: null,
    stopRequested: () => false,
    lastAutoPermissionAllowAtMs: 0,
    launchablePackages: [],
    effectivePromptMode: "full",
    systemPrompt: "test",
  };
}

async function withTempHome(prefix, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("legacy coding fallback is disabled by default", async () => {
  await withTempHome("openpocket-legacy-off-default-", async () => {
    const cfg = loadConfig();
    assert.equal(cfg.agent.legacyCodingExecutor, false);
  });
});

test("runtime error points to deprecated legacy key when fallback is off", async () => {
  await withTempHome("openpocket-legacy-off-error-", async () => {
    const cfg = loadConfig();
    cfg.agent.verbose = false;
    cfg.screenshots.saveStepScreenshots = false;
    const runtime = new AgentRuntime(cfg);

    let legacyCalls = 0;
    runtime.piCodingToolsExecutor = {
      execute: async () => null,
    };
    runtime.codingExecutor = {
      execute: async () => {
        legacyCalls += 1;
        return "legacy-should-not-run";
      },
    };

    const out = await runtime.executePhoneAction(
      { type: "process", action: "list" },
      makePhoneCtx(),
    );

    assert.match(out, /Action execution error/i);
    assert.match(out, /agent\.legacyCodingExecutor=true/i);
    assert.match(out, /deprecated/i);
    assert.equal(legacyCalls, 0);
  });
});

test("legacy fallback remains opt-in and emits deprecation warning", async () => {
  await withTempHome("openpocket-legacy-off-optin-", async () => {
    const cfg = loadConfig();
    cfg.agent.verbose = false;
    cfg.screenshots.saveStepScreenshots = false;
    cfg.agent.legacyCodingExecutor = true;
    const runtime = new AgentRuntime(cfg);

    runtime.piCodingToolsExecutor = {
      execute: async () => null,
    };
    runtime.codingExecutor = {
      execute: async () => "legacy-path-ok",
    };

    const out = await runtime.executePhoneAction(
      { type: "process", action: "list" },
      makePhoneCtx(),
    );

    assert.match(out, /legacy-path-ok/i);
    assert.match(out, /\[coding_backend=legacy_coding_executor\]/i);
    assert.match(out, /agent\.legacyCodingExecutor/i);
    assert.match(out, /deprecated/i);
  });
});
