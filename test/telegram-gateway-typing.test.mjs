import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { TelegramGateway } = await import("../dist/gateway/telegram-gateway.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

test("TelegramGateway keeps typing heartbeat during async operation", async () => {
  await withTempHome("openpocket-telegram-typing-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});
    const calls = [];

    gateway.bot.sendChatAction = async (chatId, action) => {
      calls.push({ chatId, action, at: Date.now() });
      return true;
    };

    await gateway.withTypingStatus(123456, async () => {
      await sleep(135);
    });

    assert.equal(calls.length >= 3, true, "typing should be sent repeatedly during operation");
    assert.equal(calls.every((item) => item.chatId === 123456), true);
    assert.equal(calls.every((item) => item.action === "typing"), true);

    const doneCount = calls.length;
    await sleep(80);
    assert.equal(calls.length, doneCount, "typing heartbeat should stop after operation finishes");
  });
});

test("TelegramGateway formats human-auth escalation as HTML and strips redundant confirmation copy", async () => {
  await withTempHome("openpocket-telegram-human-auth-html-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const html = gateway.buildHumanAuthHtmlMessage(
      "Please open the authorization link now and approve or reject the request. Once you've done that, send a quick confirmation here. Security note: this auth page connects to your local OpenPocket relay.",
      "en",
      ["/auth approve req_123", "Web link is unavailable. Use manual commands:"],
    );

    assert.doesNotMatch(html, /send a quick confirmation/i);
    assert.match(html, /<b>Security note:<\/b>/);
    assert.match(html, /<code>\/auth approve req_123<\/code>/);
    assert.doesNotMatch(html, /Security note: this auth page connects/i);
  });
});

test("TelegramGateway typing heartbeat supports nested operations", async () => {
  await withTempHome("openpocket-telegram-typing-nested-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 25 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});
    const calls = [];

    gateway.bot.sendChatAction = async (chatId, action) => {
      calls.push({ chatId, action, at: Date.now() });
      return true;
    };

    await gateway.withTypingStatus(8899, async () => {
      await sleep(40);
      await gateway.withTypingStatus(8899, async () => {
        await sleep(60);
      });
      await sleep(40);
    });

    assert.equal(calls.length >= 3, true);

    const doneCount = calls.length;
    await sleep(70);
    assert.equal(calls.length, doneCount, "typing heartbeat should not leak after nested operations");
  });
});

test("TelegramGateway syncs bot display name after onboarding update", async () => {
  await withTempHome("openpocket-telegram-bot-name-sync-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const setNameCalls = [];
    const messageCalls = [];
    gateway.bot.setMyName = async (form) => {
      setNameCalls.push(form);
      return true;
    };
    gateway.bot.sendMessage = async (chatId, text) => {
      messageCalls.push({ chatId, text });
      return {};
    };

    await gateway.syncBotDisplayName(123, "Jarvis", "zh");
    await gateway.syncBotDisplayName(123, "Jarvis", "zh");

    assert.equal(setNameCalls.length, 1);
    assert.equal(setNameCalls[0].name, "Jarvis");
    assert.equal(messageCalls.length, 1);
    assert.match(messageCalls[0].text, /已同步 Telegram Bot 显示名/);
  });
});

test("TelegramGateway startup sync reads assistant name from IDENTITY.md", async () => {
  await withTempHome("openpocket-telegram-startup-name-sync-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";
    fs.writeFileSync(
      path.join(cfg.workspaceDir, "IDENTITY.md"),
      [
        "# IDENTITY",
        "",
        "## Agent Identity",
        "",
        "- Name: Jarvis-Startup",
      ].join("\n"),
      "utf-8",
    );

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const setNameCalls = [];
    gateway.bot.setMyName = async (form) => {
      setNameCalls.push(form);
      return true;
    };

    await gateway.syncBotDisplayNameFromIdentity();
    await gateway.syncBotDisplayNameFromIdentity();

    assert.equal(setNameCalls.length, 1);
    assert.equal(setNameCalls[0].name, "Jarvis-Startup");
  });
});

test("TelegramGateway startup sync backs off after Telegram rate limit", async () => {
  await withTempHome("openpocket-telegram-startup-name-rate-limit-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";
    fs.writeFileSync(
      path.join(cfg.workspaceDir, "IDENTITY.md"),
      [
        "# IDENTITY",
        "",
        "## Agent Identity",
        "",
        "- Name: RateLimit-Bot",
      ].join("\n"),
      "utf-8",
    );

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    let setNameCalls = 0;
    gateway.bot.setMyName = async () => {
      setNameCalls += 1;
      throw new Error("ETELEGRAM: 429 Too Many Requests: retry after 120");
    };

    await gateway.syncBotDisplayNameFromIdentity();
    await gateway.syncBotDisplayNameFromIdentity();

    assert.equal(setNameCalls, 1);
    const statePath = path.join(cfg.stateDir, "telegram-bot-name-sync.json");
    assert.equal(fs.existsSync(statePath), true);
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(typeof state.retryAfterUntilMs, "number");
    assert.equal(state.retryAfterUntilMs > Date.now(), true);
  });
});

test("TelegramGateway startup sync skips API call when name already cached locally", async () => {
  await withTempHome("openpocket-telegram-startup-name-cache-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";
    fs.writeFileSync(
      path.join(cfg.workspaceDir, "IDENTITY.md"),
      [
        "# IDENTITY",
        "",
        "## Agent Identity",
        "",
        "- Name: Cached-Bot",
      ].join("\n"),
      "utf-8",
    );

    const first = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    first.bot.on("polling_error", () => {});
    await first.bot.stopPolling().catch(() => {});
    let firstCalls = 0;
    first.bot.setMyName = async () => {
      firstCalls += 1;
      return true;
    };
    await first.syncBotDisplayNameFromIdentity();
    assert.equal(firstCalls, 1);

    const second = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    second.bot.on("polling_error", () => {});
    await second.bot.stopPolling().catch(() => {});
    let secondCalls = 0;
    second.bot.setMyName = async () => {
      secondCalls += 1;
      return true;
    };
    await second.syncBotDisplayNameFromIdentity();
    assert.equal(secondCalls, 0);
  });
});

