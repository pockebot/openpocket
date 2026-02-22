import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../dist/config/index.js");
const { ChatAssistant } = require("../dist/gateway/chat-assistant.js");
const { markWorkspaceOnboardingCompleted, isWorkspaceOnboardingCompleted } = require("../dist/memory/workspace.js");

function withTempCodexHome(prefix, fn) {
  const prev = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CODEX_HOME = codexHome;
  try {
    return fn(codexHome);
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
  assert.equal(out.reason, "model_classify");
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
    assert.equal(out.reason, "model_classify");
  });
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
