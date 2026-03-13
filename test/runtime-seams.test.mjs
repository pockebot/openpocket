import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { AgentRuntime } = await import("../dist/agent/agent-runtime.js");
const { runRuntimeAttempt } = await import("../dist/agent/runtime/attempt.js");
const { runRuntimeTask } = await import("../dist/agent/runtime/run.js");

function createRuntimeWithoutApiKey() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-runtime-seams-"));
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;

  const cfg = loadConfig();
  // Use a non-codex profile so auth resolution cannot fall back to Codex CLI.
  const nonCodexModelKey = Object.entries(cfg.models).find(([, profile]) => (
    !String(profile.model ?? "").toLowerCase().includes("codex")
  ))?.[0];
  if (nonCodexModelKey) {
    cfg.defaultModel = nonCodexModelKey;
  }
  cfg.agent.returnHomeOnTaskEnd = false;
  const noKeyModel = cfg.models["claude-sonnet-4.6"] ? "claude-sonnet-4.6" : cfg.defaultModel;
  cfg.defaultModel = noKeyModel;
  cfg.models[noKeyModel].apiKey = "";
  cfg.models[noKeyModel].apiKeyEnv = "MISSING_MODEL_KEY";

  const runtime = new AgentRuntime(cfg);

  if (prevHome === undefined) {
    delete process.env.OPENPOCKET_HOME;
  } else {
    process.env.OPENPOCKET_HOME = prevHome;
  }

  return runtime;
}

function createRuntimeWithApiKey() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-runtime-seams-key-"));
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;

  const cfg = loadConfig();
  cfg.agent.returnHomeOnTaskEnd = false;
  cfg.models[cfg.defaultModel].apiKey = "test-key";
  cfg.models[cfg.defaultModel].apiKeyEnv = "OPENAI_API_KEY";

  const runtime = new AgentRuntime(cfg);

  if (prevHome === undefined) {
    delete process.env.OPENPOCKET_HOME;
  } else {
    process.env.OPENPOCKET_HOME = prevHome;
  }

  return runtime;
}

function createAttemptDeps(runtime) {
  return {
    config: runtime.config,
    workspace: runtime.workspace,
    adb: runtime.adb,
    skillLoader: runtime.skillLoader,
    autoArtifactBuilder: runtime.autoArtifactBuilder,
    screenshotStore: runtime.screenshotStore,
    agentFactory: runtime.agentFactory,
    getStopRequested: () => runtime.stopRequested,
    buildWorkspacePromptContext: () => runtime.buildWorkspacePromptContext(),
    buildSystemPromptReport: (params) => runtime.buildSystemPromptReport(params),
    setLastSystemPromptReport: (report) => {
      runtime.lastSystemPromptReport = report;
    },
    buildPhoneAgentTools: (ctx) => runtime.buildPhoneAgentTools(ctx, runtime),
    parseTextualToolFallback: (message, task) => runtime.parseTextualToolFallback(message, task),
    isPermissionDialogApp: (currentApp) => runtime.isPermissionDialogApp(currentApp),
    autoApprovePermissionDialog: (currentApp) => runtime.autoApprovePermissionDialog(currentApp),
    saveModelInputArtifacts: (params) => runtime.saveModelInputArtifacts(params),
    piSessionBridgeFactory: async () => {
      throw new Error("piSessionBridgeFactory not configured");
    },
  };
}

function normalizeVolatileRuntimeMessage(message) {
  return String(message)
    .split(/\r?\n/g)
    .filter((line) => {
      if (/^Server had pid:\s+\d+/i.test(line)) {
        return false;
      }
      if (/^--- adb starting \(pid\s+\d+\)\s+---$/i.test(line)) {
        return false;
      }
      if (/^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+[A-Z]\s+adb\s+:/i.test(line)) {
        return false;
      }
      return true;
    })
    .join("\n");
}

