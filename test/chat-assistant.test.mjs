import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { ChatAssistant } = await import("../dist/gateway/chat-assistant.js");
const { markWorkspaceOnboardingCompleted, isWorkspaceOnboardingCompleted } = await import("../dist/memory/workspace.js");

async function withTempCodexHome(prefix, fn) {
  const prev = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CODEX_HOME = codexHome;
  try {
    return await fn(codexHome);
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prev;
    }
  }
}

function createAssistant(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-chat-"));
  const prev = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();
  if (options.withApiKey) {
    cfg.models[cfg.defaultModel].apiKey = "test-key";
  } else {
    cfg.models[cfg.defaultModel].apiKey = "";
    cfg.models[cfg.defaultModel].apiKeyEnv = "MISSING_OPENAI_KEY";
    if (!options.allowCodexFallback) {
      cfg.models[cfg.defaultModel].model = "gpt-4.1-mini";
    }
  }

  const identityPath = path.join(cfg.workspaceDir, "IDENTITY.md");
  const userPath = path.join(cfg.workspaceDir, "USER.md");
  if (!options.keepProfileEmpty) {
    fs.writeFileSync(
      identityPath,
      [
        "# IDENTITY",
        "",
        "## Agent Identity",
        "",
        "- Name: Pocket",
        "- Role: Android phone-use automation agent",
        "- Persona: pragmatic and concise",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      userPath,
      [
        "# USER",
        "",
        "## Profile",
        "",
        "- Preferred form of address: Sergio",
      ].join("\n"),
      "utf-8",
    );
    const bootstrapPath = path.join(cfg.workspaceDir, "BOOTSTRAP.md");
    if (fs.existsSync(bootstrapPath)) {
      fs.unlinkSync(bootstrapPath);
    }
    markWorkspaceOnboardingCompleted(cfg.workspaceDir);
  } else {
    fs.writeFileSync(identityPath, "", "utf-8");
    fs.writeFileSync(userPath, "", "utf-8");
  }

  const assistant = new ChatAssistant(cfg);
  assistant.auditGroundingNeed = async () => ({
    requiresExternalObservation: false,
    canAnswerDirectly: true,
    confidence: 0.95,
    reason: "test_default_grounding_audit",
  });
  if (prev === undefined) {
    delete process.env.OPENPOCKET_HOME;
  } else {
    process.env.OPENPOCKET_HOME = prev;
  }
  return { assistant, cfg, home };
}

test("ChatAssistant decide relies on model routing for greeting text", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "",
    confidence: 0.93,
    reason: "model_classify",
  });

  const out = await assistant.decide(1, "hi");
  assert.equal(out.mode, "chat");
  assert.match(out.reason, /model_classify/);
  assert.equal(out.reply, "");
});

test("ChatAssistant decide keeps model task result", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.classifyWithModel = async () => ({
    mode: "task",
    task: "search weather in san francisco",
    reply: "",
    confidence: 0.88,
    reason: "model_task",
  });

  const out = await assistant.decide(2, "search weather in san francisco");
  assert.equal(out.mode, "task");
  assert.equal(out.task, "search weather in san francisco");
  assert.equal(out.reason, "model_task");
});

test("ChatAssistant decide routes to task when model marks external observation required", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "I can answer this without running tools.",
    confidence: 0.92,
    reason: "model_classify",
    requiresExternalObservation: true,
    canAnswerDirectly: false,
  });

  const input = "What Android version are you currently running on?";
  const out = await assistant.decide(22, input);
  assert.equal(out.mode, "task");
  assert.equal(out.task, input);
  assert.match(out.reason, /requires_external_observation/);
  assert.equal(out.reply, "");
  assert.equal(out.confidence >= 0.8, true);
});

test("ChatAssistant decide falls back to task on low-confidence chat classification", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "",
    confidence: 0.41,
    reason: "model_classify",
    requiresExternalObservation: false,
    canAnswerDirectly: true,
  });

  const input = "Check whether the runtime is healthy and tell me the result";
  const out = await assistant.decide(23, input);
  assert.equal(out.mode, "task");
  assert.equal(out.task, input);
  assert.match(out.reason, /low_confidence_task_fallback/);
});

test("ChatAssistant decide upgrades high-confidence chat to task when grounding audit requires execution", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "This looks answerable in chat.",
    confidence: 0.97,
    reason: "model_classify",
    requiresExternalObservation: false,
    canAnswerDirectly: true,
  });
  assistant.auditGroundingNeed = async () => ({
    requiresExternalObservation: true,
    canAnswerDirectly: false,
    confidence: 0.86,
    reason: "state_dependent_runtime_fact",
  });

  const input = "What app is currently open on the phone right now?";
  const out = await assistant.decide(24, input);
  assert.equal(out.mode, "task");
  assert.equal(out.task, input);
  assert.match(out.reason, /requires_external_observation/);
});

