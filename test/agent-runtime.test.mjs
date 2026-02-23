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
    screenshotBase64: "abc",
    capturedAt: new Date().toISOString(),
    scaleX: 1,
    scaleY: 1,
    scaledWidth: 1080,
    scaledHeight: 2400,
    ...overrides,
  };
}

function toToolName(actionType) {
  return actionType === "type" ? "type_text" : actionType;
}

function createAssistantMessage(stepIndex, toolName, args, model) {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: `tc-${stepIndex}`,
      name: toolName,
      arguments: args,
    }],
    api: model?.api ?? "openai-completions",
    provider: model?.provider ?? "openai",
    model: model?.id ?? "mock-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function createAssistantTextMessage(text, model) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model?.api ?? "openai-completions",
    provider: model?.provider ?? "openai",
    model: model?.id ?? "mock-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createScriptedAgentFactory(steps, hooks = {}) {
  return (options) => {
    const listeners = new Set();
    const plan = Array.isArray(steps) ? steps : [];
    const followUps = [];
    let idlePromise = Promise.resolve();

    const emit = (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    const run = async () => {
      let messages = [];
      if (hooks.onInit) {
        hooks.onInit(options);
      }

      for (let i = 0; i < plan.length; i += 1) {
        const scripted = typeof plan[i] === "function" ? await plan[i]() : plan[i];
        if (options.transformContext) {
          messages = await options.transformContext(messages);
        }
        if (hooks.captureUserPrompt && options.convertToLlm) {
          const llmMessages = await options.convertToLlm(messages);
          const latestUser = [...llmMessages].reverse().find((item) => item.role === "user");
          const content = Array.isArray(latestUser?.content) ? latestUser.content : [];
          const textBlock = content.find((item) => item.type === "text");
          hooks.captureUserPrompt.push(textBlock?.text ?? "");
        }

        const action = scripted.action;
        const toolName = toToolName(action.type);
        const tool = options.initialState?.tools?.find((item) => item.name === toolName);
        if (!tool) {
          throw new Error(`Tool '${toolName}' not found in scripted agent.`);
        }

        const { type: _type, ...actionArgs } = action;
        const args = {
          thought: scripted.thought ?? "test-thought",
          ...actionArgs,
        };

        await tool.execute(`tc-${i + 1}`, args);
        emit({
          type: "turn_end",
          message: createAssistantMessage(i + 1, toolName, args, options.initialState?.model),
          toolResults: [],
        });

        if (action.type === "finish") {
          break;
        }
      }
    };

    return {
      followUp(message) {
        followUps.push(message);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        idlePromise = run();
        await idlePromise;
      },
      async waitForIdle() {
        await idlePromise;
      },
      get queuedFollowUps() {
        return followUps;
      },
    };
  };
}

function createFinishAbortProbeFactory(hooks = {}) {
  return (options) => {
    const listeners = new Set();
    let idlePromise = Promise.resolve();
    let aborted = false;

    return {
      followUp() {},
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort() {
        aborted = true;
        hooks.abortCalls = (hooks.abortCalls ?? 0) + 1;
      },
      async prompt() {
        idlePromise = (async () => {
          if (options.transformContext) {
            await options.transformContext([]);
          }
          const finishTool = options.initialState?.tools?.find((item) => item.name === "finish");
          if (!finishTool) {
            throw new Error("finish tool not found");
          }

          await finishTool.execute("tc-1", {
            thought: "probe-finish",
            message: "probe finish ok",
          });

          const assistantMessage = createAssistantMessage(
            1,
            "finish",
            { thought: "probe-finish", message: "probe finish ok" },
            options.initialState?.model,
          );
          for (const listener of listeners) {
            listener({
              type: "turn_end",
              message: assistantMessage,
              toolResults: [],
            });
          }

          // Emulate the extra continuation turn that happens after tool calls.
          // Runtime should abort before this branch runs.
          if (!aborted) {
            hooks.secondTurnAttempted = true;
            if (options.transformContext) {
              await options.transformContext([]);
            }
          } else {
            hooks.secondTurnAttempted = false;
          }
        })();
        await idlePromise;
      },
      async waitForIdle() {
        await idlePromise;
      },
      get queuedFollowUps() {
        return [];
      },
    };
  };
}