test("TelegramGateway consumes profile-update payload after chat reply", async () => {
  await withTempHome("openpocket-telegram-profile-update-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const messageCalls = [];
    const setNameCalls = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      messageCalls.push({ chatId, text });
      return {};
    };
    gateway.bot.setMyName = async (form) => {
      setNameCalls.push(form);
      return true;
    };

    let consumed = false;
    gateway.chat.decide = async () => ({
      mode: "chat",
      task: "",
      reply: "已更新。我的名字改为“Jarvis-Phone”。",
      confidence: 1,
      reason: "profile_update",
    });
    gateway.chat.consumePendingProfileUpdate = () => {
      if (consumed) {
        return null;
      }
      consumed = true;
      return { assistantName: "Jarvis-Phone", locale: "zh" };
    };

    await gateway.consumeMessage({ chat: { id: 456 }, text: "你把名字改成 Jarvis-Phone 吧" });

    assert.equal(setNameCalls.length, 1);
    assert.equal(setNameCalls[0].name, "Jarvis-Phone");
    assert.equal(messageCalls.length, 2);
    assert.match(messageCalls[0].text, /已更新/);
    assert.match(messageCalls[1].text, /已同步 Telegram Bot 显示名/);
  });
});

test("TelegramGateway play-store preflight starts a direct check/login task", async () => {
  await withTempHome("openpocket-telegram-playstore-signed-in-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";
    cfg.humanAuth.enabled = true;

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.emulator.status = () => ({
      avdName: "OpenPocket_AVD",
      devices: ["emulator-5554"],
      bootedDevices: ["emulator-5554"],
    });
    gateway.emulator.runAdb = (args) => {
      if (args.includes("pm") && args.includes("com.android.vending")) {
        return "package:/system/app/Phonesky/Phonesky.apk";
      }
      return "";
    };

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    const tasks = [];
    gateway.runTaskAsync = async (_chatId, task) => {
      tasks.push(task);
    };

    const handled = await gateway.ensurePlayStoreReady(7301, "zh");
    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /系统 Google 账号登录状态/);
    assert.equal(tasks.length, 1);
    assert.match(tasks[0], /request_human_auth\(oauth\)/);

    const statePath = path.join(cfg.stateDir, "onboarding.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.playStoreDetected, true);
    assert.equal(state.gmailLoginConfirmedAt ?? null, null);
  });
});

test("TelegramGateway play-store preflight notifies once when emulator is not booted yet", async () => {
  await withTempHome("openpocket-telegram-playstore-no-booted-device-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.emulator.status = () => ({
      avdName: "OpenPocket_AVD",
      devices: [],
      bootedDevices: [],
    });

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    const handled1 = await gateway.ensurePlayStoreReady(7310, "zh");
    const handled2 = await gateway.ensurePlayStoreReady(7310, "zh");
    assert.equal(handled1, false);
    assert.equal(handled2, false);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /还没有检测到已启动的模拟器/);
  });
});

test("TelegramGateway play-store preflight re-checks device login even if onboarding state says gmail already confirmed", async () => {
  await withTempHome("openpocket-telegram-playstore-stale-gmail-state-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";
    cfg.humanAuth.enabled = true;
    fs.mkdirSync(cfg.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfg.stateDir, "onboarding.json"),
      `${JSON.stringify({
        updatedAt: new Date().toISOString(),
        gmailLoginConfirmedAt: "2026-02-01T00:00:00.000Z",
        playStoreDetected: true,
      }, null, 2)}\n`,
      "utf-8",
    );

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.emulator.status = () => ({
      avdName: "OpenPocket_AVD",
      devices: ["emulator-5554"],
      bootedDevices: ["emulator-5554"],
    });
    gateway.emulator.runAdb = (args) => {
      if (args.includes("pm") && args.includes("com.android.vending")) {
        return "package:/system/app/Phonesky/Phonesky.apk";
      }
      if (args.includes("dumpsys") && args.includes("account")) {
        return "Accounts: (none)";
      }
      return "";
    };

    const sent = [];
    const tasks = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.runTaskAsync = async (_chatId, task) => {
      tasks.push(task);
    };

    const handled = await gateway.ensurePlayStoreReady(7304, "zh");
    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /系统 Google 账号登录状态/);
    assert.equal(tasks.length, 1);
  });
});

test("TelegramGateway play-store preflight falls back to manual hint when humanAuth is disabled", async () => {
  await withTempHome("openpocket-telegram-playstore-manual-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";
    cfg.humanAuth.enabled = false;

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.emulator.status = () => ({
      avdName: "OpenPocket_AVD",
      devices: ["emulator-5554"],
      bootedDevices: ["emulator-5554"],
    });
    gateway.emulator.runAdb = (args) => {
      if (args.includes("pm") && args.includes("com.android.vending")) {
        return "package:/system/app/Phonesky/Phonesky.apk";
      }
      if (args.includes("dumpsys") && args.includes("account")) {
        return "Accounts: (none)";
      }
      return "";
    };

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    const handled = await gateway.ensurePlayStoreReady(7302, "zh");
    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /humanAuth 未启用/);

    const statePath = path.join(cfg.stateDir, "onboarding.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.playStoreDetected, true);
    assert.equal(state.gmailLoginConfirmedAt ?? null, null);
  });
});

