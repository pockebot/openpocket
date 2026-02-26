import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { ChatAssistant } = await import("../dist/gateway/chat-assistant.js");
const { TelegramGateway } = await import("../dist/gateway/telegram-gateway.js");
const { markWorkspaceOnboardingCompleted } = await import("../dist/memory/workspace.js");

function createAssistantWithApiKey() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-routing-"));
  const prev = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;

  const cfg = loadConfig();
  cfg.models[cfg.defaultModel].apiKey = "test-key";

  fs.writeFileSync(
    path.join(cfg.workspaceDir, "IDENTITY.md"),
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
    path.join(cfg.workspaceDir, "USER.md"),
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

  return { assistant };
}

async function withTempHome(prefix, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    await fn();
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("routing hardening: question-like executable request is forced to task mode", async () => {
  const { assistant } = createAssistantWithApiKey();
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "This can be answered in chat.",
    confidence: 0.93,
    reason: "model_chat",
    requiresExternalObservation: false,
    canAnswerDirectly: true,
  });

  const input = "你可以帮我创建一个 JavaScript 文件 smoke_out/main.js，内容为打印 dual-side-smoke-ok 吗？";
  const out = await assistant.decide(401, input);
  assert.equal(out.mode, "task");
  assert.equal(out.task, input);
  assert.match(out.reason, /executable_intent_task_bias/);
});

test("routing hardening: capability-only question stays in chat mode", async () => {
  const { assistant } = createAssistantWithApiKey();
  assistant.classifyWithModel = async () => ({
    mode: "chat",
    task: "",
    reply: "可以，我能做。",
    confidence: 0.92,
    reason: "model_chat",
    requiresExternalObservation: false,
    canAnswerDirectly: true,
  });

  const input = "你会不会写一个在 emulator 里运行的贪吃蛇 app？";
  const out = await assistant.decide(402, input);
  assert.equal(out.mode, "chat");
  assert.equal(out.task, "");
  assert.match(out.reason, /capability_only_chat/);
});

test("routing hardening: /run command still forces task mode in gateway", async () => {
  await withTempHome("openpocket-routing-run-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});
    gateway.bot.sendMessage = async () => ({});
    gateway.ensurePlayStoreReady = async () => false;

    let decideCalled = 0;
    gateway.chat.decide = async () => {
      decideCalled += 1;
      return {
        mode: "chat",
        task: "",
        reply: "unexpected",
        confidence: 1,
        reason: "unexpected",
      };
    };

    const taskCalls = [];
    gateway.runTaskAsync = async (chatId, task) => {
      taskCalls.push({ chatId, task });
      return true;
    };

    await gateway.consumeMessage({
      chat: { id: 980088419 },
      text: "/run 你再写一个程序，能够稳定地在 emulator 中运行，可以吗？",
    });

    assert.equal(decideCalled, 0);
    assert.equal(taskCalls.length, 1);
    assert.equal(taskCalls[0].chatId, 980088419);
    assert.match(taskCalls[0].task, /emulator/);
  });
});