function createTextFallbackProbeFactory(text, hooks = {}) {
  return (options) => {
    const listeners = new Set();
    let idlePromise = Promise.resolve();

    return {
      followUp() {},
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        idlePromise = (async () => {
          if (options.transformContext) {
            await options.transformContext([]);
          }
          const assistantMessage = createAssistantTextMessage(
            text,
            options.initialState?.model,
          );
          for (const listener of listeners) {
            listener({
              type: "turn_end",
              message: assistantMessage,
              toolResults: [],
            });
          }
          hooks.emitCount = (hooks.emitCount ?? 0) + 1;
        })();
        await idlePromise;
      },
      async waitForIdle() {
        await idlePromise;
      },
      get queuedFollowUps() {
        return [];
      },
    };
  };
}

function setupRuntime({ returnHomeOnTaskEnd, scriptedSteps, hooks, agentFactory }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-runtime-"));
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;

  const cfg = loadConfig();
  cfg.agent.verbose = false;
  cfg.agent.maxSteps = 6;
  cfg.agent.loopDelayMs = 1;
  cfg.agent.returnHomeOnTaskEnd = returnHomeOnTaskEnd;
  cfg.models[cfg.defaultModel].apiKey = "dummy";
  cfg.models[cfg.defaultModel].apiKeyEnv = "MISSING_OPENAI_KEY";

  const runtime = new AgentRuntime(cfg, {
    agentFactory: agentFactory ?? createScriptedAgentFactory(scriptedSteps ?? [], hooks),
  });

  if (prevHome === undefined) {
    delete process.env.OPENPOCKET_HOME;
  } else {
    process.env.OPENPOCKET_HOME = prevHome;
  }

  runtime.autoArtifactBuilder = {
    build: () => ({ skillPath: null, scriptPath: null }),
  };

  return runtime;
}

async function withTempCodexHome(prefix, fn) {
  const prevCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CODEX_HOME = codexHome;
  try {
    return await fn(codexHome);
  } finally {
    if (prevCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevCodexHome;
    }
  }
}

test("AgentRuntime injects BOOTSTRAP guidance into system prompt context", async () => {
  let capturedSystemPrompt = "";
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
    hooks: {
      onInit: (options) => {
        capturedSystemPrompt = options.initialState?.systemPrompt ?? "";
      },
    },
  });

  fs.writeFileSync(
    path.join(runtime.config.workspaceDir, "BOOTSTRAP.md"),
    "# BOOTSTRAP\n\nruntime-bootstrap-check\n",
    "utf-8",
  );

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask("bootstrap context test");
  assert.equal(result.ok, true);
  assert.match(
    capturedSystemPrompt,
    /Instruction priority inside workspace context: AGENTS\.md > BOOTSTRAP\.md > SOUL\.md > other files\./,
  );
  assert.match(capturedSystemPrompt, /### BOOTSTRAP\.md/);
  assert.match(capturedSystemPrompt, /runtime-bootstrap-check/);
});

test("AgentRuntime supports none system prompt mode for constrained runs", async () => {
  let capturedSystemPrompt = "";
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
    hooks: {
      onInit: (options) => {
        capturedSystemPrompt = options.initialState?.systemPrompt ?? "";
      },
    },
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask("prompt none mode test", undefined, undefined, undefined, "none");
  assert.equal(result.ok, true);
  assert.match(capturedSystemPrompt, /Call exactly one tool step at a time/);
  assert.doesNotMatch(capturedSystemPrompt, /Planning Loop/);
});

test("AgentRuntime context report marks hook usage and head-tail truncation", () => {
  const runtime = setupRuntime({ returnHomeOnTaskEnd: false, scriptedSteps: [] });
  const hookDir = path.join(runtime.config.workspaceDir, ".openpocket");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, "bootstrap-context-hook.md"), "hook-line\n", "utf-8");

  const oversized = `${"A".repeat(25_000)}\n${"B".repeat(25_000)}`;
  fs.writeFileSync(path.join(runtime.config.workspaceDir, "AGENTS.md"), oversized, "utf-8");

  const report = runtime.getWorkspacePromptContextReport();
  assert.equal(report.hookApplied, true);
  const hook = report.files.find((item) => item.fileName === "BOOTSTRAP_CONTEXT_HOOK");
  assert.equal(Boolean(hook), true);

  const agents = report.files.find((item) => item.fileName === "AGENTS.md");
  assert.equal(Boolean(agents), true);
  assert.equal(Boolean(agents?.truncated), true);
  assert.match(String(agents?.snippet ?? ""), /truncated: middle content omitted/);
});

