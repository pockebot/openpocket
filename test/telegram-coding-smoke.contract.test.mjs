import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { TelegramGateway } = await import("../dist/gateway/telegram-gateway.js");

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

test("Telegram coding smoke contract: explicit file-create message routes to task execution", async () => {
  await withTempHome("openpocket-telegram-coding-contract-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});
    gateway.bot.sendMessage = async () => ({});

    const taskCalls = [];
    gateway.chat.decide = async (_chatId, text) => ({
      mode: "task",
      task: `Create file smoke_out/main.js and write JavaScript that prints "dual-side-smoke-ok". source=${text.length}`,
      reply: "",
      confidence: 0.99,
      reason: "contract_test_forced_task_mode",
    });
    gateway.runTaskAsync = async (chatId, task) => {
      taskCalls.push({ chatId, task });
    };

    const text = "Please create a JavaScript file smoke_out/main.js that prints dual-side-smoke-ok";
    await gateway.consumeMessage({ chat: { id: 980088419 }, text });

    assert.equal(taskCalls.length, 1);
    assert.equal(taskCalls[0].chatId, 980088419);
    assert.match(taskCalls[0].task, /smoke_out\/main\.js/);
    assert.match(taskCalls[0].task, /dual-side-smoke-ok/);
  });
});

test("Telegram coding smoke contract: /run forces task mode even with question-like phrasing", async () => {
  await withTempHome("openpocket-telegram-coding-run-contract-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});
    gateway.bot.sendMessage = async () => ({});

    let decideCalled = 0;
    gateway.chat.decide = async () => {
      decideCalled += 1;
      return {
        mode: "chat",
        task: "",
        reply: "should not be used",
        confidence: 1,
        reason: "unexpected",
      };
    };

    const taskCalls = [];
    gateway.runTaskAsync = async (chatId, task) => {
      taskCalls.push({ chatId, task });
    };

    await gateway.consumeMessage({
      chat: { id: 980088419 },
      text: "/run Please write a Snake game app that can run reliably in the current ADK and in the emulator.",
    });

    assert.equal(decideCalled, 0, "/run should bypass chat.decide and force task path");
    assert.equal(taskCalls.length, 1);
    assert.equal(taskCalls[0].chatId, 980088419);
    assert.match(taskCalls[0].task, /Snake game app/i);
  });
});