test("TelegramGateway /start keeps onboarding prompt path when onboarding is still pending", async () => {
  await withTempHome("openpocket-telegram-start-onboarding-first-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    let onboardingDecideCalled = false;
    gateway.chat.isOnboardingPending = () => true;
    gateway.chat.decide = async () => {
      onboardingDecideCalled = true;
      return {
        mode: "chat",
        task: "",
        reply: "onboarding prompt first",
        confidence: 1,
        reason: "profile_onboarding",
      };
    };

    await gateway.consumeMessage({
      chat: { id: 7305 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "/start",
    });

    assert.equal(onboardingDecideCalled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /onboarding prompt first/);
  });
});

test("TelegramGateway play-store preflight can trigger remote login task", async () => {
  await withTempHome("openpocket-telegram-playstore-remote-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";
    cfg.humanAuth.enabled = true;

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.emulator.status = () => ({
      avdName: "OpenPocket_AVD",
      devices: ["emulator-5554"],
      bootedDevices: ["emulator-5554"],
    });
    gateway.emulator.runAdb = (args) => {
      if (args.includes("pm") && args.includes("com.android.vending")) {
        return "package:/system/app/Phonesky/Phonesky.apk";
      }
      if (args.includes("dumpsys") && args.includes("account")) {
        return "Accounts: (none)";
      }
      return "";
    };

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    const tasks = [];
    gateway.runTaskAsync = async (_chatId, task) => {
      tasks.push(task);
    };

    const handled = await gateway.ensurePlayStoreReady(7303, "zh");
    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /系统 Google 账号登录状态/);
    assert.equal(tasks.length, 1);
    assert.match(tasks[0], /request_human_auth\(oauth\)/);
  });
});

test("TelegramGateway triggers play-store preflight after onboarding is completed in chat", async () => {
  await withTempHome("openpocket-telegram-onboarding-complete-preflight-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    let pending = true;
    gateway.chat.isOnboardingPending = () => pending;
    gateway.chat.decide = async () => {
      pending = false;
      return {
        mode: "chat",
        task: "",
        reply: "onboarding done",
        confidence: 1,
        reason: "profile_onboarding",
      };
    };
    gateway.chat.consumePendingProfileUpdate = () => null;

    let preflightCalls = 0;
    gateway.ensurePlayStoreReady = async () => {
      preflightCalls += 1;
      return false;
    };

    await gateway.consumeMessage({
      chat: { id: 7306 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "Warm & supportive",
    });

    assert.equal(preflightCalls, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /onboarding done/);
  });
});

test("TelegramGateway onboarding completion directly triggers play-store check task", async () => {
  await withTempHome("openpocket-telegram-onboarding-complete-direct-task-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";
    cfg.humanAuth.enabled = true;

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    gateway.emulator.status = () => ({
      avdName: "OpenPocket_AVD",
      devices: ["emulator-5554"],
      bootedDevices: ["emulator-5554"],
    });
    gateway.emulator.runAdb = (args) => {
      if (args.includes("pm") && args.includes("com.android.vending")) {
        return "package:/system/app/Phonesky/Phonesky.apk";
      }
      if (args.includes("dumpsys") && args.includes("account")) {
        return "Accounts: (none)";
      }
      return "";
    };

    let pending = true;
    gateway.chat.isOnboardingPending = () => pending;
    gateway.chat.decide = async () => {
      pending = false;
      return {
        mode: "chat",
        task: "",
        reply: "Perfect, Sergio — noted. Onboarding is complete.",
        confidence: 1,
        reason: "profile_onboarding",
      };
    };
    gateway.chat.consumePendingProfileUpdate = () => null;

    const tasks = [];
    gateway.runTaskAsync = async (_chatId, task) => {
      tasks.push(task);
      return true;
    };

    await gateway.consumeMessage({
      chat: { id: 7312 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "Professional & reliable",
    });

    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /Onboarding is complete/i);
    assert.match(sent[1].text, /Checking system Google account sign-in now/i);
    assert.equal(tasks.length, 1);
    assert.match(tasks[0], /request_human_auth\(oauth\)/);
  });
});

test("TelegramGateway triggers play-store preflight before task when onboarding completes on a task-like message", async () => {
  await withTempHome("openpocket-telegram-onboarding-task-preflight-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    let pending = true;
    gateway.chat.isOnboardingPending = () => pending;
    gateway.chat.decide = async () => {
      pending = false;
      return {
        mode: "task",
        task: "Download X and pin it",
        reply: "",
        confidence: 0.95,
        reason: "task_after_onboarding",
      };
    };

    let preflightCalls = 0;
    gateway.ensurePlayStoreReady = async () => {
      preflightCalls += 1;
      return true;
    };

    let taskCalls = 0;
    gateway.runTaskAsync = async () => {
      taskCalls += 1;
    };

    await gateway.consumeMessage({
      chat: { id: 7307 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "Can you download X and pin it?",
    });

    assert.equal(preflightCalls, 1);
    assert.equal(taskCalls, 0);
  });
});

test("TelegramGateway continues task when task-mode preflight returns false", async () => {
  await withTempHome("openpocket-telegram-task-preflight-pass-through-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.chat.isOnboardingPending = () => false;
    gateway.chat.decide = async () => ({
      mode: "task",
      task: "Check weather in San Francisco",
      reply: "",
      confidence: 0.92,
      reason: "task",
    });

    let preflightCalls = 0;
    gateway.ensurePlayStoreReady = async () => {
      preflightCalls += 1;
      return false;
    };

    let runTaskPayload = "";
    gateway.runTaskAsync = async (_chatId, task) => {
      runTaskPayload = task;
    };

    await gateway.consumeMessage({
      chat: { id: 7308 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "weather sf",
    });

    assert.equal(preflightCalls, 1);
    assert.equal(runTaskPayload, "Check weather in San Francisco");
  });
});