function makeSnapshot(overrides = {}) {
  return {
    deviceId: "emulator-5554",
    currentApp: "com.android.launcher3",
    width: 1080,
    height: 2400,
    screenshotBase64: "abc",
    secureSurfaceDetected: false,
    secureSurfaceEvidence: "",
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

function createAssistantErrorMessage(errorMessage, model, stopReason = "error") {
  return {
    role: "assistant",
    content: [],
    api: model?.api ?? "openai-codex-responses",
    provider: model?.provider ?? "openai-codex",
    model: model?.id ?? "mock-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

test("runRuntimeTask keeps busy rejection contract", async () => {
  const result = await runRuntimeTask(
    {
      isBusy: () => true,
      beginRun: () => {
        throw new Error("beginRun should not be called when busy");
      },
      executeAttempt: async () => {
        throw new Error("executeAttempt should not be called when busy");
      },
      finalizeRun: async () => {
        throw new Error("finalizeRun should not be called when busy");
      },
    },
    { task: "busy-contract-test" },
  );

  assert.deepEqual(result, {
    ok: false,
    message: "Agent is busy. Please retry later.",
    sessionPath: "",
    skillPath: null,
    scriptPath: null,
  });
});

test("runRuntimeTask propagates return-home signal to finalize", async () => {
  let beginCalled = false;
  let finalizeArg = null;
  const resultPayload = {
    ok: true,
    message: "done",
    sessionPath: "/tmp/session.md",
    skillPath: null,
    scriptPath: null,
  };

  const result = await runRuntimeTask(
    {
      isBusy: () => false,
      beginRun: () => {
        beginCalled = true;
      },
      executeAttempt: async () => ({
        result: resultPayload,
        shouldReturnHome: true,
      }),
      finalizeRun: async (shouldReturnHome) => {
        finalizeArg = shouldReturnHome;
      },
    },
    { task: "finalize-contract-test" },
  );

  assert.equal(beginCalled, true);
  assert.equal(finalizeArg, true);
  assert.deepEqual(result, resultPayload);
});

test("runTask entry and attempt layer keep result shape aligned", async () => {
  const runtime = createRuntimeWithoutApiKey();
  const request = { task: "runtime seam shape" };

  const entryResult = await runtime.runTask(request.task);
  const attemptResult = await runRuntimeAttempt(createAttemptDeps(runtime), request);

  assert.deepEqual(
    [...Object.keys(entryResult)].sort(),
    [...Object.keys(attemptResult.result)].sort(),
  );
  assert.equal(entryResult.ok, attemptResult.result.ok);
  assert.equal(
    normalizeVolatileRuntimeMessage(entryResult.message),
    normalizeVolatileRuntimeMessage(attemptResult.result.message),
  );
  assert.equal(typeof entryResult.sessionPath, "string");
  assert.equal(typeof attemptResult.result.sessionPath, "string");
  assert.equal(entryResult.skillPath, attemptResult.result.skillPath);
  assert.equal(entryResult.scriptPath, attemptResult.result.scriptPath);
});

test("runRuntimeAttempt uses pi_session_bridge backend when configured", async () => {
  const runtime = createRuntimeWithApiKey();
  runtime.config.agent.runtimeBackend = "pi_session_bridge";

  let agentFactoryCalls = 0;
  runtime.agentFactory = () => {
    agentFactoryCalls += 1;
    throw new Error("legacy agentFactory should not be used for pi_session_bridge");
  };

  let bridgeFactoryCalls = 0;
  let bridgeDisposed = 0;
  const listeners = new Set();
  const deps = createAttemptDeps(runtime);
  deps.piSessionBridgeFactory = async (options) => {
    bridgeFactoryCalls += 1;
    return {
      sessionId: "pi-bridge-session",
      sessionFile: "/tmp/pi-bridge-session.jsonl",
      prompt: async (_text) => {
        for (const listener of listeners) {
          listener({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "finish(message=\"pi-bridge-ok\")" }],
              stopReason: "stop",
              timestamp: Date.now(),
            },
            toolResults: [],
          });
        }
      },
      abort: async () => {},
      dispose: () => {
        bridgeDisposed += 1;
      },
      subscribeRaw: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeNormalized: (_listener) => () => {},
    };
  };

  const outcome = await runRuntimeAttempt(deps, {
    task: "pi-session-bridge seam test",
    availableToolNames: ["finish"],
  });

  assert.equal(outcome.result.ok, true);
  assert.match(outcome.result.message, /pi-bridge-ok/);
  assert.equal(bridgeFactoryCalls, 1);
  assert.equal(bridgeDisposed, 1);
  assert.equal(agentFactoryCalls, 0);
});

test("runRuntimeAttempt retries retryable pi_session_bridge Codex server errors instead of failing immediately", async () => {
  const runtime = createRuntimeWithApiKey();
  runtime.config.agent.runtimeBackend = "pi_session_bridge";

  let promptCalls = 0;
  const promptTexts = [];
  const listeners = new Set();
  const deps = createAttemptDeps(runtime);
  deps.piSessionBridgeFactory = async () => ({
    sessionId: "pi-bridge-session-retry",
    sessionFile: "/tmp/pi-bridge-session-retry.jsonl",
    prompt: async (text) => {
      promptCalls += 1;
      promptTexts.push(text);
      const message = promptCalls === 1
        ? createAssistantErrorMessage(
          'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. Please include the request ID req-pi-bridge-retry-1 in your message.","param":null},"sequence_number":2}',
          runtime.config.models[runtime.config.defaultModel],
        )
        : {
          role: "assistant",
          content: [{ type: "text", text: "finish(message=\"pi-bridge-retried-ok\")" }],
          stopReason: "stop",
          timestamp: Date.now(),
        };
      for (const listener of listeners) {
        listener({
          type: "turn_end",
          message,
          toolResults: [],
        });
      }
    },
    abort: async () => {},
    dispose: () => {},
    subscribeRaw: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeNormalized: (_listener) => () => {},
  });

  const outcome = await runRuntimeAttempt(deps, {
    task: "pi-session-bridge retry transient codex server error",
    availableToolNames: ["finish"],
  });

  assert.equal(outcome.result.ok, true);
  assert.match(outcome.result.message, /pi-bridge-retried-ok/);
  assert.equal(promptCalls, 2);
  assert.equal(promptTexts[0], "Task: pi-session-bridge retry transient codex server error");
  assert.equal(promptTexts[1], "Step 1: continue executing the task.");
});

test("runRuntimeAttempt does not retry non-retryable pi_session_bridge Codex model errors", async () => {
  const runtime = createRuntimeWithApiKey();
  runtime.config.agent.runtimeBackend = "pi_session_bridge";

  let promptCalls = 0;
  const listeners = new Set();
  const deps = createAttemptDeps(runtime);
  deps.piSessionBridgeFactory = async () => ({
    sessionId: "pi-bridge-session-no-retry",
    sessionFile: "/tmp/pi-bridge-session-no-retry.jsonl",
    prompt: async () => {
      promptCalls += 1;
      for (const listener of listeners) {
        listener({
          type: "turn_end",
          message: createAssistantErrorMessage(
            'Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Context length exceeded.","param":null},"sequence_number":2}',
            runtime.config.models[runtime.config.defaultModel],
          ),
          toolResults: [],
        });
      }
    },
    abort: async () => {},
    dispose: () => {},
    subscribeRaw: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeNormalized: (_listener) => () => {},
  });

  const outcome = await runRuntimeAttempt(deps, {
    task: "pi-session-bridge do not retry invalid request errors",
    availableToolNames: ["finish"],
  });

  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.message, /context_length_exceeded/);
  assert.equal(promptCalls, 1);
});

