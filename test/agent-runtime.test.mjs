import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { AgentRuntime } = await import("../dist/agent/agent-runtime.js");
const { buildPaymentArtifactKey } = await import("../dist/phone-use-util/index.js");

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

test("AgentRuntime prefers quick observation for post-action state delta when available", async () => {
  let screenCaptureCalls = 0;
  let quickObservationCalls = 0;
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "tap once", action: { type: "tap", x: 120, y: 240 } },
      { thought: "done", action: { type: "finish", message: "task completed" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => {
      screenCaptureCalls += 1;
      return makeSnapshot({
        screenshotBase64: Buffer.from(`frame-${screenCaptureCalls}`).toString("base64"),
        somScreenshotBase64: null,
        uiElements: [],
      });
    },
    captureQuickObservation: async () => {
      quickObservationCalls += 1;
      return {
        currentApp: "com.android.launcher3",
        screenshotHash: `quick-hash-${quickObservationCalls}`,
      };
    },
    executeAction: async () => "Tapped at (120, 240)",
  };

  const result = await runtime.runTask("quick observation delta path");
  assert.equal(result.ok, true);
  assert.equal(quickObservationCalls >= 1, true);
  assert.equal(screenCaptureCalls, 2);
});

test("AgentRuntime keeps workspace tools available for phone-style tasks", async () => {
  let capturedToolNames = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
    hooks: {
      onInit: (options) => {
        capturedToolNames = (options.initialState?.tools ?? []).map((tool) => tool.name);
      },
    },
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask("查询旧金山的天气");
  assert.equal(result.ok, true);
  assert.equal(capturedToolNames.includes("read"), true);
  assert.equal(capturedToolNames.includes("exec"), true);
  assert.equal(capturedToolNames.includes("memory_search"), true);
  assert.equal(capturedToolNames.includes("tap"), true);
  assert.equal(capturedToolNames.includes("finish"), true);
});

test("AgentRuntime keeps workspace tools for workspace-oriented tasks", async () => {
  let capturedToolNames = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
    hooks: {
      onInit: (options) => {
        capturedToolNames = (options.initialState?.tools ?? []).map((tool) => tool.name);
      },
    },
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask("read AGENTS.md and summarize workspace rules");
  assert.equal(result.ok, true);
  assert.equal(capturedToolNames.includes("read"), true);
  assert.equal(capturedToolNames.includes("exec"), true);
  assert.equal(capturedToolNames.includes("memory_search"), true);
});