test("TelegramGateway /run checks play-store preflight before executing forced task", async () => {
  await withTempHome("openpocket-telegram-run-command-preflight-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    let preflightCalls = 0;
    gateway.ensurePlayStoreReady = async () => {
      preflightCalls += 1;
      return true;
    };

    let taskCalls = 0;
    gateway.runTaskAsync = async () => {
      taskCalls += 1;
    };

    await gateway.consumeMessage({
      chat: { id: 7309 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "/run install spotify",
    });

    assert.equal(preflightCalls, 1);
    assert.equal(taskCalls, 0);
  });
});

test("TelegramGateway retries play-store preflight on normal messages after onboarding is already completed", async () => {
  await withTempHome("openpocket-telegram-post-onboarding-chat-preflight-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.chat.isOnboardingPending = () => false;

    let preflightCalls = 0;
    gateway.ensurePlayStoreReady = async () => {
      preflightCalls += 1;
      return true;
    };

    let decideCalled = false;
    gateway.chat.decide = async () => {
      decideCalled = true;
      return {
        mode: "chat",
        task: "",
        reply: "should not reach",
        confidence: 1,
        reason: "noop",
      };
    };

    await gateway.consumeMessage({
      chat: { id: 7311 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "hi there",
    });

    assert.equal(preflightCalls, 1);
    assert.equal(decideCalled, false);
  });
});

test("TelegramGateway resolves pending 2FA request from plain numeric text", async () => {
  await withTempHome("openpocket-telegram-otp-inline-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    let resolved = null;
    gateway.humanAuth.listPending = () => [
      {
        requestId: "auth-otp-1",
        chatId: 9001,
        task: "OTP flow",
        capability: "2fa",
        currentApp: "com.example",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        relayEnabled: true,
      },
    ];
    gateway.humanAuth.resolvePending = (requestId, approved, note, actor) => {
      resolved = { requestId, approved, note, actor };
      return true;
    };

    let decideCalled = false;
    gateway.chat.decide = async () => {
      decideCalled = true;
      return {
        mode: "chat",
        task: "",
        reply: "fallback",
        confidence: 1,
        reason: "fallback",
      };
    };

    await gateway.consumeMessage({
      chat: { id: 9001 },
      text: "123456",
    });

    assert.deepEqual(
      resolved,
      {
        requestId: "auth-otp-1",
        approved: true,
        note: "123456",
        actor: "chat:9001:otp-inline",
      },
    );
    assert.equal(decideCalled, false);
    assert.equal(sent.length >= 1, true);
    assert.match(sent[0].text, /Received code/i);
  });
});

test("TelegramGateway resolves pending user-input request from plain text", async () => {
  await withTempHome("openpocket-telegram-user-input-inline-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.agent.captureManualScreenshot = async () => "";
    gateway.chat.narrateEscalation = async () => "Please share the requested value.";

    let decideCalled = false;
    gateway.chat.decide = async () => {
      decideCalled = true;
      return {
        mode: "chat",
        task: "",
        reply: "fallback",
        confidence: 1,
        reason: "fallback",
      };
    };

    const pendingPromise = gateway.requestUserInputFromChat(9002, {
      sessionId: "sess-1",
      sessionPath: "/tmp/session-1.md",
      task: "PayByPhone parking flow",
      step: 3,
      question: "Please provide your vehicle plate number.",
      placeholder: "ABC-1234",
      timeoutSec: 90,
      currentApp: "com.paybyphone",
      screenshotPath: null,
    });

    await gateway.consumeMessage({
      chat: { id: 9002 },
      text: "CA-7XZ019",
    });

    const resolved = await pendingPromise;
    assert.equal(resolved.text, "CA-7XZ019");
    assert.equal(decideCalled, false);
    assert.equal(sent.length >= 2, true);
    assert.equal(sent.some((item) => /Got it/i.test(item.text)), true);
  });
});

test("TelegramGateway captures non-sensitive context key-values from plain chat and acknowledges without routing", async () => {
  await withTempHome("openpocket-telegram-profile-capture-inline-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.chat.isOnboardingPending = () => false;

    let decideCalled = false;
    gateway.chat.decide = async () => {
      decideCalled = true;
      return {
        mode: "chat",
        task: "",
        reply: "fallback",
        confidence: 1,
        reason: "fallback",
      };
    };

    await gateway.consumeMessage({
      chat: { id: 9301 },
      from: { id: 1, is_bot: false, language_code: "zh-CN", first_name: "Tester" },
      text: "vehicle_plate: CA-7XZ019, spot_code: 15800",
    });

    assert.equal(decideCalled, false);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /已记录/);
  });
});

test("TelegramGateway injects captured non-sensitive context into subsequent task execution", async () => {
  await withTempHome("openpocket-telegram-profile-inject-task-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.bot.sendMessage = async () => ({});
    gateway.bot.sendChatAction = async () => true;
    gateway.chat.narrateTaskOutcome = async () => "done";
    gateway.chat.isOnboardingPending = () => false;

    await gateway.consumeMessage({
      chat: { id: 9302 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "vehicle_plate: CA-7XZ019, spot_code: 15800",
    });

    let executedTask = "";
    gateway.agent.runTask = async (task) => {
      executedTask = task;
      return {
        ok: true,
        message: "done",
        sessionPath: "/tmp/session-9302.jsonl",
      };
    };

    const result = await gateway.runTaskAndReport({
      chatId: 9302,
      task: "Open PayByPhone and start parking session.",
      source: "chat",
      modelName: null,
      sessionKey: "telegram:chat:9302",
    });

    assert.equal(result.ok, true);
    assert.match(executedTask, /vehicle_plate=CA-7XZ019/);
    assert.match(executedTask, /spot_code=15800/);
  });
});