test("ChatAssistant decide routes capability-style runtime introspection question to task when grounding audit requires observation", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "I can answer this directly.",
    confidence: 0.96,
    reason: "model_classify",
    requiresExternalObservation: false,
    canAnswerDirectly: true,
  });
  assistant.auditGroundingNeed = async () => ({
    requiresExternalObservation: true,
    canAnswerDirectly: false,
    confidence: 0.9,
    reason: "runtime_state_requires_probe",
  });

  const input = "Can you tell me what Android version the connected device is currently running?";
  const out = await assistant.decide(27, input);
  assert.equal(out.mode, "task");
  assert.equal(out.task, input);
  assert.match(out.reason, /requires_external_observation/);
});

test("ChatAssistant decide detects implicit Chinese schedule intent and prepares confirmation preview", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.extractScheduleIntentWithModel = async () => ({
    intent: {
      sourceText: "每天早上 8 点帮我打开 Slack 去打卡",
      normalizedTask: "打开 Slack 去打卡",
      schedule: {
        kind: "cron",
        expr: "0 8 * * *",
        at: null,
        everyMs: null,
        tz: "Asia/Shanghai",
        summaryText: "每天 08:00",
      },
      delivery: null,
      requiresConfirmation: true,
      confirmationPrompt: "我理解为：创建一个每天 08:00执行的定时任务，内容是“打开 Slack 去打卡”。回复“确认”创建，回复“取消”放弃。",
    },
    confidence: 0.98,
    reason: "schedule_model",
  });
  assistant.classifyWithModel = async () => {
    throw new Error("classifyWithModel should not run after schedule extraction");
  };

  const out = await assistant.decide(28, "每天早上 8 点帮我打开 Slack 去打卡");
  assert.equal(out.mode, "schedule_intent");
  assert.equal(out.task, "打开 Slack 去打卡");
  assert.equal(out.reply.length > 0, true);
  assert.equal(out.scheduleIntent?.requiresConfirmation, true);
  assert.equal(out.scheduleIntent?.normalizedTask, "打开 Slack 去打卡");
  assert.equal(out.scheduleIntent?.schedule.kind, "cron");
  assert.equal(out.scheduleIntent?.schedule.expr, "0 8 * * *");
  assert.equal(typeof out.scheduleIntent?.schedule.tz, "string");
  assert.equal(Boolean(out.scheduleIntent?.schedule.tz), true);
  assert.match(out.scheduleIntent?.schedule.summaryText ?? "", /每天 08:00/);
  assert.match(out.reply, /确认/);
});

test("ChatAssistant decide keeps time-related capability question in chat mode", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "This is just a phrasing question.",
    confidence: 0.96,
    reason: "model_classify",
    requiresExternalObservation: false,
    canAnswerDirectly: true,
  });

  const out = await assistant.decide(29, "你能告诉我“每天早上 8 点”用英语怎么说吗？");
  assert.equal(out.mode, "chat");
  assert.equal(out.task, "");
  assert.equal(out.reply, "This is just a phrasing question.");
  assert.match(out.reason, /model_classify/);
});

test("ChatAssistant decide does not misroute troubleshooting text into schedule intent", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.extractScheduleIntentWithModel = async () => null;
  assistant.classifyWithModel = async () => ({
    mode: "task",
    task: "每天早上8点都打不开 Slack，帮我看下原因",
    reply: "",
    confidence: 0.95,
    reason: "model_task",
  });

  const out = await assistant.decide(30, "每天早上8点都打不开 Slack，帮我看下原因");
  assert.equal(out.mode, "task");
  assert.equal(out.task, "每天早上8点都打不开 Slack，帮我看下原因");
  assert.equal(out.reason, "model_task");
});

test("ChatAssistant decide skips profile timezone reads for non-schedule executable tasks", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.extractScheduleIntentWithModel = async () => null;
  assistant.readProfileSnapshot = () => {
    throw new Error("readProfileSnapshot should not run for non-schedule tasks");
  };
  assistant.classifyWithModel = async () => ({
    mode: "task",
    task: "打开 Slack",
    reply: "",
    confidence: 0.97,
    reason: "model_task",
  });

  const out = await assistant.decide(31, "打开 Slack");
  assert.equal(out.mode, "task");
  assert.equal(out.task, "打开 Slack");
  assert.equal(out.reason, "model_task");
});

