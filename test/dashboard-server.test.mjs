import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { DashboardServer } = await import("../dist/dashboard/server.js");

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

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${response.status}`);
  }
  return payload;
}

async function requestJsonExpectError(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json();
  assert.equal(response.ok, false);
  assert.equal(payload.ok, false);
  return payload;
}

test("dashboard server exposes health/config and prompt CRUD APIs", async () => {
  await withTempHome("openpocket-dashboard-server-", async () => {
    const cfg = loadConfig();
    const server = new DashboardServer({
      config: cfg,
      mode: "standalone",
      host: "127.0.0.1",
      port: 0,
    });

    await server.start();
    const base = server.address;
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

    try {
      const health = await requestJson(base, "/api/health");
      assert.equal(health.ok, true);

      const configPayload = await requestJson(base, "/api/config");
      assert.equal(typeof configPayload.config.projectName, "string");
      assert.equal(typeof configPayload.credentialStatus, "object");

      const promptFile = path.join(cfg.workspaceDir, "TEST_PROMPT.md");

      const added = await requestJson(base, "/api/prompts/add", {
        method: "POST",
        body: JSON.stringify({ title: "TEST", path: promptFile }),
      });
      assert.equal(Array.isArray(added.promptFiles), true);
      const target = added.promptFiles.find((item) => item.path === promptFile);
      assert.equal(Boolean(target), true);

      await requestJson(base, "/api/prompts/save", {
        method: "POST",
        body: JSON.stringify({ id: target.id, content: "hello prompt" }),
      });

      const read = await requestJson(base, "/api/prompts/read", {
        method: "POST",
        body: JSON.stringify({ id: target.id }),
      });
      assert.equal(read.content, "hello prompt");
      assert.equal(fs.existsSync(promptFile), true);

      const removed = await requestJson(base, "/api/prompts/remove", {
        method: "POST",
        body: JSON.stringify({ id: target.id }),
      });
      const stillExists = removed.promptFiles.some((item) => item.id === target.id);
      assert.equal(stillExists, false);
    } finally {
      await server.stop();
    }
  });
});

test("dashboard permission scope does not leak sibling paths with shared prefix", async () => {
  await withTempHome("openpocket-dashboard-scope-", async () => {
    const cfg = loadConfig();
    const server = new DashboardServer({
      config: cfg,
      mode: "standalone",
      host: "127.0.0.1",
      port: 0,
    });

    const safeDir = path.join(cfg.workspaceDir, "safe");
    const unsafeDir = path.join(cfg.workspaceDir, "safe2");
    fs.mkdirSync(safeDir, { recursive: true });
    fs.mkdirSync(unsafeDir, { recursive: true });
    fs.writeFileSync(path.join(safeDir, "ok.txt"), "allowed", "utf-8");
    fs.writeFileSync(path.join(unsafeDir, "leak.txt"), "blocked", "utf-8");

    await server.start();
    const base = server.address;

    try {
      await requestJson(base, "/api/control-settings", {
        method: "POST",
        body: JSON.stringify({
          permission: {
            allowLocalStorageView: true,
            storageDirectoryPath: cfg.workspaceDir,
            allowedSubpaths: ["safe"],
            allowedExtensions: ["txt"],
          },
        }),
      });

      const files = await requestJson(base, "/api/permissions/files");
      assert.equal(Array.isArray(files.files), true);
      assert.equal(files.files.some((item) => item.endsWith("/safe/ok.txt")), true);
      assert.equal(files.files.some((item) => item.endsWith("/safe2/leak.txt")), false);

      const denied = await requestJsonExpectError(base, "/api/permissions/read-file", {
        method: "POST",
        body: JSON.stringify({
          path: path.join(unsafeDir, "leak.txt"),
        }),
      });
      assert.match(String(denied.error), /outside allowed scope/i);
    } finally {
      await server.stop();
    }
  });
});

test("dashboard trace API returns grouped runs and actions from session jsonl", async () => {
  await withTempHome("openpocket-dashboard-traces-", async () => {
    const cfg = loadConfig();
    const sessionsDir = path.join(cfg.workspaceDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionPath = path.join(sessionsDir, "session-trace-demo.jsonl");
    const fallbackStepText = [
      "step: 2",
      "at: 2026-02-24T10:00:05.500Z",
      "thought:",
      "Tap the inbox label.",
      "action_json:",
      JSON.stringify({ type: "tap", x: 100, y: 220 }, null, 2),
      "execution_result:",
      "Action execution error: element not found",
    ].join("\n");

    const lines = [
      {
        type: "session",
        id: "trace-demo",
        version: 1,
        cwd: cfg.workspaceDir,
        timestamp: "2026-02-24T10:00:00.000Z",
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Open Gmail and check new email." }],
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:01.200Z",
        message: {
          role: "custom",
          customType: "openpocket_session_meta",
          content: [{ type: "text", text: "model_profile: gpt-5\nmodel_name: gpt-5" }],
          details: {
            modelProfile: "gpt-5",
            modelName: "gpt-5",
          },
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:03.000Z",
        message: {
          role: "custom",
          customType: "openpocket_action_trace",
          content: [{ type: "text", text: "step: 1" }],
          details: {
            stepNo: 1,
            actionType: "launch_app",
            currentApp: "com.google.android.apps.gmail",
            status: "ok",
            startedAt: "2026-02-24T10:00:01.500Z",
            endedAt: "2026-02-24T10:00:03.000Z",
            durationMs: 1500,
            reasoning: "Launch Gmail first.",
            result: "App launched.",
          },
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:05.500Z",
        message: {
          role: "custom",
          customType: "openpocket_step",
          content: [{ type: "text", text: fallbackStepText }],
          details: {
            stepNo: 2,
            trace: {
              actionType: "tap",
              currentApp: "com.google.android.apps.gmail",
              startedAt: "2026-02-24T10:00:04.000Z",
              endedAt: "2026-02-24T10:00:05.500Z",
              durationMs: 1500,
              status: "error",
            },
          },
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:06.000Z",
        message: {
          role: "assistant",
          model: "session-task-outcome",
          stopReason: "error",
          content: [{ type: "text", text: "Gmail could not be checked." }],
        },
      },
    ];
    fs.writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");

    const server = new DashboardServer({
      config: cfg,
      mode: "standalone",
      host: "127.0.0.1",
      port: 0,
    });
    await server.start();
    const base = server.address;

    try {
      const payload = await requestJson(base, "/api/traces?limit=5");
      assert.equal(Array.isArray(payload.runs), true);

      const run = payload.runs.find((item) => item.sessionId === "trace-demo");
      assert.equal(Boolean(run), true);
      assert.equal(run.status, "failed");
      assert.equal(run.modelProfile, "gpt-5");
      assert.equal(run.modelName, "gpt-5");
      assert.equal(run.actions.length, 2);

      const stepOne = run.actions.find((item) => item.stepNo === 1);
      const stepTwo = run.actions.find((item) => item.stepNo === 2);

      assert.equal(stepOne.actionType, "launch_app");
      assert.equal(stepOne.status, "ok");
      assert.equal(stepOne.durationMs, 1500);

      assert.equal(stepTwo.actionType, "tap");
      assert.equal(stepTwo.status, "error");
      assert.equal(stepTwo.currentApp, "com.google.android.apps.gmail");
      assert.match(stepTwo.reasoning, /Tap the inbox label/i);
      assert.match(stepTwo.result, /element not found/i);
    } finally {
      await server.stop();
    }
  });
});

test("dashboard trace API splits multi-task reused session into separate runs", async () => {
  await withTempHome("openpocket-dashboard-traces-multi-", async () => {
    const cfg = loadConfig();
    const sessionsDir = path.join(cfg.workspaceDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionPath = path.join(sessionsDir, "session-multi-run.jsonl");
    const lines = [
      {
        type: "session",
        id: "multi-run-demo",
        version: 1,
        cwd: cfg.workspaceDir,
        timestamp: "2026-02-24T10:00:00.000Z",
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Open Gmail and check new email." }],
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:01.200Z",
        message: {
          role: "custom",
          customType: "openpocket_session_meta",
          content: [{ type: "text", text: "model_profile: gpt-5\nmodel_name: gpt-5" }],
          details: { modelProfile: "gpt-5", modelName: "gpt-5" },
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:03.000Z",
        message: {
          role: "custom",
          customType: "openpocket_action_trace",
          content: [{ type: "text", text: "step: 1" }],
          details: {
            stepNo: 1,
            actionType: "launch_app",
            currentApp: "com.google.android.apps.gmail",
            status: "ok",
            startedAt: "2026-02-24T10:00:01.500Z",
            endedAt: "2026-02-24T10:00:03.000Z",
            durationMs: 1500,
            reasoning: "Launch Gmail first.",
            result: "App launched.",
          },
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T10:00:06.000Z",
        message: {
          role: "assistant",
          model: "session-task-outcome",
          stopReason: "stop",
          content: [{ type: "text", text: "Gmail opened and new email checked." }],
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T11:30:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Search for Nike Mind 02 on GOAT." }],
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T11:30:00.200Z",
        message: {
          role: "custom",
          customType: "openpocket_session_meta",
          content: [{ type: "text", text: "model_profile: gpt-5\nmodel_name: gpt-5" }],
          details: { modelProfile: "gpt-5", modelName: "gpt-5" },
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T11:30:02.000Z",
        message: {
          role: "custom",
          customType: "openpocket_action_trace",
          content: [{ type: "text", text: "step: 1" }],
          details: {
            stepNo: 1,
            actionType: "launch_app",
            currentApp: "com.goat.app",
            status: "ok",
            startedAt: "2026-02-24T11:30:00.500Z",
            endedAt: "2026-02-24T11:30:02.000Z",
            durationMs: 1500,
            reasoning: "Open GOAT app.",
            result: "App launched.",
          },
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T11:30:05.000Z",
        message: {
          role: "custom",
          customType: "openpocket_action_trace",
          content: [{ type: "text", text: "step: 2" }],
          details: {
            stepNo: 2,
            actionType: "type",
            currentApp: "com.goat.app",
            status: "ok",
            startedAt: "2026-02-24T11:30:03.000Z",
            endedAt: "2026-02-24T11:30:05.000Z",
            durationMs: 2000,
            reasoning: "Type Nike Mind 02 in search.",
            result: "Text typed.",
          },
        },
      },
      {
        type: "message",
        timestamp: "2026-02-24T11:30:08.000Z",
        message: {
          role: "assistant",
          model: "session-task-outcome",
          stopReason: "stop",
          content: [{ type: "text", text: "Found Nike Mind 02 on GOAT for $189." }],
        },
      },
    ];
    fs.writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");

    const server = new DashboardServer({
      config: cfg,
      mode: "standalone",
      host: "127.0.0.1",
      port: 0,
    });
    await server.start();
    const base = server.address;

    try {
      const payload = await requestJson(base, "/api/traces?limit=10");
      assert.equal(Array.isArray(payload.runs), true);

      const runs = payload.runs.filter((item) => item.sessionId.startsWith("multi-run-demo"));
      assert.equal(runs.length, 2, "should produce 2 runs from the same reused session file");

      const nikeRun = runs.find((item) => item.task.includes("Nike"));
      const gmailRun = runs.find((item) => item.task.includes("Gmail"));

      assert.equal(Boolean(nikeRun), true);
      assert.equal(Boolean(gmailRun), true);

      assert.equal(nikeRun.task, "Search for Nike Mind 02 on GOAT.");
      assert.equal(nikeRun.status, "success");
      assert.equal(nikeRun.actions.length, 2);
      assert.equal(nikeRun.actions[0].actionType, "launch_app");
      assert.equal(nikeRun.actions[1].actionType, "type");

      assert.equal(gmailRun.task, "Open Gmail and check new email.");
      assert.equal(gmailRun.status, "success");
      assert.equal(gmailRun.actions.length, 1);
      assert.equal(gmailRun.actions[0].actionType, "launch_app");

      assert.equal(gmailRun.durationMs, 5000);
      assert.equal(nikeRun.durationMs, 8000);

      assert.match(gmailRun.finalMessage, /Gmail opened/);
      assert.match(nikeRun.finalMessage, /Nike Mind 02/);

      const nikeIdx = payload.runs.indexOf(nikeRun);
      const gmailIdx = payload.runs.indexOf(gmailRun);
      assert.equal(nikeIdx < gmailIdx, true, "most recent run (Nike) should appear first");
    } finally {
      await server.stop();
    }
  });
});