test("AgentRuntime caps human-auth timeout to configured limit", async () => {
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "need oauth auth",
        action: {
          type: "request_human_auth",
          capability: "oauth",
          instruction: "Please login",
          timeoutSec: 600,
        },
      },
      { thought: "done", action: { type: "finish", message: "task completed" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({
      screenshotBase64: Buffer.from("screen").toString("base64"),
      somScreenshotBase64: null,
      uiElements: [],
    }),
    executeAction: async () => "ok",
  };

  let observedTimeoutSec = 0;
  const result = await runtime.runTask(
    "oauth timeout cap test",
    undefined,
    undefined,
    async (request) => {
      observedTimeoutSec = request.timeoutSec;
      return {
        requestId: "test-request",
        approved: true,
        status: "approved",
        message: "approved",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(observedTimeoutSec, runtime.config.humanAuth.requestTimeoutSec);
});

test("AgentRuntime still exposes workspace tools when a matching skill exists", async () => {
  let capturedToolNames = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
    hooks: {
      onInit: (options) => {
        capturedToolNames = (options.initialState?.tools ?? []).map((tool) => tool.name);
      },
    },
  });

  const skillsDir = path.join(runtime.config.workspaceDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "paybyphone-nearest.md"),
    "# PayByPhone Nearest\n\nUse nearest parking flow and request_human_auth(location) when empty.",
    "utf-8",
  );

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask("Open PayByPhone and continue nearest location flow");
  assert.equal(result.ok, true);
  assert.equal(capturedToolNames.includes("read"), true);
  assert.equal(capturedToolNames.includes("exec"), true);
  assert.equal(capturedToolNames.includes("memory_search"), true);
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

test("AgentRuntime seeds prior transcript context when sessionKey is reused", async () => {
  const initMessages = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [{ thought: "done", action: { type: "finish", message: "task completed" } }],
    hooks: {
      onInit: (options) => {
        initMessages.push(options.initialState?.messages ?? []);
      },
    },
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const first = await runtime.runTask(
    "first continuity task",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "telegram:chat:seed-test",
  );
  const second = await runtime.runTask(
    "second continuity task",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "telegram:chat:seed-test",
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.sessionPath, second.sessionPath);
  assert.equal(initMessages.length >= 2, true);

  const secondRunMessages = initMessages[1];
  assert.equal(
    secondRunMessages.some((message) => JSON.stringify(message).includes("first continuity task")),
    true,
  );
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

test("AgentRuntime escalates capability probe camera event to human auth", async () => {
  const authRequests = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "open camera entry", action: { type: "tap", x: 360, y: 720 } },
      { thought: "done", action: { type: "finish", message: "camera entry opened" } },
    ],
  });

  runtime.config.humanAuth.enabled = true;
  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({
      currentApp: "com.Slack",
      screenshotBase64: Buffer.from("slack-camera").toString("base64"),
      somScreenshotBase64: null,
      uiElements: [],
    }),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };
  runtime.capabilityProbe.poll = () => ([
    {
      capability: "camera",
      phase: "requested",
      packageName: "com.Slack",
      source: "activity_log",
      observedAt: new Date().toISOString(),
      confidence: 0.95,
      evidence: "camera intent start",
    },
  ]);

  const result = await runtime.runTask(
    "probe to human auth test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-probe-camera",
        approved: true,
        status: "approved",
        message: "Approved from phone",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 1);
  assert.equal(authRequests[0].capability, "camera");
  assert.equal(authRequests[0].uiTemplate?.requireArtifactOnApprove, true);
  assert.equal(authRequests[0].uiTemplate?.allowPhotoAttachment, true);
  assert.equal(authRequests[0].uiTemplate?.allowTextAttachment, false);

  const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
  assert.match(sessionText, /human_auth_probe capability=camera status=approved/i);
});

test("AgentRuntime escalates capability probe after tap_element action", async () => {
  const authRequests = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "open camera entry", action: { type: "tap_element", elementId: 11 } },
      { thought: "done", action: { type: "finish", message: "camera entry opened" } },
    ],
  });

  runtime.config.humanAuth.enabled = true;
  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({
      currentApp: "com.Slack",
      screenshotBase64: Buffer.from("slack-camera").toString("base64"),
      somScreenshotBase64: null,
      uiElements: [],
    }),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };
  runtime.capabilityProbe.poll = () => ([
    {
      capability: "camera",
      phase: "requested",
      packageName: "com.Slack",
      source: "activity_log",
      observedAt: new Date().toISOString(),
      confidence: 0.95,
      evidence: "camera intent start",
    },
  ]);

  const result = await runtime.runTask(
    "probe after tap_element test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-probe-camera-tap-element",
        approved: true,
        status: "approved",
        message: "Approved from phone",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 1);
  assert.equal(authRequests[0].capability, "camera");

  const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
  assert.match(sessionText, /human_auth_probe capability=camera status=approved/i);
});