test("TelegramGateway reuses request_user_input response in subsequent task execution context", async () => {
  await withTempHome("openpocket-telegram-profile-from-user-input-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.bot.sendMessage = async () => ({});
    gateway.bot.sendChatAction = async () => true;
    gateway.agent.captureManualScreenshot = async () => "";
    gateway.chat.narrateEscalation = async () => "Please share the requested value.";
    gateway.chat.narrateTaskOutcome = async () => "done";

    const pendingPromise = gateway.requestUserInputFromChat(9303, {
      sessionId: "sess-profile",
      sessionPath: "/tmp/sess-profile.jsonl",
      task: "PayByPhone parking flow",
      step: 4,
      question: "Please provide your vehicle plate number.",
      placeholder: "ABC-1234",
      timeoutSec: 90,
      currentApp: "com.paybyphone",
      screenshotPath: null,
    });

    await gateway.consumeMessage({
      chat: { id: 9303 },
      text: "CA-7XZ019",
    });

    const resolved = await pendingPromise;
    assert.equal(resolved.text, "CA-7XZ019");

    let executedTask = "";
    gateway.agent.runTask = async (task) => {
      executedTask = task;
      return {
        ok: true,
        message: "done",
        sessionPath: "/tmp/session-9303.jsonl",
      };
    };

    const result = await gateway.runTaskAndReport({
      chatId: 9303,
      task: "Open PayByPhone and continue parking flow.",
      source: "chat",
      modelName: null,
      sessionKey: "telegram:chat:9303",
    });

    assert.equal(result.ok, true);
    assert.match(executedTask, /=CA-7XZ019/);
  });
});

test("TelegramGateway does not persist sensitive user-input values into task context", async () => {
  await withTempHome("openpocket-telegram-sensitive-context-guard-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    gateway.bot.sendMessage = async () => ({});
    gateway.bot.sendChatAction = async () => true;
    gateway.agent.captureManualScreenshot = async () => "";
    gateway.chat.narrateEscalation = async () => "Please share the requested value.";
    gateway.chat.narrateTaskOutcome = async () => "done";

    const pendingPromise = gateway.requestUserInputFromChat(9304, {
      sessionId: "sess-sensitive",
      sessionPath: "/tmp/sess-sensitive.jsonl",
      task: "Sensitive flow",
      step: 2,
      question: "Please provide your account password.",
      placeholder: "your password",
      timeoutSec: 90,
      currentApp: "com.example",
      screenshotPath: null,
    });

    await gateway.consumeMessage({
      chat: { id: 9304 },
      text: "secret-pass-123",
    });
    await pendingPromise;

    let executedTask = "";
    gateway.agent.runTask = async (task) => {
      executedTask = task;
      return {
        ok: true,
        message: "done",
        sessionPath: "/tmp/session-9304.jsonl",
      };
    };

    const result = await gateway.runTaskAndReport({
      chatId: 9304,
      task: "Continue flow.",
      source: "chat",
      modelName: null,
      sessionKey: "telegram:chat:9304",
    });

    assert.equal(result.ok, true);
    assert.doesNotMatch(executedTask, /secret-pass-123/);
  });
});

test("TelegramGateway /start triggers onboarding reply when onboarding is pending", async () => {
  await withTempHome("openpocket-telegram-start-onboarding-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    let decideInput = "";
    gateway.chat.isOnboardingPending = () => true;
    gateway.chat.decide = async (_chatId, inputText) => {
      decideInput = inputText;
      return {
        mode: "chat",
        task: "",
        reply: "先做个简短初始化：我该怎么称呼你？",
        confidence: 1,
        reason: "profile_onboarding",
      };
    };

    let taskStarted = false;
    gateway.runTaskAsync = async () => {
      taskStarted = true;
    };

    await gateway.consumeMessage({
      chat: { id: 9101 },
      from: { id: 1, is_bot: false, language_code: "zh-CN", first_name: "Tester" },
      text: "/start",
    });

    assert.equal(decideInput, "你好");
    assert.equal(taskStarted, false);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /简短初始化/);
  });
});

test("TelegramGateway /start replies with stable welcome when onboarding is completed", async () => {
  await withTempHome("openpocket-telegram-start-ready-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    let decideCalled = false;
    gateway.chat.isOnboardingPending = () => false;
    let preflightCalls = 0;
    gateway.ensurePlayStoreReady = async () => {
      preflightCalls += 1;
      return false;
    };
    let startReplyCalled = false;
    gateway.chat.startReadyReply = async (locale) => {
      startReplyCalled = true;
      assert.equal(locale, "en");
      return "Welcome back. Send your phone task directly, or use /help for commands.";
    };
    gateway.chat.decide = async () => {
      decideCalled = true;
      return {
        mode: "chat",
        task: "",
        reply: "",
        confidence: 1,
        reason: "noop",
      };
    };

    await gateway.consumeMessage({
      chat: { id: 9102 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "/start",
    });

    assert.equal(decideCalled, false);
    assert.equal(preflightCalls, 1);
    assert.equal(startReplyCalled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Welcome back/);
  });
});

test("TelegramGateway /reset sends user-facing fresh-session reply when onboarding is completed", async () => {
  await withTempHome("openpocket-telegram-reset-startup-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.chat.isOnboardingPending = () => false;
    gateway.chat.sessionResetUserReply = async () => "Session reset complete. Send your next task.";
    gateway.agent.stopCurrentTask = () => false;

    await gateway.consumeMessage({
      chat: { id: 9103 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "/reset",
    });

    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /Conversation memory cleared/);
    assert.match(sent[1].text, /Session reset complete/);
  });
});

test("TelegramGateway /reset routes into onboarding when onboarding is pending", async () => {
  await withTempHome("openpocket-telegram-reset-onboarding-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    gateway.chat.isOnboardingPending = () => true;
    gateway.chat.decide = async () => ({
      mode: "chat",
      task: "",
      reply: "先做个简短初始化：我该怎么称呼你？",
      confidence: 1,
      reason: "profile_onboarding",
    });
    gateway.agent.stopCurrentTask = () => false;

    await gateway.consumeMessage({
      chat: { id: 9104 },
      from: { id: 1, is_bot: false, language_code: "zh-CN", first_name: "Tester" },
      text: "/reset",
    });

    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /Conversation memory cleared/);
    assert.match(sent[1].text, /简短初始化/);
  });
});