test("ChatAssistant decide treats one-shot tomorrow phrasing as schedule intent", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.extractScheduleIntentWithModel = async () => ({
    intent: {
      sourceText: "明天早上 8 点帮我打开 Slack 去打卡",
      normalizedTask: "打开 Slack 去打卡",
      schedule: {
        kind: "at",
        expr: null,
        at: "2026-03-08T08:00:00+08:00",
        everyMs: null,
        tz: "Asia/Shanghai",
        summaryText: "明天 08:00",
      },
      delivery: null,
      requiresConfirmation: true,
      confirmationPrompt: "我理解为：创建一个明天 08:00执行的定时任务，内容是“打开 Slack 去打卡”。回复“确认”创建，回复“取消”放弃。",
    },
    confidence: 0.98,
    reason: "schedule_model",
  });
  assistant.classifyWithModel = async () => {
    throw new Error("classifyWithModel should not run after schedule extraction");
  };

  const out = await assistant.decide(32, "明天早上 8 点帮我打开 Slack 去打卡");
  assert.equal(out.mode, "schedule_intent");
  assert.equal(out.task, "打开 Slack 去打卡");
  assert.equal(out.scheduleIntent?.schedule.kind, "at");
  assert.equal(out.scheduleIntent?.schedule.at, "2026-03-08T08:00:00+08:00");
  assert.match(out.scheduleIntent?.schedule.summaryText ?? "", /明天 08:00/);
  assert.match(out.reply, /确认/);
});

test("ChatAssistant decide ignores low-confidence schedule extraction and falls back to normal routing", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.extractScheduleIntentWithModel = async () => ({
    intent: {
      sourceText: "每天早上 8 点帮我打开 Slack 去打卡",
      normalizedTask: "打开 Slack 去打卡",
      schedule: {
        kind: "cron",
        expr: "0 8 * * *",
        at: null,
        everyMs: null,
        tz: "Asia/Shanghai",
        summaryText: "每天 08:00",
      },
      delivery: null,
      requiresConfirmation: true,
      confirmationPrompt: "confirm",
    },
    confidence: 0.31,
    reason: "schedule_model_low_confidence",
  });
  assistant.classifyWithModel = async () => ({
    mode: "task",
    task: "每天早上 8 点帮我打开 Slack 去打卡",
    reply: "",
    confidence: 0.95,
    reason: "model_task",
  });

  const out = await assistant.decide(35, "每天早上 8 点帮我打开 Slack 去打卡");
  assert.equal(out.mode, "task");
  assert.equal(out.reason, "model_task");
});

test("ChatAssistant decide logs a warning when schedule extraction fails before falling back", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  const logs = [];
  assistant.logChat = (level, message) => {
    logs.push({ level, message });
  };
  assistant.extractScheduleIntentWithModel = async () => {
    throw new Error("schedule endpoint unavailable");
  };
  assistant.classifyWithModel = async () => ({
    mode: "task",
    task: "open Slack",
    reply: "",
    confidence: 0.95,
    reason: "model_task",
  });

  const out = await assistant.decide(36, "open Slack");
  assert.equal(out.mode, "task");
  assert.equal(out.reason, "model_task");
  assert.equal(logs.some((entry) => entry.level === "warn" && /schedule extraction failed/i.test(entry.message)), true);
});

test("ChatAssistant decide does not misroute schedule-shaped translation request", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.extractScheduleIntentWithModel = async () => null;
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "This is a translation question.",
    confidence: 0.95,
    reason: "model_classify",
    requiresExternalObservation: false,
    canAnswerDirectly: true,
  });

  const out = await assistant.decide(33, "每天早上8点打开 Slack 这句话怎么翻译成英文？");
  assert.equal(out.mode, "chat");
  assert.equal(out.task, "");
  assert.equal(out.reply, "This is a translation question.");
  assert.match(out.reason, /model_classify/);
});

test("ChatAssistant decide does not infer schedule intent without model access", async () => {
  const { assistant } = createAssistant();

  const out = await assistant.decide(34, "每天早上 8 点帮我打开 Slack 去打卡");
  assert.equal(out.mode, "chat");
  assert.equal(out.reason, "no_api_key");
});

test("ChatAssistant decide reports missing API key without heuristics", async () => {
  await withTempCodexHome("openpocket-codex-empty-", async () => {
    const { assistant } = createAssistant();
    const out = await assistant.decide(3, "hi");
    assert.equal(out.mode, "chat");
    assert.equal(out.reason, "no_api_key");
    assert.match(out.reply, /API key.*not configured/i);
  });
});

test("ChatAssistant reply handles missing API key gracefully", async () => {
  await withTempCodexHome("openpocket-codex-empty-", async () => {
    const { assistant } = createAssistant();
    const out = await assistant.reply(4, "who are you");
    assert.match(out, /API key.*not configured/i);
  });
});