test("AgentRuntime escalates payment capability probe with dynamic fields from ui tree context", async () => {
  const authRequests = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "open checkout", action: { type: "tap", x: 480, y: 2060 } },
      { thought: "done", action: { type: "finish", message: "checkout ready" } },
    ],
  });

  runtime.config.humanAuth.enabled = true;
  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({
      currentApp: "com.shop.app",
      screenshotBase64: Buffer.from("secure-checkout").toString("base64"),
      somScreenshotBase64: null,
      uiElements: [],
    }),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };
  runtime.capabilityProbe.poll = () => ([
    {
      capability: "payment",
      phase: "requested",
      packageName: "com.shop.app",
      source: "window_secure",
      observedAt: new Date().toISOString(),
      confidence: 0.97,
      evidence: "FLAG_SECURE payment checkout",
      paymentContext: {
        secureWindow: true,
        secureEvidence: "FLAG_SECURE payment checkout",
        fieldCandidates: [
          {
            semantic: "card_number",
            label: "Card Number",
            resourceIdHint: "card_number",
            artifactKey: buildPaymentArtifactKey("card_number", "card_number", 0),
            required: true,
            confidence: 0.96,
            inputType: "card-number",
          },
          {
            semantic: "expiry",
            label: "Expiration (MM/YY)",
            resourceIdHint: "expiry",
            artifactKey: buildPaymentArtifactKey("expiry", "expiry", 0),
            required: true,
            confidence: 0.92,
            inputType: "expiry",
          },
          {
            semantic: "cvc",
            label: "Security Code (CVC/CVV)",
            resourceIdHint: "cvc",
            artifactKey: buildPaymentArtifactKey("cvc", "cvc", 0),
            required: true,
            confidence: 0.91,
            inputType: "cvc",
          },
        ],
      },
    },
  ]);

  const result = await runtime.runTask(
    "payment probe to human auth",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-probe-payment",
        approved: true,
        status: "approved",
        message: "Payment delegated",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 1);
  assert.equal(authRequests[0].capability, "payment");
  assert.equal(authRequests[0].uiTemplate?.artifactKind, "form");
  assert.equal(authRequests[0].uiTemplate?.requireArtifactOnApprove, true);
  assert.equal(authRequests[0].uiTemplate?.fields?.length, 3);
  assert.equal(authRequests[0].uiTemplate?.allowPhotoAttachment, false);
});

test("AgentRuntime reuses approved capability probe auth within one task", async () => {
  const authRequests = [];
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-capability-probe-artifact-"));
  const artifactPath = path.join(artifactDir, "delegated-camera.json");
  fs.writeFileSync(artifactPath, JSON.stringify({
    kind: "text",
    value: "camera delegated",
  }), "utf-8");

  let runtime;
  const scriptedSteps = [
    { thought: "open camera entry first time", action: { type: "tap", x: 360, y: 720 } },
    () => {
      runtime.capabilityProbeAuthCooldownByKey.set("camera", 0);
      return { thought: "open camera entry second time", action: { type: "tap", x: 362, y: 722 } };
    },
    { thought: "done", action: { type: "finish", message: "camera probe reuse done" } },
  ];
  runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps,
  });

  runtime.config.humanAuth.enabled = true;
  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({
      currentApp: "com.Slack",
      screenshotBase64: Buffer.from("slack-camera-repeat").toString("base64"),
      somScreenshotBase64: null,
      uiElements: [],
    }),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };
  runtime.capabilityProbe.poll = () => ([
    {
      capability: "camera",
      phase: "requested",
      packageName: "com.Slack",
      source: "activity_log",
      observedAt: new Date().toISOString(),
      confidence: 0.95,
      evidence: "camera intent start",
    },
  ]);

  const result = await runtime.runTask(
    "probe reuse test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-probe-camera-reuse",
        approved: true,
        status: "approved",
        message: "Approved from phone",
        decidedAt: new Date().toISOString(),
        artifactPath,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 1);

  const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
  assert.match(sessionText, /human_auth_probe skipped=reused capability=camera pkg=com\.Slack/i);
});