test("runRuntimeAttempt falls back to legacy backend when phone-only tools are requested", async () => {
  const runtime = createRuntimeWithApiKey();
  runtime.config.agent.runtimeBackend = "pi_session_bridge";

  let bridgeFactoryCalls = 0;
  const deps = createAttemptDeps(runtime);
  deps.piSessionBridgeFactory = async () => {
    bridgeFactoryCalls += 1;
    throw new Error("bridge backend should not be used for phone-only tools");
  };

  let legacyFactoryCalls = 0;
  runtime.agentFactory = () => {
    legacyFactoryCalls += 1;
    const listeners = new Set();
    return {
      followUp() {},
      subscribe(listener) {
        listeners.add(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "finish(message=\"legacy-fallback-ok\")" }],
              stopReason: "stop",
              timestamp: Date.now(),
            },
            toolResults: [],
          });
        }
      },
      async waitForIdle() {},
      abort() {},
    };
  };
  deps.agentFactory = runtime.agentFactory;

  const outcome = await runRuntimeAttempt(deps, {
    task: "legacy fallback seam test",
    availableToolNames: ["tap"],
  });

  assert.equal(outcome.result.ok, true);
  assert.match(outcome.result.message, /legacy-fallback-ok/);
  assert.equal(legacyFactoryCalls, 1);
  assert.equal(bridgeFactoryCalls, 0);
});

test("runRuntimeAttempt treats bounded cron step budget exhaustion as a normal completion", async () => {
  const runtime = createRuntimeWithApiKey();
  runtime.adb = {
    queryLaunchablePackages: () => [],
    resolveDeviceId: () => "emulator-5554",
    captureScreenSnapshot: () => makeSnapshot(),
    executeAction: async () => "ok",
  };

  runtime.agentFactory = (options) => {
    const listeners = new Set();
    return {
      followUp() {},
      subscribe(listener) {
        listeners.add(listener);
      },
      async prompt() {
        const tapTool = options.initialState?.tools?.find((item) => item.name === "tap");
        if (!tapTool) {
          throw new Error("tap tool not found");
        }
        for (let i = 0; i < 4; i += 1) {
          if (options.transformContext) {
            await options.transformContext([]);
          }
          await tapTool.execute(`tc-${i + 1}`, { thought: "continue cron pass", x: 32, y: 48 });
          for (const listener of listeners) {
            listener({
              type: "turn_end",
              message: {
                role: "assistant",
                content: [{
                  type: "toolCall",
                  id: `tc-${i + 1}`,
                  name: "tap",
                  arguments: { thought: "continue cron pass", x: 32, y: 48 },
                }],
                stopReason: "toolUse",
                timestamp: Date.now(),
              },
              toolResults: [],
            });
          }
        }
      },
      async waitForIdle() {},
      abort() {},
    };
  };

  const outcome = await runRuntimeAttempt(createAttemptDeps(runtime), {
    task: "Check for new replies and do one focused pass.",
    availableToolNames: ["tap"],
    maxStepsOverride: 2,
    cronTaskPlan: {
      summary: "Do one focused pass and stop.",
      steps: [
        "Check the most relevant conversation surface first.",
        "Take one high-value action if appropriate.",
        "Stop after this pass.",
      ],
      stepBudget: 2,
      completionCriteria: "Finish after one focused pass or when the step budget is exhausted.",
    },
  });

  assert.equal(outcome.result.ok, true);
  assert.match(outcome.result.message, /scheduled run window/i);
  assert.doesNotMatch(outcome.result.message, /Max steps reached/i);
});