test("ChatAssistant decide uses Codex CLI credentials fallback", async () => {
  await withTempCodexHome("openpocket-codex-auth-", async (codexHome) => {
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

    const { assistant } = createAssistant({ allowCodexFallback: true });
    assistant.classifyWithModel = async () => ({
      mode: "chat",
      task: "",
      reply: "",
      confidence: 0.9,
      reason: "model_classify",
    });

    const out = await assistant.decide(5, "hello from codex auth fallback");
    assert.equal(out.mode, "chat");
    assert.match(out.reason, /model_classify/);
  });
});

test("ChatAssistant reply forces codex-responses transport for Codex CLI auth", async () => {
  await withTempCodexHome("openpocket-codex-reply-", async (codexHome) => {
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

    const { assistant } = createAssistant({ allowCodexFallback: true });
    assistant.modeHint = "chat";
    let codexTransportCalls = 0;
    assistant.callCodexResponsesText = async () => {
      codexTransportCalls += 1;
      return "codex transport reply";
    };
    assistant.askChat = async () => {
      throw new Error("chat endpoint should not be used for codex fallback");
    };
    assistant.askCompletions = async () => {
      throw new Error("completions endpoint should not be used for codex fallback");
    };

    const out = await assistant.reply(6, "hello from codex reply");
    assert.equal(out, "codex transport reply");
    assert.equal(codexTransportCalls, 1);
  });
});

test("ChatAssistant plans task execution surface with model-driven output", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.callModelRaw = async () => JSON.stringify({
    surface: "coding_first",
    confidence: 0.92,
    reason: "Primary evidence is expected from local runtime and CLI state.",
  });

  const plan = await assistant.planTaskExecution("Check which model is currently being used.");
  assert.equal(plan?.surface, "coding_first");
  assert.equal(plan?.confidence, 0.92);
  assert.match(plan?.reason ?? "", /runtime and CLI state/i);
});

test("ChatAssistant task execution planner falls back to hybrid on invalid model output", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.callModelRaw = async () => "not-a-json";

  const plan = await assistant.planTaskExecution("Inspect current execution surface");
  assert.equal(plan?.surface, "hybrid");
  assert.equal(plan?.confidence, 0.5);
  assert.match(plan?.reason ?? "", /fallback/i);
});

test("ChatAssistant runs profile onboarding when identity and user are empty", async () => {
  const { assistant, cfg } = createAssistant({ keepProfileEmpty: true });

  const first = await assistant.decide(7, "hello");
  assert.equal(first.mode, "chat");
  assert.equal(first.reason, "profile_onboarding");
  assert.match(first.reply, /how would you like me to address you/i);

  const second = await assistant.decide(7, "Sergio");
  assert.match(second.reply, /what name would you like to call me/i);

  const third = await assistant.decide(7, "Pocket");
  assert.match(third.reply, /persona\/tone/i);
  assert.match(third.reply, /1\) Professional/);

  const done = await assistant.decide(7, "Pragmatic, calm, and direct");
  assert.match(done.reply, /saved your profile/i);

  const identityBody = fs.readFileSync(path.join(cfg.workspaceDir, "IDENTITY.md"), "utf-8");
  const userBody = fs.readFileSync(path.join(cfg.workspaceDir, "USER.md"), "utf-8");
  assert.match(identityBody, /Name: Pocket/);
  assert.match(identityBody, /Persona: Pragmatic, calm, and direct/);
  assert.match(userBody, /Preferred form of address: Sergio/);
  assert.match(userBody, /Preferred assistant name: Pocket/);
});

test("ChatAssistant onboarding follows Chinese and supports one-shot multi-field answer", async () => {
  const { assistant, cfg } = createAssistant({ keepProfileEmpty: true });

  const first = await assistant.decide(9, "你好");
  assert.equal(first.mode, "chat");
  assert.equal(first.reason, "profile_onboarding");
  assert.match(first.reply, /我该怎么称呼你/);

  const done = await assistant.decide(
    9,
    "你可以叫我小陈，你就叫Pocket，人设：冷静务实",
  );
  assert.equal(done.mode, "chat");
  assert.equal(done.reason, "profile_onboarding");
  assert.match(done.reply, /已经写入 USER\.md 和 IDENTITY\.md/);

  const identityBody = fs.readFileSync(path.join(cfg.workspaceDir, "IDENTITY.md"), "utf-8");
  const userBody = fs.readFileSync(path.join(cfg.workspaceDir, "USER.md"), "utf-8");
  assert.match(identityBody, /Name: Pocket/);
  assert.match(identityBody, /Persona: 冷静务实/);
  assert.match(userBody, /Preferred form of address: 小陈/);
  assert.match(userBody, /Preferred assistant name: Pocket/);
});