test("TelegramGateway /new clears chat memory and keeps using the same chat session key", async () => {
  await withTempHome("openpocket-telegram-new-session-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    const clearCalls = [];
    gateway.chat.clear = (chatId) => {
      clearCalls.push(chatId);
    };
    gateway.chat.isOnboardingPending = () => false;
    gateway.ensurePlayStoreReady = async () => false;
    gateway.chat.sessionResetUserReply = async () => "Session reset complete. Send your next task.";

    const runCalls = [];
    gateway.runTaskAndReport = async (params) => {
      runCalls.push(params);
      return {
        accepted: true,
        ok: true,
        message: "ok",
      };
    };
    const resetCalls = [];
    gateway.agent.resetSession = (sessionKey) => {
      resetCalls.push(sessionKey);
      return {
        sessionId: "new-session-9208",
        sessionPath: "/tmp/new-session-9208.jsonl",
      };
    };
    gateway.agent.isBusy = () => false;

    await gateway.consumeMessage({
      chat: { id: 9208 },
      text: "/run first task",
    });
    await sleep(0);

    await gateway.consumeMessage({
      chat: { id: 9208 },
      text: "/new",
    });

    await gateway.consumeMessage({
      chat: { id: 9208 },
      text: "/run second task",
    });
    await sleep(0);

    assert.equal(clearCalls.length, 1);
    assert.equal(clearCalls[0], 9208);
    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[0].sessionKey, "telegram:chat:9208");
    assert.equal(runCalls[1].sessionKey, "telegram:chat:9208");
    assert.equal(resetCalls.length, 1);
    assert.equal(resetCalls[0], "telegram:chat:9208");
    assert.equal(sent.some((item) => /New session started/i.test(item.text)), true);
    assert.equal(sent.some((item) => /Session reset complete/i.test(item.text)), true);
  });
});

test("TelegramGateway /new <task> starts a new session and runs the provided task immediately", async () => {
  await withTempHome("openpocket-telegram-new-session-inline-task-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };

    const clearCalls = [];
    gateway.chat.clear = (chatId) => {
      clearCalls.push(chatId);
    };
    gateway.chat.isOnboardingPending = () => false;
    gateway.ensurePlayStoreReady = async () => false;

    const runCalls = [];
    gateway.runTaskAndReport = async (params) => {
      runCalls.push(params);
      return {
        accepted: true,
        ok: true,
        message: "ok",
      };
    };
    const resetCalls = [];
    gateway.agent.resetSession = (sessionKey) => {
      resetCalls.push(sessionKey);
      return {
        sessionId: "new-session-9209",
        sessionPath: "/tmp/new-session-9209.jsonl",
      };
    };
    gateway.agent.isBusy = () => false;

    await gateway.consumeMessage({
      chat: { id: 9209 },
      text: "/new second task",
    });
    await sleep(0);

    await gateway.consumeMessage({
      chat: { id: 9209 },
      text: "/run third task",
    });
    await sleep(0);

    assert.equal(clearCalls.length, 1);
    assert.equal(clearCalls[0], 9209);
    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[0].task, "second task");
    assert.equal(runCalls[0].sessionKey, "telegram:chat:9209");
    assert.equal(runCalls[1].task, "third task");
    assert.equal(runCalls[1].sessionKey, "telegram:chat:9209");
    assert.equal(resetCalls.length, 1);
    assert.equal(resetCalls[0], "telegram:chat:9209");
    assert.equal(sent.some((item) => /New session started/i.test(item.text)), true);
  });
});

test("TelegramGateway /new sends user-facing fresh-session reply when onboarding is completed", async () => {
  await withTempHome("openpocket-telegram-new-startup-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.chat.isOnboardingPending = () => false;
    gateway.chat.sessionResetUserReply = async () => "Session reset complete. Send your next task.";
    gateway.agent.stopCurrentTask = () => false;
    gateway.agent.resetSession = () => ({
      sessionId: "new-session-9210",
      sessionPath: "/tmp/new-session-9210.jsonl",
    });

    await gateway.consumeMessage({
      chat: { id: 9210 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "/new",
    });

    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /New session started/);
    assert.match(sent[1].text, /Session reset complete/);
  });
});

test("TelegramGateway /new resets session without forcing stopCurrentTask", async () => {
  await withTempHome("openpocket-telegram-new-no-force-stop-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.chat.isOnboardingPending = () => false;
    gateway.chat.sessionResetUserReply = async () => "Session reset complete. Send your next task.";

    let stopCalls = 0;
    gateway.agent.stopCurrentTask = () => {
      stopCalls += 1;
      return false;
    };
    gateway.agent.resetSession = () => ({
      sessionId: "new-session-9212",
      sessionPath: "/tmp/new-session-9212.jsonl",
    });

    await gateway.consumeMessage({
      chat: { id: 9212 },
      from: { id: 1, is_bot: false, language_code: "en", first_name: "Tester" },
      text: "/new",
    });

    assert.equal(stopCalls, 0, "/new should not force-stop the running task");
    assert.equal(sent.some((item) => /New session started/.test(item.text)), true);
    assert.equal(sent.some((item) => /still shutting down/i.test(item.text)), false);
  });
});