test("AgentRuntime escalates permission dialog capability via activity dump fallback", async () => {
  const authRequests = [];
  const actions = [];
  const uiDumpXml = [
    "<hierarchy rotation=\"0\">",
    "<node index=\"0\" text=\"Don't allow\" resource-id=\"com.android.permissioncontroller:id/permission_deny_button\" class=\"android.widget.Button\" package=\"com.android.permissioncontroller\" clickable=\"true\" enabled=\"true\" bounds=\"[56,2100][520,2200]\" />",
    "<node index=\"1\" text=\"Allow\" resource-id=\"com.android.permissioncontroller:id/permission_allow_button\" class=\"android.widget.Button\" package=\"com.android.permissioncontroller\" clickable=\"true\" enabled=\"true\" bounds=\"[560,2100][1024,2200]\" />",
    "</hierarchy>",
  ].join("");
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "open camera entry", action: { type: "tap", x: 360, y: 720 } },
      { thought: "done", action: { type: "finish", message: "camera entry opened" } },
    ],
  });

  runtime.config.humanAuth.enabled = true;
  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({
      currentApp: "com.Slack",
      screenshotBase64: Buffer.from("slack-camera").toString("base64"),
      somScreenshotBase64: null,
      uiElements: [],
    }),
    captureQuickObservation: async () => ({
      currentApp: "com.google.android.permissioncontroller",
      screenshotHash: "permission-dialog",
    }),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async (action) => {
      actions.push(action);
      return "ok";
    },
  };
  runtime.emulator = {
    runAdb: (args) => {
      const joined = Array.isArray(args) ? args.join(" ") : "";
      if (joined.includes("dumpsys activity top")) {
        return "requestedPermissions=[android.permission.CAMERA]";
      }
      if (Array.isArray(args) && args.includes("cat")) {
        return uiDumpXml;
      }
      return "";
    },
  };
  runtime.capabilityProbe.poll = () => ([]);

  const result = await runtime.runTask(
    "permission dialog fallback to human auth test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-perm-dialog-camera",
        approved: true,
        status: "approved",
        message: "Approved from phone",
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
        && action.reason === "human_auth_permission_reject"
        && action.x > 0
        && action.y > 0,
    ),
    true,
  );

  const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
  assert.match(sessionText, /src=permission_dialog/i);
  assert.match(sessionText, /human_auth_probe capability=camera status=approved/i);
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

test("AgentRuntime loads human auth uiTemplate from templatePath generated in workspace", async () => {
  const authRequests = [];
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Load reusable human auth page template from workspace file",
        action: {
          type: "request_human_auth",
          capability: "unknown",
          instruction: "Please complete custom approval form.",
          templatePath: "human-auth/templates/custom-auth.json",
          uiTemplate: {
            title: "Inline Override Title",
          },
        },
      },
      { thought: "Done", action: { type: "finish", message: "Template file flow complete" } },
    ],
  });

  const templateDir = path.join(runtime.config.workspaceDir, "human-auth", "templates");
  fs.mkdirSync(templateDir, { recursive: true });
  fs.writeFileSync(
    path.join(templateDir, "custom-auth.json"),
    JSON.stringify({
      templateId: "custom-auth-flow",
      summary: "Template summary from file",
      middleHtml: "<input id=\"from_file_field\" type=\"text\" />",
      approveScript: "return { ok: true };",
      requireArtifactOnApprove: false,
    }, null, 2),
    "utf-8",
  );

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  const result = await runtime.runTask(
    "human auth templatePath test",
    undefined,
    undefined,
    async (request) => {
      authRequests.push(request);
      return {
        requestId: "req-template-path",
        approved: true,
        status: "approved",
        message: "Approved in templatePath test.",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authRequests.length, 1);
  assert.equal(authRequests[0].uiTemplate?.templateId, "custom-auth-flow");
  assert.equal(authRequests[0].uiTemplate?.summary, "Template summary from file");
  assert.equal(authRequests[0].uiTemplate?.title, "Inline Override Title");
  assert.equal(authRequests[0].uiTemplate?.middleHtml.includes("from_file_field"), true);
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

test("AgentRuntime still requests human auth for camera capability while local VM dialog is rejected", async () => {
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
        && String(action.reason || "").includes("permission_reject"),
    ),
    true,
  );
});

test("AgentRuntime returns approval message to agent when no artifact is provided (agentic delegation)", async () => {
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
    executeAction: async () => "ok",
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
  const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
  assert.match(sessionText, /Human auth approved/i);
});