test("ChatAssistant onboarding accepts persona preset index", async () => {
  const { assistant, cfg } = createAssistant({ keepProfileEmpty: true });

  await assistant.decide(15, "hello");
  await assistant.decide(15, "Sergio");
  await assistant.decide(15, "Jarvis");
  const done = await assistant.decide(15, "2");
  assert.match(done.reply, /saved your profile/i);

  const identityBody = fs.readFileSync(path.join(cfg.workspaceDir, "IDENTITY.md"), "utf-8");
  assert.match(identityBody, /Persona: fast and direct/);
});

test("ChatAssistant auto-completes onboarding defaults when a task request arrives", async () => {
  const { assistant, cfg } = createAssistant({ withApiKey: true, keepProfileEmpty: true });
  let bootstrapCalls = 0;
  assistant.requestBootstrapOnboardingDecision = async () => {
    bootstrapCalls += 1;
    return {
      reply: "onboarding should be skipped for task-style request",
      onboardingComplete: false,
    };
  };
  assistant.classifyWithModel = async () => ({
    mode: "task",
    task: "查询旧金山天气",
    reply: "",
    confidence: 0.9,
    reason: "model_task",
  });

  const out = await assistant.decide(25, "你可以帮我查询一下旧金山的天气吗");
  assert.equal(out.mode, "task");
  assert.equal(out.reason, "model_task");
  assert.equal(bootstrapCalls, 0);

  const identityBody = fs.readFileSync(path.join(cfg.workspaceDir, "IDENTITY.md"), "utf-8");
  const userBody = fs.readFileSync(path.join(cfg.workspaceDir, "USER.md"), "utf-8");
  assert.match(identityBody, /Name: OpenPocket/);
  assert.match(identityBody, /Persona: 务实、冷静、可靠/);
  assert.match(userBody, /Preferred form of address: 用户/);
  assert.equal(isWorkspaceOnboardingCompleted(cfg.workspaceDir), true);

  const payload = assistant.consumePendingProfileUpdate(25);
  assert.equal(payload?.assistantName, "OpenPocket");
  assert.equal(payload?.locale, "zh");
});

test("ChatAssistant completes remaining onboarding fields when user switches to task mid-flow", async () => {
  const { assistant, cfg } = createAssistant({ withApiKey: true, keepProfileEmpty: true });
  let bootstrapCalls = 0;
  assistant.requestBootstrapOnboardingDecision = async () => {
    bootstrapCalls += 1;
    return {
      reply: "最后一步：请告诉我希望的语气风格。",
      onboardingComplete: false,
    };
  };
  assistant.classifyWithModel = async () => ({
    mode: "task",
    task: "下载 X",
    reply: "",
    confidence: 0.88,
    reason: "model_task",
  });

  const first = await assistant.decide(26, "我叫 Yuheng，你叫 Jarvis");
  assert.equal(first.reason, "profile_onboarding");

  const second = await assistant.decide(26, "你能下载一下 X 然后帮我刷推吗");
  assert.equal(second.mode, "task");
  assert.equal(second.reason, "model_task");
  assert.equal(bootstrapCalls, 1);

  const identityBody = fs.readFileSync(path.join(cfg.workspaceDir, "IDENTITY.md"), "utf-8");
  assert.match(identityBody, /Name: Jarvis/);
  assert.match(identityBody, /Persona: 务实、冷静、可靠/);
});