test("TelegramGateway queues follow-up /run task while busy and drains after current task completes", async () => {
  await withTempHome("openpocket-telegram-run-queue-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.bot.sendChatAction = async () => true;

    let busy = false;
    let resolveFirst = () => {};
    const firstTaskDone = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const runCalls = [];
    gateway.agent.isBusy = () => busy;
    gateway.ensurePlayStoreReady = async () => false;
    gateway.runTaskAndReport = async (params) => {
      runCalls.push(params);
      if (params.task === "first task") {
        busy = true;
        await firstTaskDone;
        busy = false;
      }
      return {
        accepted: true,
        ok: true,
        message: "ok",
      };
    };

    await gateway.consumeMessage({
      chat: { id: 9211 },
      text: "/run first task",
    });
    await sleep(0);

    await gateway.consumeMessage({
      chat: { id: 9211 },
      text: "/run second task",
    });
    await sleep(0);

    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].task, "first task");
    assert.equal(sent.some((item) => /On it:/i.test(item.text)), true);
    assert.equal(
      sent.some((item) => /queued/i.test(item.text)),
      true,
      "second task should be acknowledged as queued instead of rejected",
    );

    resolveFirst();
    await sleep(0);
    await sleep(0);

    assert.equal(runCalls.length, 2);
    assert.equal(runCalls[1].task, "second task");
    assert.equal(runCalls[1].sessionKey, "telegram:chat:9211");
  });
});

test("TelegramGateway /context returns summary report", async () => {
  await withTempHome("openpocket-telegram-context-summary-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.agent.getWorkspacePromptContextReport = () => ({
      maxCharsPerFile: 20000,
      maxCharsTotal: 150000,
      totalIncludedChars: 1024,
      hookApplied: false,
      source: "estimate",
      generatedAt: new Date().toISOString(),
      promptMode: "full",
      systemPrompt: {
        chars: 4096,
        workspaceContextChars: 1024,
        nonWorkspaceChars: 3072,
      },
      skills: {
        promptChars: 300,
        entries: [],
      },
      tools: {
        listChars: 500,
        schemaChars: 700,
        entries: [],
      },
      files: [
        {
          fileName: "AGENTS.md",
          originalChars: 500,
          includedChars: 500,
          truncated: false,
          included: true,
          missing: false,
          snippet: "test",
        },
      ],
    });

    await gateway.consumeMessage({
      chat: { id: 9105 },
      text: "/context",
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Context breakdown/);
    assert.match(sent[0].text, /AGENTS\.md/);
  });
});

test("TelegramGateway /context detail returns file snippet", async () => {
  await withTempHome("openpocket-telegram-context-detail-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.agent.getWorkspacePromptContextReport = () => ({
      maxCharsPerFile: 20000,
      maxCharsTotal: 150000,
      totalIncludedChars: 2048,
      hookApplied: true,
      source: "run",
      generatedAt: new Date().toISOString(),
      promptMode: "full",
      systemPrompt: {
        chars: 5000,
        workspaceContextChars: 2048,
        nonWorkspaceChars: 2952,
      },
      skills: {
        promptChars: 420,
        entries: [],
      },
      tools: {
        listChars: 640,
        schemaChars: 860,
        entries: [],
      },
      files: [
        {
          fileName: "SOUL.md",
          originalChars: 1000,
          includedChars: 900,
          truncated: true,
          included: true,
          missing: false,
          snippet: "soul-snippet-body",
        },
      ],
    });

    await gateway.consumeMessage({
      chat: { id: 9106 },
      text: "/context detail SOUL.md",
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /SOUL\.md/);
    assert.match(sent[0].text, /soul-snippet-body/);
  });
});

test("TelegramGateway /context json returns machine-readable report", async () => {
  await withTempHome("openpocket-telegram-context-json-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.agent.getWorkspacePromptContextReport = () => ({
      maxCharsPerFile: 20000,
      maxCharsTotal: 150000,
      totalIncludedChars: 1280,
      hookApplied: false,
      source: "estimate",
      generatedAt: new Date().toISOString(),
      promptMode: "full",
      systemPrompt: {
        chars: 4600,
        workspaceContextChars: 1280,
        nonWorkspaceChars: 3320,
      },
      skills: {
        promptChars: 320,
        entries: [],
      },
      tools: {
        listChars: 590,
        schemaChars: 810,
        entries: [],
      },
      files: [
        {
          fileName: "AGENTS.md",
          originalChars: 400,
          includedChars: 400,
          truncated: false,
          included: true,
          missing: false,
          snippet: "agents-snippet",
        },
      ],
    });

    await gateway.consumeMessage({
      chat: { id: 9107 },
      text: "/context json",
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /"promptMode": "full"/);
    assert.match(sent[0].text, /"systemPrompt"/);
  });
});