test("AgentRuntime describes text artifact to agent after human auth approval (agentic delegation)", async () => {
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-text-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({ kind: "text", value: "123456", capability: "2fa" }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need OTP from phone",
        action: { type: "request_human_auth", capability: "2fa", instruction: "Input OTP code.", timeoutSec: 90 },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after OTP delegation" } },
    ],
  });

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };

  try {
    const result = await runtime.runTask(
      "delegated text test",
      undefined, undefined,
      async () => ({
        requestId: "req-text", approved: true, status: "approved",
        message: "Code confirmed", decidedAt: new Date().toISOString(), artifactPath: artifactFile,
      }),
    );

    assert.equal(result.ok, true);
    const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
    assert.match(sessionText, /artifact_kind=text/);
    assert.match(sessionText, /value_length=6/);
    assert.doesNotMatch(sessionText, /value=123456/);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime describes credentials artifact to agent after human auth approval (agentic delegation)", async () => {
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-credentials-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({ kind: "credentials", username: "alice@example.com", password: "S3cret-987", capability: "oauth" }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need account login",
        action: { type: "request_human_auth", capability: "oauth", instruction: "Provide account credentials.", timeoutSec: 120 },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after credential delegation" } },
    ],
  });

  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };

  try {
    const result = await runtime.runTask(
      "delegated oauth credentials test",
      undefined, undefined,
      async () => ({
        requestId: "req-oauth", approved: true, status: "approved",
        message: "Credentials shared", decidedAt: new Date().toISOString(), artifactPath: artifactFile,
      }),
    );

    assert.equal(result.ok, true);
    const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
    assert.match(sessionText, /artifact_kind=credentials/);
    assert.match(sessionText, /has_username=true/);
    assert.match(sessionText, /has_password=true/);
    assert.match(sessionText, /SENSITIVE/);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime describes payment artifact to agent after human auth approval (agentic delegation)", async () => {
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-payment-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({ kind: "payment_card_v1", cardNumber: "4111111111111111", expiry: "02/32", cvc: "182", capability: "payment" }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need payment details",
        action: { type: "request_human_auth", capability: "payment", instruction: "Provide payment card data.", timeoutSec: 120 },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after delegated payment fields" } },
    ],
  });

  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };

  try {
    const result = await runtime.runTask(
      "delegated payment test",
      undefined, undefined,
      async () => ({
        requestId: "req-payment", approved: true, status: "approved",
        message: "Payment details shared", decidedAt: new Date().toISOString(), artifactPath: artifactFile,
      }),
    );

    assert.equal(result.ok, true);
    const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
    assert.match(sessionText, /artifact_kind=payment_card_v1/);
    assert.match(sessionText, /SENSITIVE/);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime describes payment form artifact with billing fields to agent (agentic delegation)", async () => {
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-payment-form-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({ kind: "form", capability: "payment", fields: { card_number: "4111111111111111", expiry: "02/32", cvc: "182" } }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "Need payment details", action: { type: "request_human_auth", capability: "payment", instruction: "Provide secure payment fields.", timeoutSec: 120 } },
      { thought: "Done", action: { type: "finish", message: "Completed after delegated payment form fields" } },
    ],
  });

  runtime.adb = { captureScreenSnapshot: () => makeSnapshot(), resolveDeviceId: () => "emulator-5554", executeAction: async () => "ok" };

  try {
    const result = await runtime.runTask("delegated payment form test", undefined, undefined,
      async () => ({ requestId: "req-payment-form", approved: true, status: "approved", message: "Payment form details shared", decidedAt: new Date().toISOString(), artifactPath: artifactFile }),
    );
    assert.equal(result.ok, true);
    const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
    assert.match(sessionText, /artifact_kind=form/);
    assert.match(sessionText, /form_fields=\[/);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime sends each oauth request to human auth in agentic mode (no cached credential reuse)", async () => {
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-credentials-split-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({ kind: "credentials", username: "alice@example.com", password: "S3cret-987", capability: "oauth" }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "Need Google account username", action: { type: "request_human_auth", capability: "oauth", instruction: "Provide account credentials.", timeoutSec: 120 } },
      { thought: "Need Google password on next screen", action: { type: "request_human_auth", capability: "oauth", instruction: "Continue oauth login", timeoutSec: 120 } },
      { thought: "Done", action: { type: "finish", message: "Completed split oauth login" } },
    ],
  });

  runtime.adb = { captureScreenSnapshot: () => makeSnapshot(), resolveDeviceId: () => "emulator-5554", executeAction: async () => "ok" };

  let authCalls = 0;
  try {
    const result = await runtime.runTask("split oauth login test", undefined, undefined,
      async () => {
        authCalls += 1;
        return {
          requestId: `req-oauth-${authCalls}`, approved: true, status: "approved",
          message: "Credentials shared", decidedAt: new Date().toISOString(), artifactPath: artifactFile,
        };
      },
    );

    assert.equal(result.ok, true);
    // In agentic mode, both oauth requests go through to human auth handler.
    assert.equal(authCalls, 2);
    const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
    assert.match(sessionText, /artifact_kind=credentials/);
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
  assert.match(sessionText, /selected=(?:"|\\")\[custom-input\](?:"|\\")/);
  assert.match(sessionText, /source=custom_input/);
  assert.doesNotMatch(sessionText, /my-sensitive-free-text/);
  assert.doesNotMatch(sessionText, /user decision raw input:/i);
});