test("runRuntimeAttempt retries retryable Codex server errors instead of failing immediately", async () => {
  const runtime = createRuntimeWithApiKey();
  runtime.adb = {
    queryLaunchablePackages: () => [],
    resolveDeviceId: () => "emulator-5554",
    captureScreenSnapshot: () => makeSnapshot({ currentApp: "com.twitter.android" }),
    executeAction: async () => "ok",
  };

  let followUpCalls = 0;
  runtime.agentFactory = (options) => {
    const listeners = new Set();
    let idlePromise = Promise.resolve();

    const emit = (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    return {
      followUp() {
        followUpCalls += 1;
        idlePromise = (async () => {
          if (options.transformContext) {
            await options.transformContext([]);
          }
          const finishTool = options.initialState?.tools?.find((item) => item.name === "finish");
          if (!finishTool) {
            throw new Error("finish tool not found");
          }
          await finishTool.execute("tc-retry-finish", {
            thought: "retry after transient codex error",
            message: "retried ok",
          });
          emit({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "tc-retry-finish",
                name: "finish",
                arguments: {
                  thought: "retry after transient codex error",
                  message: "retried ok",
                },
              }],
              stopReason: "toolUse",
              timestamp: Date.now(),
            },
            toolResults: [],
          });
        })();
      },
      subscribe(listener) {
        listeners.add(listener);
      },
      async prompt() {
        idlePromise = (async () => {
          if (options.transformContext) {
            await options.transformContext([]);
          }
          emit({
            type: "turn_end",
            message: createAssistantErrorMessage(
              'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. Please include the request ID req-codex-retry-1 in your message.","param":null},"sequence_number":2}',
              options.initialState?.model,
            ),
            toolResults: [],
          });
        })();
        await idlePromise;
      },
      async waitForIdle() {
        await idlePromise;
      },
      abort() {},
    };
  };

  const outcome = await runRuntimeAttempt(createAttemptDeps(runtime), {
    task: "Retry transient codex server error",
    availableToolNames: ["finish"],
  });

  assert.equal(outcome.result.ok, true);
  assert.match(outcome.result.message, /retried ok/);
  assert.equal(followUpCalls, 1);
});

test("runRuntimeAttempt does not retry non-retryable Codex model errors", async () => {
  const runtime = createRuntimeWithApiKey();
  runtime.adb = {
    queryLaunchablePackages: () => [],
    resolveDeviceId: () => "emulator-5554",
    captureScreenSnapshot: () => makeSnapshot({ currentApp: "com.twitter.android" }),
    executeAction: async () => "ok",
  };

  let followUpCalls = 0;
  runtime.agentFactory = (options) => {
    const listeners = new Set();
    let idlePromise = Promise.resolve();

    return {
      followUp() {
        followUpCalls += 1;
      },
      subscribe(listener) {
        listeners.add(listener);
      },
      async prompt() {
        idlePromise = (async () => {
          if (options.transformContext) {
            await options.transformContext([]);
          }
          for (const listener of listeners) {
            listener({
              type: "turn_end",
              message: createAssistantErrorMessage(
                'Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Context length exceeded.","param":null},"sequence_number":2}',
                options.initialState?.model,
              ),
              toolResults: [],
            });
          }
        })();
        await idlePromise;
      },
      async waitForIdle() {
        await idlePromise;
      },
      abort() {},
    };
  };

  const outcome = await runRuntimeAttempt(createAttemptDeps(runtime), {
    task: "Do not retry invalid request errors",
    availableToolNames: ["finish"],
  });

  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.message, /context_length_exceeded/);
  assert.equal(followUpCalls, 0);
});