test("TelegramGateway narrates progress only when model marks meaningful updates", async () => {
  await withTempHome("openpocket-telegram-progress-narration-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.bot.sendChatAction = async () => true;

    // Sparse narration: step 1 is high-signal (first step) so LLM is called.
    // Steps 2 and 3 are low-signal (wait) and below the interval threshold,
    // so they use the fallback path which skips notification for "wait" actions.
    // Step 4 (tap) also uses fallback — tap IS high-signal in fallback rules but
    // not in the sparse LLM check, so it uses fallback and notifies.
    const llmDecisions = [
      { notify: true, message: "进度：已打开 Gmail 首页。", reason: "screen_transition" },
    ];
    let llmIndex = 0;
    gateway.chat.narrateTaskProgress = async () => {
      const decision = llmDecisions[llmIndex] ?? { notify: false, message: "", reason: "exhausted" };
      llmIndex += 1;
      return decision;
    };
    // Fallback for non-LLM steps: skip wait actions, notify for launch_app/tap.
    gateway.chat.fallbackTaskProgressNarration = (input) => {
      const action = String(input.progress.actionType || "").toLowerCase();
      if (action === "wait") {
        return { notify: false, message: "", reason: "fallback_skip" };
      }
      return {
        notify: true,
        message: `已做了 ${input.progress.actionType}`,
        reason: "fallback_notify",
      };
    };
    gateway.chat.narrateTaskOutcome = async () => "收件箱已打开，当前可见最新邮件列表。";

    gateway.agent.runTask = async (_task, _modelName, onProgress) => {
      await onProgress({
        step: 1,
        maxSteps: 5,
        currentApp: "com.google.android.gm",
        actionType: "launch_app",
        message: "Opened app",
        thought: "go to inbox",
        screenshotPath: null,
      });
      await onProgress({
        step: 2,
        maxSteps: 5,
        currentApp: "com.google.android.gm",
        actionType: "wait",
        message: "wait",
        thought: "waiting",
        screenshotPath: null,
      });
      await onProgress({
        step: 3,
        maxSteps: 5,
        currentApp: "com.google.android.gm",
        actionType: "wait",
        message: "wait",
        thought: "still waiting",
        screenshotPath: null,
      });
      await onProgress({
        step: 4,
        maxSteps: 5,
        currentApp: "com.google.android.gm",
        actionType: "tap",
        message: "Tapped inbox",
        thought: "open inbox",
        screenshotPath: null,
      });
      return {
        ok: true,
        message: "Inbox ready",
        sessionPath: "/tmp/session-test.md",
      };
    };

    const result = await gateway.runTaskAndReport({
      chatId: 9201,
      task: "打开 Gmail 并进入收件箱",
      source: "chat",
      modelName: null,
    });

    assert.equal(result.ok, true);
    // LLM was only called once (step 1 = high signal).
    assert.equal(llmIndex, 1);
    // 3 messages: step 1 LLM narration + step 4 fallback narration + final outcome.
    assert.equal(sent.length, 3);
    assert.equal(sent[0].chatId, 9201);
    assert.match(sent[0].text, /Gmail/);
    assert.equal(sent[2].text, "收件箱已打开，当前可见最新邮件列表。");
    assert.equal(sent.slice(0, 2).some((item) => /\d+\/\d+/.test(item.text)), false);
    assert.equal(
      sent.slice(0, 2).some((item) => /Current screen app:|Reasoning:|Action:/.test(item.text)),
      false,
      "legacy fixed progress template should not appear",
    );
  });
});

test("TelegramGateway suppresses low-signal repetitive narration even if model requests notify", async () => {
  await withTempHome("openpocket-telegram-progress-suppress-", async () => {
    const cfg = loadConfig();
    cfg.telegram.botToken = "test-bot-token";

    const gateway = new TelegramGateway(cfg, { typingIntervalMs: 30 });
    gateway.bot.on("polling_error", () => {});
    await gateway.bot.stopPolling().catch(() => {});

    const sent = [];
    gateway.bot.sendMessage = async (chatId, text) => {
      sent.push({ chatId, text });
      return {};
    };
    gateway.bot.sendChatAction = async () => true;

    // Sparse narration: none of these steps are step=1 or error steps, so
    // only steps that hit the interval threshold (skippedSteps >= 8) will
    // call the LLM. Others use fallback, which suppresses wait/launch at
    // low step gaps.
    const llmDecisions = [
      { notify: true, message: "Inbox is visible now.", reason: "checkpoint" },
    ];
    let llmIndex = 0;
    gateway.chat.narrateTaskProgress = async () => {
      const decision = llmDecisions[llmIndex] ?? { notify: false, message: "", reason: "exhausted" };
      llmIndex += 1;
      return decision;
    };
    // Fallback: suppress wait/launch_app at low step gaps to reduce noise.
    gateway.chat.fallbackTaskProgressNarration = (input) => {
      const action = String(input.progress.actionType || "").toLowerCase();
      if (action === "wait" || action === "launch_app") {
        return { notify: false, message: "", reason: "fallback_skip" };
      }
      return {
        notify: true,
        message: `Still on ${input.progress.currentApp}, just ran ${input.progress.actionType}`,
        reason: "fallback_notify",
      };
    };
    gateway.chat.narrateTaskOutcome = async () => "Inbox is visible with latest messages.";

    gateway.agent.runTask = async (_task, _modelName, onProgress) => {
      await onProgress({
        step: 6,
        maxSteps: 50,
        currentApp: "com.google.android.gm",
        actionType: "launch_app",
        message: "Opened Gmail and waiting",
        thought: "loading",
        screenshotPath: null,
      });
      await onProgress({
        step: 8,
        maxSteps: 50,
        currentApp: "com.google.android.gm",
        actionType: "wait",
        message: "still loading",
        thought: "retrying",
        screenshotPath: null,
      });
      await onProgress({
        step: 10,
        maxSteps: 50,
        currentApp: "com.google.android.gm",
        actionType: "wait",
        message: "still loading",
        thought: "retrying",
        screenshotPath: null,
      });
      // Step 15 uses fallback (tap, gets notify), but the LLM would be
      // called at this point since skippedSteps accumulated past interval.
      await onProgress({
        step: 15,
        maxSteps: 50,
        currentApp: "com.google.android.gm",
        actionType: "tap",
        message: "opened inbox",
        thought: "inbox visible",
        screenshotPath: null,
      });
      return {
        ok: true,
        message: "Inbox ready",
        sessionPath: "/tmp/session-test-2.md",
      };
    };

    const result = await gateway.runTaskAndReport({
      chatId: 9301,
      task: "Check Gmail inbox",
      source: "chat",
      modelName: null,
    });

    assert.equal(result.ok, true);
    // Steps 6,8,10 used fallback (suppressed), step 15 used fallback (tap=notify).
    // Only the tap step and outcome are sent to user.
    assert.ok(sent.length >= 2, `expected at least 2 messages, got ${sent.length}`);
    // Last message is always the outcome.
    assert.equal(sent[sent.length - 1].text, "Inbox is visible with latest messages.");
    // No step counter telemetry in user-facing messages.
    for (const item of sent.slice(0, -1)) {
      assert.doesNotMatch(item.text, /\d+\/\d+/);
    }
  });
});
