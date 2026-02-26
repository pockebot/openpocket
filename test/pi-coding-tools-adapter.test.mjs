import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { AgentRuntime } = await import("../dist/agent/agent-runtime.js");
const { PiCodingToolsExecutor } = await import("../dist/agent/pi-coding-tools.js");

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

function makePhoneCtx(task = "pi coding tools adapter test") {
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

test("PiCodingToolsExecutor supports read/write/edit path with workspace files", async () => {
  await withTempHome("openpocket-pi-coding-tools-", async () => {
    const cfg = loadConfig();
    const executor = new PiCodingToolsExecutor(cfg);

    const writeOut = await executor.execute({
      type: "write",
      path: "pi_tools/smoke.js",
      content: "console.log('pi-tools-ok');\n",
      append: false,
    });
    assert.match(String(writeOut), /Successfully wrote/i);

    const readOut = await executor.execute({
      type: "read",
      path: "pi_tools/smoke.js",
      from: 1,
      lines: 20,
    });
    assert.match(String(readOut), /pi-tools-ok/);

    const editOut = await executor.execute({
      type: "edit",
      path: "pi_tools/smoke.js",
      find: "pi-tools-ok",
      replace: "pi-tools-ok-v2",
      replaceAll: false,
    });
    assert.match(String(editOut), /Successfully replaced text/i);
  });
});

test("PiCodingToolsExecutor returns null for unsupported compatibility actions", async () => {
  await withTempHome("openpocket-pi-coding-tools-compat-", async () => {
    const cfg = loadConfig();
    const executor = new PiCodingToolsExecutor(cfg);

    const applyPatchOut = await executor.execute({
      type: "apply_patch",
      input: "*** Begin Patch\n*** End Patch\n",
    });
    assert.equal(applyPatchOut, null);

    const processOut = await executor.execute({
      type: "process",
      action: "list",
    });
    assert.equal(processOut, null);
  });
});

test("AgentRuntime prefers pi coding backend before legacy fallback", async () => {
  await withTempHome("openpocket-runtime-pi-primary-", async () => {
    const cfg = loadConfig();
    cfg.agent.verbose = false;
    cfg.screenshots.saveStepScreenshots = false;
    const runtime = new AgentRuntime(cfg);

    let legacyCalls = 0;
    runtime.piCodingToolsExecutor = {
      execute: async () => "pi-path-ok",
    };
    runtime.codingExecutor = {
      execute: async () => {
        legacyCalls += 1;
        return "legacy-should-not-run";
      },
    };

    const out = await runtime.executePhoneAction(
      { type: "write", path: "smoke/pi.txt", content: "ok" },
      makePhoneCtx(),
    );

    assert.match(out, /pi-path-ok/);
    assert.match(out, /\[coding_backend=pi_coding_tools\]/);
    assert.equal(legacyCalls, 0);
  });
});

test("AgentRuntime falls back to legacy coding executor when pi backend returns null", async () => {
  await withTempHome("openpocket-runtime-pi-fallback-", async () => {
    const cfg = loadConfig();
    cfg.agent.verbose = false;
    cfg.screenshots.saveStepScreenshots = false;
    cfg.agent.legacyCodingExecutor = true;
    const runtime = new AgentRuntime(cfg);

    let legacyCalls = 0;
    runtime.piCodingToolsExecutor = {
      execute: async () => null,
    };
    runtime.codingExecutor = {
      execute: async () => {
        legacyCalls += 1;
        return "legacy-path-ok";
      },
    };

    const out = await runtime.executePhoneAction(
      { type: "process", action: "list" },
      makePhoneCtx(),
    );

    assert.match(out, /legacy-path-ok/);
    assert.match(out, /\[coding_backend=legacy_coding_executor\]/);
    assert.equal(legacyCalls, 1);
  });
});

test("AgentRuntime fails fast when legacy fallback is disabled and pi backend is unsupported", async () => {
  await withTempHome("openpocket-runtime-pi-no-legacy-", async () => {
    const cfg = loadConfig();
    cfg.agent.verbose = false;
    cfg.screenshots.saveStepScreenshots = false;
    cfg.agent.legacyCodingExecutor = false;
    const runtime = new AgentRuntime(cfg);

    runtime.piCodingToolsExecutor = {
      execute: async () => null,
    };
    runtime.codingExecutor = {
      execute: async () => "legacy-should-not-run",
    };

    const out = await runtime.executePhoneAction(
      { type: "process", action: "list" },
      makePhoneCtx(),
    );

    assert.match(out, /Action execution error/i);
    assert.match(out, /legacy fallback is disabled/i);
  });
});