test("AgentRuntime returns home after successful task by default", async () => {
  const actionCalls = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: true,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async (action) => {
      actionCalls.push(action);
      return "ok";
    },
  };

  const result = await runtime.runTask("go home test");
  assert.equal(result.ok, true);
  assert.equal(
    actionCalls.some((action) => action.type === "keyevent" && action.keycode === "KEYCODE_HOME"),
    true,
  );
});

test("AgentRuntime does not return home when config is disabled", async () => {
  const actionCalls = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async (action) => {
      actionCalls.push(action);
      return "ok";
    },
  };

  const result = await runtime.runTask("no-home test");
  assert.equal(result.ok, true);
  assert.equal(
    actionCalls.some((action) => action.type === "keyevent" && action.keycode === "KEYCODE_HOME"),
    false,
  );
});

test("AgentRuntime pauses for request_human_auth and resumes after approval", async () => {
  const actions = [];
  const authRequests = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need real camera authorization",
        action: {
          type: "request_human_auth",
          capability: "camera",
          instruction: "Please approve camera access.",
          timeoutSec: 120,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after approval" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };

  const result = await runtime.runTask(
    "human auth resume test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-1",
        approved: true,
        status: "approved",
        message: "Approved by test.",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 1);
  assert.equal(authRequests[0].capability, "camera");
  assert.equal(actions.some((item) => item.type === "request_human_auth"), false);
});

test("AgentRuntime fails when request_human_auth is rejected", async () => {
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{
      thought: "Need OTP",
      action: {
        type: "request_human_auth",
        capability: "2fa",
        instruction: "Confirm OTP code.",
        timeoutSec: 60,
      },
    }],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask(
    "human auth reject test",
    undefined,
    undefined,
    async () => ({
      requestId: "req-2",
      approved: false,
      status: "rejected",
      message: "User rejected",
      decidedAt: new Date().toISOString(),
      artifactPath: null,
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Human authorization rejected/);
});

test("AgentRuntime auto-approves Android permission dialog app without human auth", async () => {
  const actions = [];
  const authRequests = [];
  const uiDumpXml = [
    "<hierarchy rotation=\"0\">",
    "<node index=\"0\" text=\"Don't allow\" resource-id=\"com.android.permissioncontroller:id/permission_deny_button\" class=\"android.widget.Button\" package=\"com.android.permissioncontroller\" clickable=\"true\" enabled=\"true\" bounds=\"[56,2100][520,2200]\" />",
    "<node index=\"1\" text=\"Allow\" resource-id=\"com.android.permissioncontroller:id/permission_allow_button\" class=\"android.widget.Button\" package=\"com.android.permissioncontroller\" clickable=\"true\" enabled=\"true\" bounds=\"[560,2100][1024,2200]\" />",
    "</hierarchy>",
  ].join("");

  let snapshotCount = 0;
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "Completed after auto human auth" } }],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => {
      snapshotCount += 1;
      if (snapshotCount === 1) {
        return makeSnapshot({ currentApp: "com.android.permissioncontroller" });
      }
      return makeSnapshot();
    },
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };
  runtime.emulator = {
    runAdb: (args) => {
      if (Array.isArray(args) && args.includes("cat")) {
        return uiDumpXml;
      }
      return "ok";
    },
  };

  const result = await runtime.runTask(
    "auto permission dialog test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-auto-perm",
        approved: true,
        status: "approved",
        message: "Approved from phone",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 0);
  assert.equal(
    actions.some(
      (action) =>
        action.type === "tap"
        && action.reason === "auto_vm_permission_approve"
        && action.x >= 760
        && action.y >= 2100,
    ),
    true,
  );
});

test("AgentRuntime does not call human auth when model asks permission capability", async () => {
  const actions = [];
  const authRequests = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need permission decision",
        action: {
          type: "request_human_auth",
          capability: "permission",
          instruction: "Please decide this permission.",
          timeoutSec: 90,
        },
      },
      { thought: "done", action: { type: "finish", message: "Completed without human auth for VM permission" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };

  const result = await runtime.runTask(
    "permission capability no human auth test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-should-not-happen",
        approved: true,
        status: "approved",
        message: "Approved",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 0);
  assert.equal(actions.length, 0);
});