test("ChatAssistant onboarding reads question copy and presets from PROFILE_ONBOARDING.json", async () => {
  const { assistant, cfg } = createAssistant({ keepProfileEmpty: true });

  fs.writeFileSync(
    path.join(cfg.workspaceDir, "PROFILE_ONBOARDING.json"),
    `${JSON.stringify({
      version: 1,
      locales: {
        zh: {
          questions: {
            step1: "【自定义Q1】先告诉我怎么称呼你",
            step2: "【自定义Q2】你希望我叫什么",
            step3: "【自定义Q3】选一个语气编号",
          },
          personaPresets: [
            {
              value: "冷静执行：只给结论和下一步",
              aliases: ["9"],
            },
          ],
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );

  const first = await assistant.decide(16, "你好");
  assert.match(first.reply, /自定义Q1/);
  const second = await assistant.decide(16, "Sergio");
  assert.match(second.reply, /自定义Q2/);
  const third = await assistant.decide(16, "Jarvis");
  assert.match(third.reply, /自定义Q3/);
  await assistant.decide(16, "9");

  const identityBody = fs.readFileSync(path.join(cfg.workspaceDir, "IDENTITY.md"), "utf-8");
  assert.match(identityBody, /Persona: 冷静执行：只给结论和下一步/);
});

test("ChatAssistant onboarding triggers on default scaffold with blank profile fields", async () => {
  const { assistant, cfg } = createAssistant({ withApiKey: true });
  assistant.requestBootstrapOnboardingDecision = async () => ({
    reply: "先做个简短初始化：我该怎么称呼你？",
    writeProfile: false,
    onboardingComplete: false,
  });

  fs.writeFileSync(
    path.join(cfg.workspaceDir, "IDENTITY.md"),
    [
      "# IDENTITY",
      "",
      "## Agent Identity",
      "",
      "- Name: OpenPocket",
      "- Role: Android phone-use automation agent",
      "- Primary objective: execute user tasks safely and efficiently",
      "",
      "## Behavioral Defaults",
      "",
      "- Language for model thought/action text: English",
      "- Planning style: sub-goal driven, one deterministic step at a time",
      "- Escalation trigger: request_human_auth when real-device authorization is required",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(cfg.workspaceDir, "USER.md"),
    [
      "# USER",
      "",
      "## Profile",
      "",
      "- Name:",
      "- Preferred form of address:",
      "- Timezone:",
      "- Language preference:",
    ].join("\n"),
    "utf-8",
  );

  const out = await assistant.decide(11, "你好");
  assert.equal(out.mode, "chat");
  assert.equal(out.reason, "profile_onboarding");
  assert.match(out.reply, /我该怎么称呼你/);
});

test("ChatAssistant model-driven onboarding completes and removes bootstrap file", async () => {
  const { assistant, cfg } = createAssistant({ withApiKey: true, keepProfileEmpty: true });
  let step = 0;
  assistant.requestBootstrapOnboardingDecision = async () => {
    step += 1;
    if (step === 1) {
      return {
        reply: "你好，我先确认下：我该怎么称呼你？",
        writeProfile: false,
        onboardingComplete: false,
      };
    }
    return {
      reply: "好的，初始化完成。我会按你的设定继续。",
      profile: {
        userPreferredAddress: "Sergio",
        assistantName: "Jarvis-Phone",
        assistantPersona: "professional and reliable",
        userName: "Sergio Chan",
        timezone: "America/Los_Angeles",
        languagePreference: "zh-CN",
      },
      writeProfile: true,
      onboardingComplete: true,
    };
  };

  const first = await assistant.decide(41, "你好");
  assert.equal(first.reason, "profile_onboarding");
  assert.match(first.reply, /我该怎么称呼你/);

  const second = await assistant.decide(41, "你叫 Jarvis-Phone，人设专业可靠，叫我 Sergio");
  assert.equal(second.reason, "profile_onboarding");
  assert.match(second.reply, /初始化完成/);

  const identityBody = fs.readFileSync(path.join(cfg.workspaceDir, "IDENTITY.md"), "utf-8");
  const userBody = fs.readFileSync(path.join(cfg.workspaceDir, "USER.md"), "utf-8");
  assert.match(identityBody, /Name: Jarvis-Phone/);
  assert.match(identityBody, /Persona: professional and reliable/);
  assert.match(userBody, /Preferred form of address: Sergio/);
  assert.match(userBody, /Name: Sergio Chan/);
  assert.match(userBody, /Timezone: America\/Los_Angeles/);
  assert.match(userBody, /Language preference: zh-CN/);

  assert.equal(fs.existsSync(path.join(cfg.workspaceDir, "BOOTSTRAP.md")), false);
  assert.equal(isWorkspaceOnboardingCompleted(cfg.workspaceDir), true);
  const payload = assistant.consumePendingProfileUpdate(41);
  assert.equal(payload?.assistantName, "Jarvis-Phone");
});

test("ChatAssistant does not accept model completion wording when required onboarding fields are still missing", async () => {
  const { assistant } = createAssistant({ withApiKey: true, keepProfileEmpty: true });
  assistant.requestBootstrapOnboardingDecision = async () => ({
    reply: "Perfect, Sergio — all set. You can call me OpenPocket.",
    profile: {
      userPreferredAddress: "sergio",
      assistantName: "OpenPocket",
      assistantPersona: "pragmatic, calm, reliable",
    },
    writeProfile: true,
    onboardingComplete: true,
  });

  const out = await assistant.decide(42, "叫我 sergio");
  assert.equal(out.mode, "chat");
  assert.equal(out.reason, "profile_onboarding");
  assert.match(out.reply, /希望我叫什么名字|what name would you like to call me/i);
  assert.doesNotMatch(out.reply, /all set/i);
});

test("ChatAssistant exposes pending profile update after onboarding completion", async () => {
  const { assistant } = createAssistant({ keepProfileEmpty: true });

  await assistant.decide(21, "hello");
  await assistant.decide(21, "Sergio");
  await assistant.decide(21, "Jarvis");
  await assistant.decide(21, "professional and reliable");

  const payload = assistant.consumePendingProfileUpdate(21);
  assert.equal(payload?.assistantName, "Jarvis");
  assert.equal(payload?.locale, "en");
  const secondRead = assistant.consumePendingProfileUpdate(21);
  assert.equal(secondRead, null);
});

test("ChatAssistant updates profile from regular rename message", async () => {
  const { assistant, cfg } = createAssistant();

  const out = await assistant.decide(31, "你把名字改成 Jarvis-Phone 吧");
  assert.equal(out.mode, "chat");
  assert.equal(out.reason, "profile_update");
  assert.match(out.reply, /我的名字改为“Jarvis-Phone”/);

  const identityBody = fs.readFileSync(path.join(cfg.workspaceDir, "IDENTITY.md"), "utf-8");
  const userBody = fs.readFileSync(path.join(cfg.workspaceDir, "USER.md"), "utf-8");
  assert.match(identityBody, /Name: Jarvis-Phone/);
  assert.match(userBody, /Preferred assistant name: Jarvis-Phone/);

  const payload = assistant.consumePendingProfileUpdate(31);
  assert.equal(payload?.assistantName, "Jarvis-Phone");
  assert.equal(payload?.locale, "zh");
});

test("ChatAssistant taskAcceptedReply fallback uses natural non-fixed wording in English", async () => {
  const { assistant } = createAssistant();
  const out = await assistant.taskAcceptedReply("Read the latest picture and beautify it", "en");

  assert.match(
    out,
    /^(Starting now|Task received\. Beginning now|I am starting this now|Working on it now):/i,
  );
  assert.doesNotMatch(out, /^On it,\s*I am starting this task:/i);
});

test("ChatAssistant taskAcceptedReply fallback keeps English template even for Chinese locale", async () => {
  const { assistant } = createAssistant();
  const out = await assistant.taskAcceptedReply("读取手机上最新的照片并进行美化编辑", "zh");

  assert.match(
    out,
    /^(Starting now|Task received\. Beginning now|I am starting this now|Working on it now):/i,
  );
  assert.doesNotMatch(out, /^(收到|任务已接收|明白|好的)/);
});

test("ChatAssistant narrateTaskProgress uses model decision output", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  let capturedPrompt = "";
  assistant.requestTaskProgressNarrationDecision = async (_client, _model, _maxTokens, prompt) => {
    capturedPrompt = prompt;
    return {
      notify: true,
      message: "进度 4/20：已进入 Gmail 收件箱。",
      reason: "checkpoint",
    };
  };

  const out = await assistant.narrateTaskProgress({
    task: "打开 Gmail 并进入收件箱",
    locale: "zh",
    progress: {
      step: 4,
      maxSteps: 20,
      currentApp: "com.google.android.gm",
      actionType: "tap",
      message: "Tapped inbox",
      thought: "open inbox",
      screenshotPath: null,
    },
    recentProgress: [
      {
        step: 3,
        maxSteps: 20,
        currentApp: "com.google.android.gm",
        actionType: "wait",
        message: "waited",
        thought: "waiting for list",
        screenshotPath: null,
      },
    ],
    lastNotifiedProgress: {
      step: 1,
      maxSteps: 20,
      currentApp: "com.google.android.gm",
      actionType: "launch_app",
      message: "Opened app",
      thought: "start app",
      screenshotPath: null,
    },
    skippedSteps: 2,
  });

  assert.equal(out.notify, true);
  assert.match(out.message, /进度 4\/20/);
  assert.match(capturedPrompt, /TASK_PROGRESS_REPORTER\.md/);
  assert.match(capturedPrompt, /Progress context JSON/);
});

test("ChatAssistant narrateTaskProgress falls back when model output is unavailable", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.requestTaskProgressNarrationDecision = async () => null;

  const out = await assistant.narrateTaskProgress({
    task: "open Gmail",
    locale: "en",
    progress: {
      step: 1,
      maxSteps: 10,
      currentApp: "com.google.android.gm",
      actionType: "launch_app",
      message: "Opened app",
      thought: "launch Gmail first",
      screenshotPath: null,
    },
    recentProgress: [],
    lastNotifiedProgress: null,
    skippedSteps: 0,
  });

  assert.equal(out.notify, true);
  assert.match(out.message, /Quick update:/i);
});

test("ChatAssistant narrateTaskOutcome rewrites final output with model decision", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  let capturedPrompt = "";
  assistant.requestTaskOutcomeNarration = async (_client, _model, _maxTokens, prompt) => {
    capturedPrompt = prompt;
    return "旧金山当前 51°F，晴到多云，体感 46°F。每小时和未来几天预报都已显示。";
  };

  const out = await assistant.narrateTaskOutcome({
    task: "搜索旧金山天气",
    locale: "zh",
    ok: true,
    rawResult: "Task completed. Search results for San Francisco weather are displayed.",
    recentProgress: [],
    skillPath: "/tmp/skill.md",
    scriptPath: "/tmp/script.sh",
  });

  assert.match(out, /51°F/);
  assert.match(capturedPrompt, /TASK_OUTCOME_REPORTER\.md/);
  assert.match(capturedPrompt, /artifacts/);
});

test("ChatAssistant narrateTaskOutcome falls back and strips boilerplate", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.requestTaskOutcomeNarration = async () => null;

  const out = await assistant.narrateTaskOutcome({
    task: "check weather",
    locale: "en",
    ok: true,
    rawResult: "Task completed. Weather is 51F with clear sky.",
    recentProgress: [],
    skillPath: null,
    scriptPath: null,
  });

  assert.doesNotMatch(out, /^Task completed/i);
  assert.match(out, /Weather is 51F/i);
});

test("ChatAssistant narrateTaskOutcome keeps multiline result, marks unavailable direct links, and adds labeled search fallbacks", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  assistant.requestTaskOutcomeNarration = async () => [
    "Available places to buy Nike Mind 002:",
    "- GOAT — $189 — In stock online",
    "- StockX — $290 — In stock online",
  ].join("\n");

  const out = await assistant.narrateTaskOutcome({
    task: "Find where to buy mike mind 02 for men, where is available to buy",
    locale: "en",
    ok: true,
    rawResult: "GOAT and StockX listings found for Nike Mind 002.",
    recentProgress: [],
    skillPath: null,
    scriptPath: null,
  });

  assert.match(out, /Observed listings for Nike Mind 002:/);
  assert.match(out, /\n- GOAT/);
  assert.match(out, /listed as in stock \(unverified\)/);
  assert.match(out, /No verifiable direct product URLs were captured/);
  assert.match(out, /Store links:/);
  assert.doesNotMatch(out, /Store links \(verified\):/);
  assert.match(out, /- GOAT: link unavailable/);
  assert.match(out, /- StockX: link unavailable/);
  assert.match(out, /Quick search links \(not direct product pages\):/);
  assert.match(out, /https:\/\/www\.goat\.com\/search\?query=Nike%20Mind%20002/);
  assert.match(out, /https:\/\/stockx\.com\/search\?s=Nike%20Mind%20002/);
});

test("ChatAssistant narrateEscalation fallback generates concise local-security reassurance", async () => {
  const { assistant } = createAssistant();
  const out = await assistant.narrateEscalation({
    event: "human_auth",
    locale: "zh",
    task: "登录 Duolingo",
    capability: "oauth",
    currentApp: "unknown",
    instruction: "Please enter username and password.",
    reason: "Sensitive credentials are required.",
    hasWebLink: true,
    isCodeFlow: false,
    includeLocalSecurityAssurance: true,
  });

  assert.match(out, /登录授权/);
  assert.match(out, /本机上的 OpenPocket Relay/);
  assert.doesNotMatch(out, /Instruction:/i);
  assert.doesNotMatch(out, /Reason:/i);
  assert.doesNotMatch(out, /Request ID/i);
});

test("ChatAssistant narrateEscalation uses model output when available", async () => {
  const { assistant } = createAssistant({ withApiKey: true });
  let capturedPrompt = "";
  assistant.requestEscalationNarration = async (_client, _model, _maxTokens, prompt) => {
    capturedPrompt = prompt;
    return "我这边卡在登录确认，请打开授权链接完成后告诉我，我会继续。";
  };

  const out = await assistant.narrateEscalation({
    event: "human_auth",
    locale: "zh",
    task: "登录 Duolingo",
    capability: "oauth",
    currentApp: "com.duolingo",
    instruction: "Take over and sign in.",
    reason: "credential-required",
    hasWebLink: true,
    isCodeFlow: false,
    includeLocalSecurityAssurance: true,
  });

  assert.match(out, /打开授权链接/);
  assert.match(capturedPrompt, /Escalation context JSON/);
  assert.match(capturedPrompt, /includeLocalSecurityAssurance/);
  assert.match(capturedPrompt, /event/);
});