test("AgentRuntime redacts raw request_user_input text from session log", async () => {
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      {
        thought: "Need a car plate from user",
        action: {
          type: "request_user_input",
          question: "Please provide your vehicle plate number.",
          placeholder: "ABC-1234",
          timeoutSec: 90,
        },
      },
      { thought: "Done", action: { type: "finish", message: "Completed after user input" } },
    ],
  });

  runtime.adb = {
    captureScreenSnapshot: () => makeSnapshot(),
    resolveDeviceId: () => "emulator-5554",
    executeAction: async () => "ok",
  };

  const secretInput = "CA-7XZ019";
  const result = await runtime.runTask(
    "user input redaction test",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({
      text: secretInput,
      resolvedAt: new Date().toISOString(),
    }),
  );

  assert.equal(result.ok, true);
  const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
  assert.match(sessionText, /user_input input_len=\d+/);
  assert.doesNotMatch(sessionText, /CA-7XZ019/);
});

test("AgentRuntime describes location artifact to agent after human auth approval (agentic delegation)", async () => {
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-geo-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({ kind: "geo", lat: 37.785834, lon: -122.406417, capability: "location" }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "Need real location", action: { type: "request_human_auth", capability: "location", instruction: "Share current location.", timeoutSec: 90 } },
      { thought: "Done", action: { type: "finish", message: "Completed after delegated location" } },
    ],
  });

  runtime.adb = { queryLaunchablePackages: () => [], captureScreenSnapshot: () => makeSnapshot(), resolveDeviceId: () => "emulator-5554", executeAction: async () => "ok" };

  try {
    const result = await runtime.runTask("delegated geo test", undefined, undefined,
      async () => ({ requestId: "req-geo", approved: true, status: "approved", message: "Location shared", decidedAt: new Date().toISOString(), artifactPath: artifactFile }),
    );
    assert.equal(result.ok, true);
    const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
    assert.match(sessionText, /artifact_kind=geo/);
    assert.match(sessionText, /lat=37\.785834/);
    assert.match(sessionText, /lon=-122\.406417/);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime describes location artifact on physical target to agent (agentic delegation)", async () => {
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-geo-physical-${Date.now()}.json`);
  fs.writeFileSync(
    artifactFile,
    JSON.stringify({ kind: "geo", lat: 40.7128, lon: -74.006, capability: "location" }),
    "utf-8",
  );

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "Need real location", action: { type: "request_human_auth", capability: "location", instruction: "Share current location.", timeoutSec: 90 } },
      { thought: "Done", action: { type: "finish", message: "Completed after delegated location" } },
    ],
  });

  runtime.config.target.type = "physical-phone";
  runtime.adb = { queryLaunchablePackages: () => [], captureScreenSnapshot: () => makeSnapshot(), resolveDeviceId: () => "physical-serial-1", executeAction: async () => "ok" };

  try {
    const result = await runtime.runTask("delegated geo physical test", undefined, undefined,
      async () => ({ requestId: "req-geo-physical", approved: true, status: "approved", message: "Location shared", decidedAt: new Date().toISOString(), artifactPath: artifactFile }),
    );
    assert.equal(result.ok, true);
    const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
    assert.match(sessionText, /artifact_kind=geo/);
    assert.match(sessionText, /lat=40\.712800/);
  } finally {
    fs.rmSync(artifactFile, { force: true });
  }
});

test("AgentRuntime pre-finish capability probe escalates human auth on sensitive active app", async () => {
  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "done", action: { type: "finish", message: "camera opened" } },
    ],
  });
  runtime.config.humanAuth.enabled = true;

  runtime.adb = {
    queryLaunchablePackages: () => [],
    captureScreenSnapshot: () => makeSnapshot({
      currentApp: "com.google.android.GoogleCamera",
    }),
    resolveDeviceId: () => "physical-serial-1",
    executeAction: async () => "ok",
  };
  runtime.capabilityProbe.poll = () => ([
    {
      capability: "camera",
      phase: "active",
      packageName: "com.google.android.GoogleCamera",
      source: "camera_service",
      observedAt: new Date().toISOString(),
      confidence: 0.99,
      evidence: "camera_active",
    },
  ]);

  let authCalls = 0;
  const result = await runtime.runTask(
    "finish pre-check human auth test",
    undefined,
    undefined,
    async (request) => {
      authCalls += 1;
      assert.equal(request.capability, "camera");
      return {
        requestId: "req-finish-camera",
        approved: true,
        status: "approved",
        message: "approved by test",
        decidedAt: new Date().toISOString(),
        artifactPath: null,
      };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(authCalls, 1);
  const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
  assert.match(sessionText, /human_auth_probe capability=camera status=approved/i);
});

test("AgentRuntime describes image artifact and pushes to device (agentic delegation)", async () => {
  const artifactFile = path.join(os.tmpdir(), `openpocket-artifact-image-${Date.now()}.jpg`);
  fs.writeFileSync(artifactFile, Buffer.from("fake-image-bytes"));

  const runtime = setupRuntime({
    returnHomeOnTaskEnd: false,
    scriptedSteps: [
      { thought: "Need delegated camera capture", action: { type: "request_human_auth", capability: "camera", instruction: "Capture an image from real device camera.", timeoutSec: 120 } },
      { thought: "Continue with picker", action: { type: "finish", message: "Completed with delegated image" } },
    ],
  });

  const pushCommands = [];
  runtime.adb = { queryLaunchablePackages: () => [], captureScreenSnapshot: () => makeSnapshot(), resolveDeviceId: () => "emulator-5554", executeAction: async () => "ok" };
  runtime.emulator = { runAdb: (args) => { pushCommands.push(args); return "ok"; } };

  try {
    const result = await runtime.runTask("delegated image template test", undefined, undefined,
      async () => ({ requestId: "req-image", approved: true, status: "approved", message: "Image captured", decidedAt: new Date().toISOString(), artifactPath: artifactFile }),
    );
    assert.equal(result.ok, true);
    const sessionText = fs.readFileSync(result.sessionPath, "utf-8");
    assert.match(sessionText, /artifact_path=/);
    assert.match(sessionText, /device_path=.*sdcard.*Download/);
    assert.match(sessionText, /pushed to Agent Phone/);
    assert.equal(pushCommands.some((args) => Array.isArray(args) && args.includes("push")), true);
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