test("AgentRuntime auto-approves permission dialog even when model asks permission capability", async () => {
  const actions = [];
  const authRequests = [];
  const uiDumpXml = [
    "<hierarchy rotation=\"0\">",
    "<node index=\"0\" text=\"Don't allow\" resource-id=\"com.android.permissioncontroller:id/permission_deny_button\" class=\"android.widget.Button\" package=\"com.android.permissioncontroller\" clickable=\"true\" enabled=\"true\" bounds=\"[56,2100][520,2200]\" />",
    "<node index=\"1\" text=\"Allow\" resource-id=\"com.android.permissioncontroller:id/permission_allow_button\" class=\"android.widget.Button\" package=\"com.android.permissioncontroller\" clickable=\"true\" enabled=\"true\" bounds=\"[560,2100][1024,2200]\" />",
    "</hierarchy>",
  ].join("");

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need permission decision",
        action: {
          type: "request_human_auth",
          capability: "permission",
          instruction: "Please decide this permission.",
          timeoutSec: 90,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after permission decision" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({ currentApp: "com.android.permissioncontroller" }),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };
  runtime.emulator = {
    runAdb: (args) => {
      if (Array.isArray(args) && args.includes("cat")) {
        return uiDumpXml;
      }
      return "ok";
    },
  };

  const result = await runtime.runTask(
    "permission decision tap test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-perm-tap",
        approved: true,
        status: "approved",
        message: "Approved from phone",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 0);
  assert.equal(
    actions.some(
      (action) =>
        action.type === "tap"
        && action.reason === "auto_vm_permission_approve"
        && action.x >= 760
        && action.y >= 2100,
    ),
    true,
  );
});

test("AgentRuntime still requests human auth for camera capability after auto-allowing VM permission dialog", async () => {
  const actions = [];
  const authRequests = [];
  const uiDumpXml = [
    "<hierarchy rotation=\"0\">",
    "<node index=\"0\" text=\"Don't allow\" resource-id=\"com.android.permissioncontroller:id/permission_deny_button\" class=\"android.widget.Button\" package=\"com.android.permissioncontroller\" clickable=\"true\" enabled=\"true\" bounds=\"[56,2100][520,2200]\" />",
    "<node index=\"1\" text=\"Allow\" resource-id=\"com.android.permissioncontroller:id/permission_allow_button\" class=\"android.widget.Button\" package=\"com.android.permissioncontroller\" clickable=\"true\" enabled=\"true\" bounds=\"[560,2100][1024,2200]\" />",
    "</hierarchy>",
  ].join("");

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need real camera capture from phone.",
        action: {
          type: "request_human_auth",
          capability: "camera",
          instruction: "Capture image on phone and approve.",
          timeoutSec: 90,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after real-device approval" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({ currentApp: "com.android.permissioncontroller" }),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };
  runtime.emulator = {
    runAdb: (args) => {
      if (Array.isArray(args) && args.includes("cat")) {
        return uiDumpXml;
      }
      return "ok";
    },
  };

  const result = await runtime.runTask(
    "camera capability with VM dialog test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-camera-real-device",
        approved: true,
        status: "approved",
        message: "Image captured on phone",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 1);
  assert.equal(authRequests[0].capability, "camera");
  assert.equal(
    actions.some(
      (action) =>
        action.type === "tap"
        && action.reason === "auto_vm_permission_approve"
        && action.x >= 760
        && action.y >= 2100,
    ),
    true,
  );
});

test("AgentRuntime applies OTP code from manual approval note when no artifact is provided", async () => {
  const actions = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need OTP code",
        action: {
          type: "request_human_auth",
          capability: "2fa",
          instruction: "Please provide current OTP.",
          timeoutSec: 90,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after OTP note" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };

  const result = await runtime.runTask(
    "otp note fallback test",
    undefined,
    undefined,
    async () => ({
      requestId: "req-otp-note",
      approved: true,
      status: "approved",
      message: "123456",
      decidedAt: new Date().toISOString(),
      artifactPath: null,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(actions.some((action) => action.type === "type" && action.text === "123456"), true);
});

test("AgentRuntime applies delegated text artifact after human auth approval", async () => {
  const actions = [];
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-text-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({
      kind: "text",
      value: "123456",
      capability: "2fa",
    }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need OTP from phone",
        action: {
          type: "request_human_auth",
          capability: "2fa",
          instruction: "Input OTP code.",
          timeoutSec: 90,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after OTP delegation" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };

  try {
    const result = await runtime.runTask(
      "delegated text test",
      undefined,
      undefined,
      async () => ({
        requestId: "req-text",
        approved: true,
        status: "approved",
        message: "Code confirmed",
        decidedAt: new Date().toISOString(),
        artifactPath: artifactFile,
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(actions.some((action) => action.type === "type" && action.text === "123456"), true);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime applies delegated oauth credentials artifact after human auth approval", async () => {
  const actions = [];
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-credentials-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({
      kind: "credentials",
      username: "alice@example.com",
      password: "S3cret-987",
      capability: "oauth",
    }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need account login",
        action: {
          type: "request_human_auth",
          capability: "oauth",
          instruction: "Provide account credentials.",
          timeoutSec: 120,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after credential delegation" } },
    ],
  });

  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };
  runtime.emulator = {
    runAdb: (args) => {
      if (Array.isArray(args) && args.includes("cat") && args.some((item) => String(item).includes("openpocket-uidump"))) {
        return [
          "<hierarchy>",
          '<node index="0" text="" resource-id="com.demo:id/username" class="android.widget.EditText" package="com.demo" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[60,320][1020,430]" />',
          '<node index="1" text="" resource-id="com.demo:id/password" class="android.widget.EditText" package="com.demo" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="true" selected="false" bounds="[60,460][1020,570]" />',
          "</hierarchy>",
        ].join("");
      }
      return "ok";
    },
  };

  try {
    const result = await runtime.runTask(
      "delegated oauth credentials test",
      undefined,
      undefined,
      async () => ({
        requestId: "req-oauth",
        approved: true,
        status: "approved",
        message: "Credentials shared",
        decidedAt: new Date().toISOString(),
        artifactPath: artifactFile,
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(actions.some((action) => action.type === "tap" && action.reason === "human_auth_focus_username"), true);
    assert.equal(actions.some((action) => action.type === "tap" && action.reason === "human_auth_focus_password"), true);
    assert.equal(actions.some((action) => action.type === "type" && action.text === "alice@example.com"), true);
    assert.equal(actions.some((action) => action.type === "type" && action.text === "S3cret-987"), true);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime redacts custom user decision input from logs/history", async () => {
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need user choice",
        action: {
          type: "request_user_decision",
          question: "Which login route do you prefer?",
          options: ["Use Google", "Use Email"],
          timeoutSec: 90,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after user decision" } },
    ],
  });

  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };

  const secretInput = "my-sensitive-free-text";
  const result = await runtime.runTask(
    "user decision redaction test",
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({
      selectedOption: secretInput,
      rawInput: secretInput,
      resolvedAt: new Date().toISOString(),
    }),
  );

  assert.equal(result.ok, true);
  const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
  assert.match(sessionText, /selected="\[custom-input\]"/);
  assert.match(sessionText, /source=custom_input/);
  assert.doesNotMatch(sessionText, /my-sensitive-free-text/);
  assert.doesNotMatch(sessionText, /user decision raw input:/i);
});

test("AgentRuntime applies delegated location artifact after human auth approval", async () => {
  const adbActions = [];
  const emulatorCommands = [];
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-geo-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({
      kind: "geo",
      lat: 37.785834,
      lon: -122.406417,
      capability: "location",
    }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need real location",
        action: {
          type: "request_human_auth",
          capability: "location",
          instruction: "Share current location.",
          timeoutSec: 90,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after delegated location" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async (action) => {
      adbActions.push(action);
      return "ok";
    },
  };
  runtime.emulator = {
    runAdb: (args) => {
      emulatorCommands.push(args);
      return "ok";
    },
  };

  try {
    const result = await runtime.runTask(
      "delegated geo test",
      undefined,
      undefined,
      async () => ({
        requestId: "req-geo",
        approved: true,
        status: "approved",
        message: "Location shared",
        decidedAt: new Date().toISOString(),
        artifactPath: artifactFile,
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(
      emulatorCommands.some(
        (args) =>
          Array.isArray(args)
          && args.includes("emu")
          && args.includes("geo")
          && args.includes("fix")
          && args.includes(String(-122.406417))
          && args.includes(String(37.785834)),
      ),
      true,
    );
    assert.equal(adbActions.some((action) => action.type === "type"), false);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime appends gallery template hint after delegated image artifact", async () => {
  const emulatorCommands = [];
  const observedUserPrompts = [];
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-image-${Date.now()}.jpg`);
  fs.writeFileSync(artifactFile, Buffer.from("fake-image-bytes"));

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need delegated camera capture",
        action: {
          type: "request_human_auth",
          capability: "camera",
          instruction: "Capture an image from real device camera.",
          timeoutSec: 120,
        },
      },
      { thought: "Continue with picker", action: { type: "finish", message: "Completed with delegated image" } },
    ],
    hooks: {
      captureUserPrompt: observedUserPrompts,
    },
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };
  runtime.emulator = {
    runAdb: (args) => {
      emulatorCommands.push(args);
      return "ok";
    },
  };

  try {
    const result = await runtime.runTask(
      "delegated image template test",
      undefined,
      undefined,
      async () => ({
        requestId: "req-image",
        approved: true,
        status: "approved",
        message: "Image captured",
        decidedAt: new Date().toISOString(),
        artifactPath: artifactFile,
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(
      emulatorCommands.some((args) => Array.isArray(args) && args.includes("push") && args.includes(artifactFile)),
      true,
    );
    assert.equal(
      observedUserPrompts.some((text, index) => index > 0 && text.includes("delegation_template gallery_import_template")),
      true,
    );
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime routes Codex CLI auth through openai-codex responses", async () => {
  await withTempCodexHome("openpocket-runtime-codex-", async (codexHome) => {
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-access-token",
          refresh_token: "codex-refresh-token",
        },
      }),
      "utf-8",
    );

    const prevOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    let capturedModel = null;
    const runtime = setupRuntime({
      returnHomeOnTaskEnd: false,
      scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
      hooks: {
        onInit: (options) => {
          capturedModel = options.initialState?.model ?? null;
        },
      },
    });

    runtime.config.defaultModel = "gpt-5.3-codex";
    runtime.config.models["gpt-5.3-codex"].apiKey = "";
    runtime.config.models["gpt-5.3-codex"].apiKeyEnv = "OPENAI_API_KEY";
    runtime.adb = {
      queryLaunchablePackages: () => [],
      captureScreenSnapshot: () => makeSnapshot(),
      executeAction: async () => "ok",
    };

    try {
      const result = await runtime.runTask("codex routing test");
      assert.equal(result.ok, true);
      assert.equal(capturedModel?.provider, "openai-codex");
      assert.equal(capturedModel?.api, "openai-codex-responses");
    } finally {
      if (prevOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prevOpenAi;
      }
    }
  });
});

test("AgentRuntime aborts continuation after finish to avoid post-finish hang", async () => {
  const probe = { abortCalls: 0, secondTurnAttempted: false };
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [],
    hooks: {},
    agentFactory: createFinishAbortProbeFactory(probe),
  });

  runtime.config.defaultModel = "gpt-5.3-codex";
  runtime.config.models["gpt-5.3-codex"].apiKey = "dummy";
  runtime.config.models["gpt-5.3-codex"].apiKeyEnv = "MISSING_OPENAI_KEY";
  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask("finish abort probe");
  assert.equal(result.ok, true);
  assert.equal(probe.abortCalls > 0, true);
  assert.equal(probe.secondTurnAttempted, false);
});

test("AgentRuntime parses textual finish(...) fallback when model omits tool_call", async () => {
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [],
    hooks: {},
    agentFactory: createTextFallbackProbeFactory("finish(message=\"fallback finish ok\")"),
  });

  runtime.config.models["autoglm-phone"].apiKey = "dummy";
  runtime.config.models["autoglm-phone"].apiKeyEnv = "MISSING_AUTOGLM_KEY";
  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask("text tool fallback test", "autoglm-phone");
  assert.equal(result.ok, true);
  assert.equal(result.message, "fallback finish ok");
});

test("AgentRuntime infers finish action from narrative text when tool_call is missing", async () => {
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [],
    hooks: {},
    agentFactory: createTextFallbackProbeFactory(
      [
        "I can see the current screen is the Android home screen.",
        "According to the task instruction: \"If the Android home screen is visible, call finish immediately with message 'autoglm fallback ok'.\"",
        "Since the home screen is visible, I should finish the task immediately with the specified message.",
      ].join("\n\n"),
    ),
  });

  runtime.config.models["autoglm-phone"].apiKey = "dummy";
  runtime.config.models["autoglm-phone"].apiKeyEnv = "MISSING_AUTOGLM_KEY";
  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask("If the Android home screen is visible, call finish immediately with message 'autoglm fallback ok'. Otherwise perform at most one action then finish.", "autoglm-phone");
  assert.equal(result.ok, true);
  assert.equal(result.message, "autoglm fallback ok");
});
