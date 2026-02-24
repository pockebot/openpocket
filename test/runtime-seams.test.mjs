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
  cfg.agent.returnHomeOnTaskEnd = false;
  cfg.models[cfg.defaultModel].apiKey = "";
  cfg.models[cfg.defaultModel].apiKeyEnv = "MISSING_OPENAI_KEY";

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
