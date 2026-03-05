import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { TelegramGateway } = await import("../dist/gateway/telegram-gateway.js");
const { CodingExecutor } = await import("../dist/tools/coding-executor.js");
const { AgentRuntime } = await import("../dist/agent/agent-runtime.js");
const { runRuntimeAttempt } = await import("../dist/agent/runtime/attempt.js");

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

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/g)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
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

test("Dual-side smoke: Telegram instruction writes local JS file", async () => {
  await withTempHome("openpocket-dual-side-telegram-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const coding = new CodingExecutor(cfg);
    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 25 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});
    gateway.bot.sendMessage = async () => ({});

    gateway.chat.decide = async (_chatId, text) => ({
      mode: "task",
      task: `创建文件 smoke_out/main.js，并写入 JavaScript 代码以打印 "dual-side-smoke-ok"。 source=${text.length}`,
      reply: "",
      confidence: 0.99,
      reason: "dual_side_smoke_forced_task_mode",
    });

    let runTaskCalls = 0;
    let resolveTaskDone;
    const taskDone = new Promise((resolve) => {
      resolveTaskDone = resolve;
    });

    gateway.runTaskAsync = async (_chatId, task) => {
      runTaskCalls += 1;
      assert.match(task, /smoke_out\/main\.js/);
      assert.match(task, /dual-side-smoke-ok/);
      await coding.execute({
        type: "write",
        path: "smoke_out/main.js",
        content: "console.log('dual-side-smoke-ok');\n",
        append: false,
      });
      resolveTaskDone();
    };

    await gateway.consumeMessage({
      chat: { id: 980088419 },
      text: "请创建一个 JavaScript 文件 smoke_out/main.js，内容为打印 dual-side-smoke-ok",
    });
    await taskDone;

    assert.equal(runTaskCalls, 1);
    const filePath = path.join(cfg.workspaceDir, "smoke_out", "main.js");
    assert.equal(fs.existsSync(filePath), true);
    assert.match(fs.readFileSync(filePath, "utf-8"), /dual-side-smoke-ok/);
  });
});

test("Dual-side smoke: Android build-install-run diagnostics chain persists unified event lineage", async () => {
  await withTempHome("openpocket-dual-side-android-", async () => {
    const cfg = loadConfig();
    cfg.agent.runtimeBackend = "pi_session_bridge";
    cfg.agent.verbose = false;
    cfg.models[cfg.defaultModel].apiKey = "dual-side-smoke-key";
    cfg.models[cfg.defaultModel].apiKeyEnv = "OPENAI_API_KEY";

    const runtime = new AgentRuntime(cfg);
    runtime.agentFactory = () => {
      throw new Error("legacy agentFactory should not be used in pi_session_bridge smoke");
    };

    const deps = createAttemptDeps(runtime);
    deps.piSessionBridgeFactory = async () => {
      const listeners = new Set();
      const emit = (event) => {
        for (const listener of listeners) {
          listener(event);
        }
      };
      const emitExecCycle = (toolCallId, command, updateText, isError = false) => {
        emit({
          type: "tool_execution_start",
          toolCallId,
          toolName: "exec",
          args: { command },
        });
        emit({
          type: "tool_execution_update",
          toolCallId,
          toolName: "exec",
          args: { command },
          partialResult: {
            content: [{ type: "text", text: updateText }],
          },
        });
        emit({
          type: "tool_execution_end",
          toolCallId,
          toolName: "exec",
          isError,
          result: {
            content: [{ type: "text", text: isError ? "exitCode=1" : "exitCode=0" }],
          },
        });
      };

      return {
        sessionId: "dual-side-smoke-session",
        sessionFile: "/tmp/dual-side-smoke-session.jsonl",
        prompt: async () => {
          emitExecCycle("call-build", "./gradlew assembleDebug", "BUILD SUCCESSFUL in 3s\n");
          emitExecCycle(
            "call-install",
            "adb install -r app/build/outputs/apk/debug/app-debug.apk",
            "Performing Streamed Install\nSuccess\n",
          );
          emitExecCycle(
            "call-run",
            "adb shell am start -n com.example.snake/.MainActivity",
            "Starting: Intent { cmp=com.example.snake/.MainActivity }\n",
          );
          emitExecCycle(
            "call-logcat",
            "adb logcat -d | tail -n 200",
            "FATAL EXCEPTION: main\njava.lang.IllegalStateException\n",
            true,
          );
          emit({
            type: "tool_execution_start",
            toolCallId: "call-fix",
            toolName: "write",
            args: { path: "snake-android/app/src/main/java/com/example/snake/GameLoop.java" },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "call-fix",
            toolName: "write",
            isError: false,
            result: { content: [{ type: "text", text: "write ok" }] },
          });
          emit({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "finish(message=\"android-loop-smoke-ok\")" }],
              stopReason: "stop",
              timestamp: Date.now(),
            },
            toolResults: [],
          });
        },
        abort: async () => {},
        dispose: () => {},
        subscribeRaw: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        subscribeNormalized: (_listener) => () => {},
      };
    };

    const outcome = await runRuntimeAttempt(deps, {
      task: "写一个可在 emulator 运行的贪吃蛇 app，并自动修复直到能启动",
      availableToolNames: ["finish"],
    });

    assert.equal(outcome.result.ok, true);
    assert.match(outcome.result.message, /android-loop-smoke-ok/);
    assert.equal(outcome.shouldReturnHome, true);

    const entries = readJsonl(outcome.result.sessionPath);
    const customEvents = entries.filter((entry) => (
      entry.type === "custom" && entry.customType === "openpocket_event"
    ));

    const eventTriples = customEvents
      .map((entry) => ({
        eventType: entry.data?.details?.eventType,
        toolCallId: entry.data?.details?.toolCallId,
        toolName: entry.data?.details?.toolName,
        args: entry.data?.details?.args,
      }))
      .filter((item) => item.toolCallId);

    const keyset = new Set(eventTriples.map((item) => `${item.eventType}:${item.toolCallId}`));
    for (const required of [
      "tool_execution_start:call-build",
      "tool_execution_update:call-build",
      "tool_execution_end:call-build",
      "tool_execution_start:call-install",
      "tool_execution_update:call-install",
      "tool_execution_end:call-install",
      "tool_execution_start:call-run",
      "tool_execution_update:call-run",
      "tool_execution_end:call-run",
      "tool_execution_start:call-logcat",
      "tool_execution_update:call-logcat",
      "tool_execution_end:call-logcat",
      "tool_execution_start:call-fix",
      "tool_execution_end:call-fix",
    ]) {
      assert.equal(keyset.has(required), true, `missing event lineage node: ${required}`);
    }

    const execStarts = eventTriples.filter((item) => (
      item.eventType === "tool_execution_start" && item.toolName === "exec"
    ));
    const commands = execStarts.map((item) => String(item.args?.command ?? ""));
    assert.equal(commands.some((command) => command.includes("gradlew assembleDebug")), true);
    assert.equal(commands.some((command) => command.includes("adb install -r")), true);
    assert.equal(commands.some((command) => command.includes("adb shell am start")), true);
    assert.equal(commands.some((command) => command.includes("adb logcat -d")), true);
  });
});
