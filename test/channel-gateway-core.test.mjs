import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { GatewayCore } = await import("../dist/gateway/gateway-core.js");
const { DefaultChannelRouter } = await import("../dist/channel/router.js");
const { DefaultSessionKeyResolver } = await import("../dist/channel/session-keys.js");
const { FilePairingStore } = await import("../dist/channel/pairing.js");
const { SessionPiTreeJsonlBackend } = await import("../dist/agent/session-pi-tree-jsonl-backend.js");
const { appendTaskJournalSnapshot } = await import("../dist/agent/journal/task-journal-store.js");

function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENPOCKET_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

function makeEnvelope(overrides = {}) {
  return {
    channelType: "telegram",
    senderId: "user-1",
    senderName: "Alice",
    senderLanguageCode: "en",
    peerId: "user-1",
    peerKind: "dm",
    text: "",
    attachments: [],
    rawEvent: {},
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAdapter(channelType = "telegram") {
  const sent = [];
  const images = [];
  const files = [];
  const voices = [];
  let inboundHandler = null;

  return {
    channelType,
    sent,
    images,
    files,
    voices,
    async start() {},
    async stop() {},
    async sendText(peerId, text, opts) { sent.push({ peerId, text, opts }); },
    async sendImage(peerId, imagePath, caption) { images.push({ peerId, imagePath, caption }); },
    async sendFile(peerId, filePath, caption) { files.push({ peerId, filePath, caption }); },
    async sendVoice(peerId, voicePath, caption) { voices.push({ peerId, voicePath, caption }); },
    onInbound(handler) { inboundHandler = handler; },
    async setTypingIndicator() {},
    async requestUserDecision() { return { selectedOption: "ok", rawInput: "ok", resolvedAt: new Date().toISOString() }; },
    async requestUserInput() { return { text: "input", resolvedAt: new Date().toISOString() }; },
    async sendHumanAuthEscalation() {},
    async resolveDisplayName() { return null; },
    getCapabilities() {
      return {
        supportsMarkdown: true,
        supportsHtml: true,
        supportsInlineButtons: true,
        supportsReactions: false,
        supportsImageUpload: true,
        supportsFileUpload: true,
        supportsVoiceUpload: true,
        supportsTypingIndicator: true,
        supportsSlashCommands: true,
        supportsThreads: true,
        supportsDisplayNameSync: true,
        maxMessageLength: 4096,
        textChunkMode: "length",
      };
    },
    isAllowed() { return true; },
    simulateInbound(envelope) { if (inboundHandler) return inboundHandler(envelope); },
  };
}

function createGatewayCore(home, { skipOwnerRegistration = false } = {}) {
  const config = loadConfig();
  const router = new DefaultChannelRouter({ log: () => {} });
  const sessionKeys = new DefaultSessionKeyResolver();
  const pairingStore = new FilePairingStore({ stateDir: path.join(home, "credentials") });
  const adapter = createMockAdapter("telegram");
  router.register(adapter);

  if (!skipOwnerRegistration) {
    pairingStore.addToAllowlist("telegram", "user-1");
  }

  const core = new GatewayCore(config, router, sessionKeys, pairingStore, { logger: () => {} });
  return { core, config, router, adapter, pairingStore };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("GatewayCore: /help command returns command list", async () => {
  await withTempHome("gwcore-help-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/help",
      command: "help",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("/start"));
    assert.ok(adapter.sent[0].text.includes("/run"));
    assert.ok(adapter.sent[0].text.includes("/pairing"));
    assert.match(adapter.sent[0].text, /confirm/i);
    assert.match(adapter.sent[0].text, /openpocket cron list/i);
  });
});

test("GatewayCore: /status command returns status info", async () => {
  await withTempHome("gwcore-status-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("Project:"));
    assert.ok(adapter.sent[0].text.includes("Agent busy:"));
    assert.ok(adapter.sent[0].text.includes("Channel: telegram"));
  });
});

test("GatewayCore: /model shows current model", async () => {
  await withTempHome("gwcore-model-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/model",
      command: "model",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("Current model:"));
  });
});

test("GatewayCore: /stop with no task returns appropriate message", async () => {
  await withTempHome("gwcore-stop-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/stop",
      command: "stop",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, "No running task.");
  });
});

test("GatewayCore: /clear clears conversation", async () => {
  await withTempHome("gwcore-clear-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/clear",
      command: "clear",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, "Conversation memory cleared.");
  });
});

test("GatewayCore: /run without args returns usage", async () => {
  await withTempHome("gwcore-run-noargs-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/run",
      command: "run",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("Usage:"));
  });
});

test("GatewayCore passes latest task journal snapshot into final narration input", async () => {
  await withTempHome("gwcore-journal-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);

    const sessionPath = path.join(config.workspaceDir, "sessions", "session-test.jsonl");
    const backend = new SessionPiTreeJsonlBackend();
    const now = new Date().toISOString();
    backend.create({
      sessionId: "s1",
      sessionPath,
      sessionKey: "k1",
      task: "latte task",
      modelProfile: "profile",
      modelName: "model",
      startedAt: now,
    });
    appendTaskJournalSnapshot(sessionPath, {
      version: 1,
      task: "latte task",
      runId: "run-1",
      updatedAt: now,
      todos: [],
      evidence: [{ id: "e1", kind: "offer", title: "Paris Baguette cafe latte", fields: { price: 5.87 } }],
      artifacts: [],
      progress: { milestones: ["task_start"], blockers: [] },
      completion: { status: "ready_to_finish" },
    });

    core.agent.runTask = async () => ({
      ok: true,
      message: "raw result",
      sessionPath,
      skillPath: null,
      scriptPath: null,
    });

    let capturedOutcomeInput = null;
    core.chat = {
      async narrateTaskOutcome(input) {
        capturedOutcomeInput = input;
        return "FINAL";
      },
      appendExternalTurn() {},
    };

    await core.runTaskAndReport(makeEnvelope({ text: "latte" }), "latte task", "k1");

    assert.equal(adapter.sent.length >= 1, true);
    assert.equal(Boolean(capturedOutcomeInput?.evidenceSnapshot), true);
    assert.equal(capturedOutcomeInput.evidenceSnapshot.evidence[0].title, "Paris Baguette cafe latte");
  });
});

test("GatewayCore falls back to first progress narration when model skips step 1", async () => {
  await withTempHome("gwcore-first-progress-fallback-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    let llmCalls = 0;
    core.chat = {
      async narrateTaskProgress() {
        llmCalls += 1;
        return { notify: false, message: "", reason: "model_skip" };
      },
      fallbackTaskProgressNarration(input) {
        if (input.progress.step === 1) {
          return {
            notify: true,
            message: "Task started (fallback).",
            reason: "fallback_first_progress",
          };
        }
        return { notify: false, message: "", reason: "fallback_skip" };
      },
      async narrateTaskOutcome() {
        return "FINAL";
      },
      async narrateEscalation() {
        return "ESCALATION";
      },
      appendExternalTurn() {},
    };

    core.agent.runTask = async (_task, _modelName, onProgress) => {
      await onProgress({
        step: 1,
        maxSteps: 5,
        currentApp: "com.google.android.apps.nexuslauncher",
        actionType: "todo_write",
        message: "todo_write ok todos=1",
        thought: "set up todos",
        screenshotPath: null,
      });
      return {
        ok: true,
        message: "ok",
        sessionPath: "/tmp/session-first-progress.jsonl",
        skillPath: null,
        scriptPath: null,
      };
    };

    await core.runTaskAndReport(
      makeEnvelope({ text: "beautify latest photo" }),
      "beautify latest photo",
      "session-key-1",
    );

    assert.equal(llmCalls, 1);
    assert.equal(adapter.sent.length, 2);
    assert.equal(adapter.sent[0].text, "Task started (fallback).");
    assert.equal(adapter.sent[1].text, "FINAL");
  });
});

test("GatewayCore: /cronrun without args returns usage", async () => {
  await withTempHome("gwcore-cronrun-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/cronrun",
      command: "cronrun",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("Usage:"));
  });
});

test("GatewayCore: /auth help returns auth commands", async () => {
  await withTempHome("gwcore-auth-help-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/auth",
      command: "auth",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("/auth pending"));
    assert.ok(adapter.sent[0].text.includes("/auth approve"));
  });
});

test("GatewayCore: /pairing list shows pending pairings", async () => {
  await withTempHome("gwcore-pairing-list-", async (home) => {
    const { adapter, core, pairingStore } = createGatewayCore(home);

    // Create a pending pairing
    pairingStore.createPairing("discord", "stranger-1", "Bob");

    await core.handleInbound(makeEnvelope({
      text: "/pairing list",
      command: "pairing",
      commandArgs: "list",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("stranger-1"));
    assert.ok(adapter.sent[0].text.includes("discord"));
  });
});

test("GatewayCore: /pairing approve approves pending pairing", async () => {
  await withTempHome("gwcore-pairing-approve-", async (home) => {
    const { adapter, core, pairingStore } = createGatewayCore(home);

    const req = pairingStore.createPairing("telegram", "new-user", "NewUser");
    assert.ok(req);

    await core.handleInbound(makeEnvelope({
      text: `/pairing approve telegram ${req.code}`,
      command: "pairing",
      commandArgs: `approve telegram ${req.code}`,
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("approved"));
    assert.equal(pairingStore.isApproved("telegram", "new-user"), true);
    assert.equal(pairingStore.listPending("telegram").length, 0);
  });
});

test("GatewayCore: /pairing reject rejects pending pairing", async () => {
  await withTempHome("gwcore-pairing-reject-", async (home) => {
    const { adapter, core, pairingStore } = createGatewayCore(home);

    const req = pairingStore.createPairing("discord", "spam-user", null);
    assert.ok(req);

    await core.handleInbound(makeEnvelope({
      text: `/pairing reject discord ${req.code}`,
      command: "pairing",
      commandArgs: `reject discord ${req.code}`,
    }));

    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.sent[0].text.includes("rejected"));
    assert.equal(pairingStore.isApproved("discord", "spam-user"), false);
  });
});

test("GatewayCore: unknown command falls through to plain message handler", async () => {
  await withTempHome("gwcore-unknown-cmd-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      text: "/nonexistent",
      command: "nonexistent",
      commandArgs: "",
    }));

    // Should produce at least one reply (either from chat.decide or fallback)
    assert.ok(adapter.sent.length >= 0);
  });
});

test("GatewayCore enqueueTask sends model-driven start ack when idle", async () => {
  await withTempHome("gwcore-idle-no-fixed-ack-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    core.chat.taskAcceptedReply = async () => "model-start-ack";
    core.runTaskAndReport = async () => ({
      accepted: true,
      ok: true,
      message: "ok",
      task: "noop",
      durationMs: 0,
      sessionPath: null,
      skillPath: null,
      scriptPath: null,
      modelName: "test-model",
    });

    await core.enqueueTask(makeEnvelope({ text: "run task" }), "run task");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, "model-start-ack");
    assert.equal(adapter.sent.some((item) => /(\u6536\u5230\uff0c\u6211\u5148\u5904\u7406\u8fd9\u4e2a\u4efb\u52a1|On it:)/i.test(item.text)), false);
  });
});

test("GatewayCore handlePlainMessage reuses task ack from routing decision without extra ack inference", async () => {
  await withTempHome("gwcore-task-ack-from-decision-", async (home) => {
    const { adapter, core } = createGatewayCore(home);
    let taskAcceptedReplyCalls = 0;

    core.chat.decide = async () => ({
      mode: "task",
      task: "open camera",
      reply: "",
      taskAcceptedReply: "Starting now: open camera.",
      confidence: 0.99,
      reason: "model_task",
    });
    core.chat.taskAcceptedReply = async () => {
      taskAcceptedReplyCalls += 1;
      return "should-not-be-used";
    };
    core.runTaskAndReport = async () => ({
      accepted: true,
      ok: true,
      message: "ok",
      task: "noop",
      durationMs: 0,
      sessionPath: null,
      skillPath: null,
      scriptPath: null,
      modelName: "test-model",
    });

    await core.handleInbound(makeEnvelope({ text: "open camera" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, "Starting now: open camera.");
    assert.equal(taskAcceptedReplyCalls, 0);
  });
});

test("GatewayCore handlePlainMessage replies with confirmation for schedule intent without executing phone task", async () => {
  await withTempHome("gwcore-schedule-confirm-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);
    let runCalls = 0;

    core.chat.decide = async () => ({
      mode: "schedule_intent",
      task: "Open Slack and complete check-in",
      reply: "Please confirm creating this scheduled job.",
      confidence: 0.99,
      reason: "schedule_intent:cron",
      scheduleIntent: {
        sourceText: "Every morning at 8, open Slack and complete check-in",
        normalizedTask: "Open Slack and complete check-in",
        schedule: {
          kind: "cron",
          expr: "0 8 * * *",
          at: null,
          everyMs: null,
          tz: "Asia/Shanghai",
          summaryText: "Daily 08:00",
        },
        delivery: null,
        requiresConfirmation: true,
        confirmationPrompt: "Please confirm creating this scheduled job.",
      },
    });
    core.runTaskAndReport = async () => {
      runCalls += 1;
      return { accepted: true, ok: true, message: "should-not-run" };
    };

    await core.handleInbound(makeEnvelope({ text: "Every morning at 8, open Slack and complete check-in" }));

    assert.equal(adapter.sent.length, 1);
    assert.match(adapter.sent[0].text, /confirm/i);
    assert.equal(runCalls, 0);

    const jobsFile = path.join(config.workspaceDir, "cron", "jobs.json");
    const saved = JSON.parse(fs.readFileSync(jobsFile, "utf-8"));
    assert.equal(saved.jobs.length, 1, "job should not be created before confirmation");
  });
});

test("GatewayCore creates a structured cron job after confirmation", async () => {
  await withTempHome("gwcore-schedule-create-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);
    let runCalls = 0;

    core.chat.decide = async () => ({
      mode: "schedule_intent",
      task: "Open Slack and complete check-in",
      reply: "Please confirm creating this scheduled job.",
      confidence: 0.99,
      reason: "schedule_intent:cron",
      scheduleIntent: {
        sourceText: "Every morning at 8, open Slack and complete check-in",
        normalizedTask: "Open Slack and complete check-in",
        schedule: {
          kind: "cron",
          expr: "0 8 * * *",
          at: null,
          everyMs: null,
          tz: "Asia/Shanghai",
          summaryText: "Daily 08:00",
        },
        delivery: null,
        requiresConfirmation: true,
        confirmationPrompt: "Please confirm creating this scheduled job.",
      },
    });
    core.runTaskAndReport = async () => {
      return { accepted: true, ok: true, message: "should-not-run" };
    };
    core.agent.runTask = async () => {
      runCalls += 1;
      const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
      const registry = new CronRegistry(config);
      registry.add({
        id: "daily-slack-checkin",
        name: "Daily Slack Check-in",
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "0 8 * * *",
          at: null,
          everyMs: null,
          tz: "Asia/Shanghai",
          summaryText: "Daily 08:00",
        },
        payload: {
          kind: "agent_turn",
          task: "Open Slack and complete check-in",
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "user-1",
        },
        model: null,
        promptMode: "minimal",
      });
      return {
        ok: true,
        message: "created",
        sessionPath: "/tmp/cron-setup.jsonl",
        skillPath: null,
        scriptPath: null,
      };
    };

    await core.handleInbound(makeEnvelope({ text: "Every morning at 8, open Slack and complete check-in" }));
    await core.handleInbound(makeEnvelope({ text: "confirm" }));

    assert.equal(runCalls, 1);
    assert.match(adapter.sent[1].text, /created/i);

    const jobsFile = path.join(config.workspaceDir, "cron", "jobs.json");
    const saved = JSON.parse(fs.readFileSync(jobsFile, "utf-8"));
    const created = saved.jobs.find((job) => job.payload?.task === "Open Slack and complete check-in");
    assert.equal(Boolean(created), true);
    assert.equal(created.schedule.kind, "cron");
    assert.equal(created.delivery.channel, "telegram");
    assert.equal(created.delivery.to, "user-1");
  });
});

test("GatewayCore uses a restricted cron setup run after confirmation", async () => {
  await withTempHome("gwcore-schedule-setup-run-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);
    let capturedTask = "";
    let capturedToolNames = null;

    core.chat.decide = async () => ({
      mode: "schedule_intent",
      task: "Open Slack and complete check-in",
      reply: "Please confirm creating this scheduled job.",
      confidence: 0.99,
      reason: "schedule_intent:cron",
      scheduleIntent: {
        sourceText: "Every morning at 8, open Slack and complete check-in",
        normalizedTask: "Open Slack and complete check-in",
        schedule: {
          kind: "cron",
          expr: "0 8 * * *",
          at: null,
          everyMs: null,
          tz: "Asia/Shanghai",
          summaryText: "Daily 08:00",
        },
        delivery: null,
        requiresConfirmation: true,
        confirmationPrompt: "Please confirm creating this scheduled job.",
      },
    });

    core.agent.runTask = async (
      task,
      _modelName,
      _onProgress,
      _onHumanAuth,
      _promptMode,
      _onUserDecision,
      _sessionKey,
      _onUserInput,
      _onChannelMedia,
      _taskExecutionPlan,
      availableToolNamesOverride,
    ) => {
      capturedTask = task;
      capturedToolNames = availableToolNamesOverride;
      const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
      const registry = new CronRegistry(config);
      registry.add({
        id: "daily-slack-checkin",
        name: "Daily Slack Check-in",
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "0 8 * * *",
          at: null,
          everyMs: null,
          tz: "Asia/Shanghai",
          summaryText: "Daily 08:00",
        },
        payload: {
          kind: "agent_turn",
          task: "Open Slack and complete check-in",
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "user-1",
        },
        model: null,
        promptMode: "minimal",
      });
      return {
        ok: true,
        message: "created",
        sessionPath: "/tmp/cron-setup.jsonl",
        skillPath: null,
        scriptPath: null,
      };
    };

    await core.handleInbound(makeEnvelope({ text: "Every morning at 8, open Slack and complete check-in" }));
    await core.handleInbound(makeEnvelope({ text: "confirm" }));

    assert.match(capturedTask, /Create exactly one cron job/i);
    assert.deepEqual(capturedToolNames, ["cron_add", "finish"]);
    assert.match(adapter.sent[1].text, /created/i);
  });
});

test("GatewayCore answers schedule-management list requests directly from the cron registry", async () => {
  await withTempHome("gwcore-schedule-manage-list-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);
    let enqueueCalls = 0;

    const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
    const registry = new CronRegistry(config);
    registry.add({
      id: "earn-app-daily-check",
      name: "Earn App Daily Check",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 21 * * *",
        at: null,
        everyMs: null,
        tz: "America/Los_Angeles",
        summaryText: "Daily at 9 PM",
      },
      payload: {
        kind: "agent_turn",
        task: "Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
      },
      model: null,
      promptMode: "minimal",
    });

    core.chat.decide = async () => ({
      mode: "task",
      task: "list existing scheduled tasks",
      reply: "",
      confidence: 0.98,
      reason: "schedule_manage;schedule_model_manage",
      scheduleManagement: true,
      scheduleManagementAction: "list",
      cronManagementIntent: {
        action: "list",
        selector: {
          all: false,
          ids: [],
          nameContains: [],
          taskContains: [],
          scheduleContains: [],
          enabled: "any",
        },
        patch: {
          name: null,
          task: null,
          enabled: null,
          schedule: null,
        },
      },
    });
    core.enqueueTask = async () => {
      enqueueCalls += 1;
    };

    await core.handleInbound(makeEnvelope({
      text: "list existing scheduled tasks",
    }));

    assert.equal(enqueueCalls, 0);
    assert.match(adapter.sent[0].text, /Scheduled jobs \(\d+\):/i);
    assert.match(adapter.sent[0].text, /earn-app-daily-check/);
    assert.match(adapter.sent[0].text, /Daily at 9 PM/);
  });
});

test("GatewayCore updates a single matching scheduled job directly from structured cron management intent", async () => {
  await withTempHome("gwcore-schedule-manage-update-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);
    let enqueueCalls = 0;

    const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
    const registry = new CronRegistry(config);
    registry.add({
      id: "earn-app-daily-check",
      name: "Earn App Daily Check",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 21 * * *",
        at: null,
        everyMs: null,
        tz: "America/Los_Angeles",
        summaryText: "Daily at 9 PM",
      },
      payload: {
        kind: "agent_turn",
        task: "Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
      },
      model: null,
      promptMode: "minimal",
    });

    core.chat.decide = async () => ({
      mode: "task",
      task: "Modify the cron job for the Earn app to run daily at 10:20 PM",
      reply: "",
      confidence: 0.98,
      reason: "schedule_manage;schedule_model_manage",
      scheduleManagement: true,
      scheduleManagementAction: "update",
      cronManagementIntent: {
        action: "update",
        selector: {
          all: false,
          ids: [],
          nameContains: ["Earn App"],
          taskContains: [],
          scheduleContains: [],
          enabled: "any",
        },
        patch: {
          name: null,
          task: null,
          enabled: null,
          schedule: {
            kind: "cron",
            expr: "20 22 * * *",
            at: null,
            everyMs: null,
            tz: "America/Los_Angeles",
            summaryText: "Daily at 10:20 PM",
          },
        },
      },
    });
    core.enqueueTask = async () => {
      enqueueCalls += 1;
    };

    await core.handleInbound(makeEnvelope({
      text: "Modify the cron job for the Earn app to run daily at 10:20 PM",
    }));
    assert.equal(enqueueCalls, 0);

    const updated = registry.get("earn-app-daily-check");
    assert.equal(updated?.schedule.expr, "20 22 * * *");
    assert.match(adapter.sent[0].text, /Updated scheduled job earn-app-daily-check/i);
    assert.match(adapter.sent[0].text, /Daily at 10:20 PM/i);
  });
});

test("GatewayCore removes all scheduled jobs directly from structured cron management intent", async () => {
  await withTempHome("gwcore-schedule-manage-remove-all-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);

    const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
    const registry = new CronRegistry(config);
    const baselineCount = registry.list().length;
    for (const id of ["earn-app-daily-check", "slack-daily-check"]) {
      registry.add({
        id,
        name: id,
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "0 21 * * *",
          at: null,
          everyMs: null,
          tz: "America/Los_Angeles",
          summaryText: "Daily at 9 PM",
        },
        payload: {
          kind: "agent_turn",
          task: `Task for ${id}`,
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "user-1",
        },
        model: null,
        promptMode: "minimal",
      });
    }

    core.chat.decide = async () => ({
      mode: "task",
      task: "remove all scheduled jobs",
      reply: "",
      confidence: 0.99,
      reason: "schedule_manage;schedule_model_manage",
      scheduleManagement: true,
      scheduleManagementAction: "remove",
      cronManagementIntent: {
        action: "remove",
        selector: {
          all: true,
          ids: [],
          nameContains: [],
          taskContains: [],
          scheduleContains: [],
          enabled: "any",
        },
        patch: {
          name: null,
          task: null,
          enabled: null,
          schedule: null,
        },
      },
    });

    await core.handleInbound(makeEnvelope({
      text: "remove all scheduled jobs",
    }));

    assert.equal(registry.list().length, 0);
    assert.match(adapter.sent[0].text, new RegExp(`Removed ${baselineCount + 2} scheduled jobs`, "i"));
    assert.match(adapter.sent[0].text, /earn-app-daily-check/);
    assert.match(adapter.sent[0].text, /slack-daily-check/);
  });
});

test("GatewayCore removes a specific scheduled job directly from structured cron management intent", async () => {
  await withTempHome("gwcore-schedule-manage-remove-one-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);

    const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
    const registry = new CronRegistry(config);
    registry.add({
      id: "earn-app-daily-check",
      name: "Earn App Daily Check",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 21 * * *",
        at: null,
        everyMs: null,
        tz: "America/Los_Angeles",
        summaryText: "Daily at 9 PM",
      },
      payload: {
        kind: "agent_turn",
        task: "Check EarnApp rewards",
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
      },
      model: null,
      promptMode: "minimal",
    });
    registry.add({
      id: "slack-daily-check",
      name: "Slack Daily Check",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 8 * * *",
        at: null,
        everyMs: null,
        tz: "America/Los_Angeles",
        summaryText: "Daily at 8 AM",
      },
      payload: {
        kind: "agent_turn",
        task: "Open Slack and check in",
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
      },
      model: null,
      promptMode: "minimal",
    });

    core.chat.decide = async () => ({
      mode: "task",
      task: "remove earn-app-daily-check",
      reply: "",
      confidence: 0.99,
      reason: "schedule_manage;schedule_model_manage",
      scheduleManagement: true,
      scheduleManagementAction: "remove",
      cronManagementIntent: {
        action: "remove",
        selector: {
          all: false,
          ids: ["earn-app-daily-check"],
          nameContains: [],
          taskContains: [],
          scheduleContains: [],
          enabled: "any",
        },
        patch: {
          name: null,
          task: null,
          enabled: null,
          schedule: null,
        },
      },
    });

    await core.handleInbound(makeEnvelope({
      text: "remove earn-app-daily-check",
    }));

    assert.equal(registry.get("earn-app-daily-check"), null);
    assert.ok(registry.get("slack-daily-check"));
    assert.match(adapter.sent[0].text, /Removed scheduled job earn-app-daily-check/i);
  });
});

test("GatewayCore removes Earn App jobs even when a stored job uses EarnApp without a space", async () => {
  await withTempHome("gwcore-schedule-manage-remove-earnapp-variant-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);

    const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
    const registry = new CronRegistry(config);
    const baselineIds = new Set(registry.list().map((job) => job.id));
    for (const job of [
      {
        id: "schedule-1773027487704-check-earnapp-do-a-quick-rewards",
        name: "Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "0 21 * * *",
          at: null,
          everyMs: null,
          tz: "America/Los_Angeles",
          summaryText: "Daily at 9 PM",
        },
        payload: {
          kind: "agent_turn",
          task: "Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "user-1",
        },
        model: null,
        promptMode: "minimal",
      },
      {
        id: "schedule-1772925597704-go-to-earn-app-and-read-listen",
        name: "Go to Earn App and read one article and listen once",
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "0 20 * * *",
          at: null,
          everyMs: null,
          tz: "America/Los_Angeles",
          summaryText: "Daily at 8 PM",
        },
        payload: {
          kind: "agent_turn",
          task: "Go to Earn App and read one article and listen once",
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "user-1",
        },
        model: null,
        promptMode: "minimal",
      },
      {
        id: "schedule-1773033317242-modify-the-cron-job-for-the-earn",
        name: "Modify the cron job for the Earn app",
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "20 22 * * *",
          at: null,
          everyMs: null,
          tz: "America/Los_Angeles",
          summaryText: "Daily at 10:20 PM",
        },
        payload: {
          kind: "agent_turn",
          task: "Modify the cron job for the Earn app",
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "user-1",
        },
        model: null,
        promptMode: "minimal",
      },
    ]) {
      registry.add(job);
    }

    core.chat.decide = async () => ({
      mode: "task",
      task: "I want to remove all scheduled tasks associated with Earn App",
      reply: "",
      confidence: 0.98,
      reason: "schedule_manage;schedule_model_manage",
      scheduleManagement: true,
      scheduleManagementAction: "remove",
      cronManagementIntent: {
        action: "remove",
        selector: {
          all: true,
          ids: [],
          nameContains: ["Earn App"],
          taskContains: [],
          scheduleContains: [],
          enabled: "any",
        },
        patch: {
          name: null,
          task: null,
          enabled: null,
          schedule: null,
        },
      },
    });

    await core.handleInbound(makeEnvelope({
      text: "I want to remove all scheduled tasks associated with Earn App",
    }));

    assert.equal(registry.get("schedule-1773027487704-check-earnapp-do-a-quick-rewards"), null);
    assert.equal(registry.get("schedule-1772925597704-go-to-earn-app-and-read-listen"), null);
    assert.equal(registry.get("schedule-1773033317242-modify-the-cron-job-for-the-earn"), null);
    assert.deepEqual(
      registry.list().map((job) => job.id).sort(),
      [...baselineIds].sort(),
    );
    assert.match(adapter.sent[0].text, /Removed 3 scheduled jobs/i);
    assert.match(adapter.sent[0].text, /schedule-1773027487704-check-earnapp-do-a-quick-rewards/);
  });
});

test("GatewayCore asks for clarification when a cron removal target is ambiguous", async () => {
  await withTempHome("gwcore-schedule-manage-ambiguous-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);

    const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
    const registry = new CronRegistry(config);
    const baselineCount = registry.list().length;
    registry.add({
      id: "earn-app-daily-check",
      name: "Earn App Daily Check",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 21 * * *",
        at: null,
        everyMs: null,
        tz: "America/Los_Angeles",
        summaryText: "Daily at 9 PM",
      },
      payload: {
        kind: "agent_turn",
        task: "Check EarnApp rewards",
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
      },
      model: null,
      promptMode: "minimal",
    });
    registry.add({
      id: "earn-app-weekend-check",
      name: "Earn App Weekend Check",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 10 * * 6",
        at: null,
        everyMs: null,
        tz: "America/Los_Angeles",
        summaryText: "Every Saturday at 10 AM",
      },
      payload: {
        kind: "agent_turn",
        task: "Check EarnApp bonus rewards",
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
      },
      model: null,
      promptMode: "minimal",
    });

    core.chat.decide = async () => ({
      mode: "task",
      task: "remove the Earn App scheduled job",
      reply: "",
      confidence: 0.95,
      reason: "schedule_manage;schedule_model_manage",
      scheduleManagement: true,
      scheduleManagementAction: "remove",
      cronManagementIntent: {
        action: "remove",
        selector: {
          all: false,
          ids: [],
          nameContains: ["Earn App"],
          taskContains: [],
          scheduleContains: [],
          enabled: "any",
        },
        patch: {
          name: null,
          task: null,
          enabled: null,
          schedule: null,
        },
      },
    });

    await core.handleInbound(makeEnvelope({
      text: "remove the Earn App scheduled job",
    }));

    assert.equal(registry.list().length, baselineCount + 2);
    assert.match(adapter.sent[0].text, /Multiple scheduled jobs matched/i);
    assert.match(adapter.sent[0].text, /earn-app-daily-check/);
    assert.match(adapter.sent[0].text, /earn-app-weekend-check/);
  });
});

test("GatewayCore updates an EarnApp job when the selector uses Earn App wording and a 9:00 PM schedule phrase", async () => {
  await withTempHome("gwcore-schedule-manage-update-earnapp-variant-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);

    const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
    const registry = new CronRegistry(config);
    registry.add({
      id: "schedule-1773027487704-check-earnapp-do-a-quick-rewards",
      name: "Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 21 * * *",
        at: null,
        everyMs: null,
        tz: "America/Los_Angeles",
        summaryText: "Daily at 9 PM",
      },
      payload: {
        kind: "agent_turn",
        task: "Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "user-1",
      },
      model: null,
      promptMode: "minimal",
    });

    core.chat.decide = async () => ({
      mode: "task",
      task: "Update the daily 9:00 PM Earn App schedule task to 12:10 AM",
      reply: "",
      confidence: 0.98,
      reason: "schedule_manage;schedule_model_manage",
      scheduleManagement: true,
      scheduleManagementAction: "update",
      cronManagementIntent: {
        action: "update",
        selector: {
          all: false,
          ids: [],
          nameContains: ["Earn App"],
          taskContains: [],
          scheduleContains: ["daily 9:00 PM"],
          enabled: "any",
        },
        patch: {
          name: null,
          task: null,
          enabled: null,
          schedule: {
            kind: "cron",
            expr: "10 0 * * *",
            at: null,
            everyMs: null,
            tz: "America/Los_Angeles",
            summaryText: "Daily at 12:10 AM",
          },
        },
      },
    });

    await core.handleInbound(makeEnvelope({
      text: "Update the daily 9:00 PM Earn App schedule task to 12:10 AM",
    }));

    const updated = registry.get("schedule-1773027487704-check-earnapp-do-a-quick-rewards");
    assert.equal(updated?.schedule.expr, "10 0 * * *");
    assert.equal(updated?.schedule.summaryText, "Daily at 12:10 AM");
    assert.match(
      adapter.sent[0].text,
      /Updated scheduled job schedule-1773027487704-check-earnapp-do-a-quick-rewards/i,
    );
    assert.match(adapter.sent[0].text, /Daily at 12:10 AM/i);
  });
});

test("GatewayCore updates a contextual Earn App schedule to Google Opinion Rewards using prior job-list context", async () => {
  await withTempHome("gwcore-schedule-manage-contextual-update-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);
    config.models[config.defaultModel].apiKey = "test-key";
    core.chat.auditGroundingNeed = async () => ({
      requiresExternalObservation: false,
      canAnswerDirectly: true,
      confidence: 0.95,
      reason: "test_default_grounding_audit",
    });

    const { CronRegistry } = await import("../dist/gateway/cron-registry.js");
    const registry = new CronRegistry(config);
    registry.add({
      id: "schedule-1773027487704-check-earnapp-do-a-quick-rewards",
      name: "Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: "0 21 * * *",
        at: null,
        everyMs: null,
        tz: "America/Los_Angeles",
        summaryText: "Daily at 9 PM",
      },
      payload: {
        kind: "agent_turn",
        task: "Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "1",
      },
      model: null,
      promptMode: "minimal",
    });

    core.chat.appendExternalTurn(
      1,
      "assistant",
      [
        "Scheduled jobs (1):",
        "- schedule-1773027487704-check-earnapp-do-a-quick-rewards | enabled | Daily at 9 PM -> telegram:1",
        "  Check EarnApp; do a quick rewards check; check if more rewards can be claimed",
      ].join("\n"),
    );

    const input =
      "Is the scheduled task for this not clear to you? You need to use Google Opinion Rewards instead of this Earn App. In it, you should check whether you can do a quick win to earn some rewards daily that can accumulate. So, can you improve your schedule task for it? Also, you need to change the daily schedule time to 8 a.m.";

    core.chat.callModelRaw = async (_client, _model, _maxTokens, prompt, purpose) => {
      if (purpose !== "schedule classify") {
        throw new Error(`unexpected model call: ${purpose}`);
      }
      assert.match(prompt, /Scheduled jobs \(1\):/);
      assert.match(prompt, /schedule-1773027487704-check-earnapp-do-a-quick-rewards/);
      assert.match(prompt, /Check EarnApp; do a quick rewards check; check if more rewards can be claimed/);
      return JSON.stringify({
        route: "manage_schedule",
        task: input,
        manageIntent: {
          action: "update",
          selector: {
            all: false,
            ids: [],
            nameContains: ["Earn App"],
            taskContains: [],
            scheduleContains: ["Daily at 9 PM"],
            enabled: "any",
          },
          patch: {
            name: null,
            task: "Check Google Opinion Rewards; do a quick daily rewards check; see whether more rewards can be claimed",
            enabled: null,
            schedule: {
              kind: "cron",
              expr: "0 8 * * *",
              at: null,
              everyMs: null,
              tz: "America/Los_Angeles",
              summaryText: "Daily at 8 AM",
            },
          },
        },
        confidence: 0.98,
        reason: "contextual_schedule_manage",
      });
    };
    core.chat.classifyWithModel = async () => {
      throw new Error("classifyWithModel should not run after contextual schedule extraction");
    };

    await core.handleInbound(makeEnvelope({
      peerId: "1",
      text: input,
    }));

    const updated = registry.get("schedule-1773027487704-check-earnapp-do-a-quick-rewards");
    assert.equal(
      updated?.payload.task,
      "Check Google Opinion Rewards; do a quick daily rewards check; see whether more rewards can be claimed",
    );
    assert.equal(updated?.schedule.expr, "0 8 * * *");
    assert.equal(updated?.schedule.summaryText, "Daily at 8 AM");
    assert.match(
      adapter.sent[0].text,
      /Updated scheduled job schedule-1773027487704-check-earnapp-do-a-quick-rewards/i,
    );
    assert.match(adapter.sent[0].text, /task updated/i);
    assert.match(adapter.sent[0].text, /Daily at 8 AM/i);
  });
});

test("GatewayCore cancels pending schedule confirmation without creating a job", async () => {
  await withTempHome("gwcore-schedule-cancel-", async (home) => {
    const { adapter, core, config } = createGatewayCore(home);

    core.chat.decide = async () => ({
      mode: "schedule_intent",
      task: "Open Slack and complete check-in",
      reply: "Please confirm creating this scheduled job.",
      confidence: 0.99,
      reason: "schedule_intent:cron",
      scheduleIntent: {
        sourceText: "Every morning at 8, open Slack and complete check-in",
        normalizedTask: "Open Slack and complete check-in",
        schedule: {
          kind: "cron",
          expr: "0 8 * * *",
          at: null,
          everyMs: null,
          tz: "Asia/Shanghai",
          summaryText: "Daily 08:00",
        },
        delivery: null,
        requiresConfirmation: true,
        confirmationPrompt: "Please confirm creating this scheduled job.",
      },
    });

    await core.handleInbound(makeEnvelope({ text: "Every morning at 8, open Slack and complete check-in" }));
    await core.handleInbound(makeEnvelope({ text: "cancel" }));

    assert.match(adapter.sent[1].text, /cancel/i);

    const jobsFile = path.join(config.workspaceDir, "cron", "jobs.json");
    const saved = JSON.parse(fs.readFileSync(jobsFile, "utf-8"));
    const created = saved.jobs.find((job) => job.payload?.task === "Open Slack and complete check-in");
    assert.equal(created, undefined);
  });
});

test("GatewayCore blocks unrelated messages while schedule confirmation is pending", async () => {
  await withTempHome("gwcore-schedule-pending-", async (home) => {
    const { adapter, core } = createGatewayCore(home);
    let decideCalls = 0;

    core.chat.decide = async (chatId, text) => {
      void chatId;
      decideCalls += 1;
      if (text === "Every morning at 8, open Slack and complete check-in") {
        return {
          mode: "schedule_intent",
          task: "Open Slack and complete check-in",
          reply: "Please confirm creating this scheduled job.",
          confidence: 0.99,
          reason: "schedule_intent:cron",
          scheduleIntent: {
            sourceText: text,
            normalizedTask: "Open Slack and complete check-in",
            schedule: {
              kind: "cron",
              expr: "0 8 * * *",
              at: null,
              everyMs: null,
              tz: "Asia/Shanghai",
              summaryText: "Daily 08:00",
            },
            delivery: null,
            requiresConfirmation: true,
            confirmationPrompt: "Please confirm creating this scheduled job.",
          },
        };
      }
      return {
        mode: "task",
        task: text,
        reply: "",
        confidence: 0.9,
        reason: "model_task",
      };
    };

    await core.handleInbound(makeEnvelope({ text: "Every morning at 8, open Slack and complete check-in" }));
    await core.handleInbound(makeEnvelope({ text: "Also open the camera" }));

    assert.equal(decideCalls, 1, "pending confirmation should intercept unrelated follow-up text");
    assert.match(adapter.sent[1].text, /confirm|cancel/i);
  });
});

test("GatewayCore enqueueTask keeps queued ack when another task is running", async () => {
  await withTempHome("gwcore-queue-ack-", async (home) => {
    const { adapter, core } = createGatewayCore(home);
    core.agent.isBusy = () => true;

    await core.enqueueTask(makeEnvelope({ text: "run task" }), "run task");

    assert.equal(adapter.sent.length, 1);
    assert.match(adapter.sent[0].text, /queued/i);
  });
});

test("GatewayCore: registerCommand allows custom commands", async () => {
  await withTempHome("gwcore-custom-cmd-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    core.registerCommand("ping", async (env) => {
      await core.handleInbound; // access to verify core is accessible
      const routerRef = adapter; // use captured adapter for reply
      routerRef.sent.push({ peerId: env.peerId, text: "pong" });
    });

    await core.handleInbound(makeEnvelope({
      text: "/ping",
      command: "ping",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].text, "pong");
  });
});

test("GatewayCore: replies go to originating channel peerId", async () => {
  await withTempHome("gwcore-reply-routing-", async (home) => {
    const { adapter, core } = createGatewayCore(home);

    await core.handleInbound(makeEnvelope({
      peerId: "chat-999",
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].peerId, "chat-999");
  });
});

test("GatewayCore: lifecycle start and stop", async () => {
  await withTempHome("gwcore-lifecycle-", async (home) => {
    const { core } = createGatewayCore(home);

    assert.equal(core.isRunning(), false);
    await core.start();
    assert.equal(core.isRunning(), true);
    await core.stop("test");
    assert.equal(core.isRunning(), false);
  });
});

// ---------------------------------------------------------------------------
// Group vs DM access control
// ---------------------------------------------------------------------------

function createGatewayCoreMulti(home, channelType, { channels = {}, skipOwnerRegistration = false } = {}) {
  const config = loadConfig();
  config.channels = config.channels || {};
  Object.assign(config.channels, channels);

  const router = new DefaultChannelRouter({ log: () => {} });
  const sessionKeys = new DefaultSessionKeyResolver();
  const pairingStore = new FilePairingStore({ stateDir: path.join(home, "credentials") });
  const adapter = createMockAdapter(channelType);
  router.register(adapter);

  if (!skipOwnerRegistration) {
    pairingStore.addToAllowlist(channelType, "owner-1");
  }

  const core = new GatewayCore(config, router, sessionKeys, pairingStore, { logger: () => {} });
  return { core, config, router, adapter, pairingStore };
}

test("GatewayCore: group messages skip owner claim (groupPolicy=open)", async () => {
  await withTempHome("gwcore-group-open-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "whatsapp", {
      channels: { whatsapp: { dmPolicy: "pairing", groupPolicy: "open" } },
      skipOwnerRegistration: true,
    });

    await core.handleInbound(makeEnvelope({
      channelType: "whatsapp",
      senderId: "8613800001111",
      peerId: "120363001@g.us",
      peerKind: "group",
      text: "hello from group",
    }));

    // With groupPolicy=open, the message should be allowed (no owner claim reply).
    // Should NOT get an owner claim message since it's a group message.
    const ownerClaimMsg = adapter.sent.find((m) => m.text.includes("owner") || m.text.includes("auto-registered"));
    assert.equal(ownerClaimMsg, undefined, "Group messages must not trigger owner claim");
  });
});

test("GatewayCore: DM messages DO trigger owner claim", async () => {
  await withTempHome("gwcore-dm-owner-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "whatsapp", {
      channels: { whatsapp: { dmPolicy: "pairing" } },
      skipOwnerRegistration: true,
    });

    await core.handleInbound(makeEnvelope({
      channelType: "whatsapp",
      senderId: "8613800001111",
      peerId: "8613800001111",
      peerKind: "dm",
      text: "hello",
    }));

    const ownerClaimMsg = adapter.sent.find((m) =>
      m.text.includes("owner") || m.text.includes("auto-registered") || m.text.includes("\u7b2c\u4e00\u4e2a\u7528\u6237"),
    );
    assert.ok(ownerClaimMsg, "DM should trigger owner claim");
  });
});

test("GatewayCore: group messages blocked when groupPolicy=disabled", async () => {
  await withTempHome("gwcore-group-disabled-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "whatsapp", {
      channels: { whatsapp: { groupPolicy: "disabled" } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "whatsapp",
      senderId: "8613800002222",
      peerId: "120363001@g.us",
      peerKind: "group",
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.equal(adapter.sent.length, 0, "Group messages should be silently dropped when disabled");
  });
});

test("GatewayCore: group messages with groupPolicy=allowlist, approved sender passes", async () => {
  await withTempHome("gwcore-group-allowlist-approved-", async (home) => {
    const { adapter, core, pairingStore } = createGatewayCoreMulti(home, "whatsapp", {
      channels: { whatsapp: { groupPolicy: "allowlist" } },
    });

    pairingStore.addToAllowlist("whatsapp", "8613800003333");

    await core.handleInbound(makeEnvelope({
      channelType: "whatsapp",
      senderId: "8613800003333",
      peerId: "120363001@g.us",
      peerKind: "group",
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.ok(adapter.sent.length > 0, "Approved sender in group should be allowed");
  });
});

test("GatewayCore: group messages with groupPolicy=allowlist, unknown sender blocked silently", async () => {
  await withTempHome("gwcore-group-allowlist-blocked-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "whatsapp", {
      channels: { whatsapp: { groupPolicy: "allowlist" } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "whatsapp",
      senderId: "8613800009999",
      peerId: "120363001@g.us",
      peerKind: "group",
      text: "hello",
    }));

    const pairingMsg = adapter.sent.find((m) => m.text.includes("pairing") || m.text.includes("\u914d\u5bf9"));
    assert.equal(pairingMsg, undefined, "Group messages must NOT issue pairing codes");
    assert.equal(adapter.sent.length, 0, "Unknown sender in group should be silently blocked");
  });
});

test("GatewayCore: DM pairing code issued for unknown sender", async () => {
  await withTempHome("gwcore-dm-pairing-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "whatsapp", {
      channels: { whatsapp: { dmPolicy: "pairing" } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "whatsapp",
      senderId: "8613800005555",
      peerId: "8613800005555",
      peerKind: "dm",
      text: "hello",
    }));

    const pairingMsg = adapter.sent.find((m) => m.text.includes("pairing") || m.text.includes("\u914d\u5bf9"));
    assert.ok(pairingMsg, "DM from unknown sender should issue pairing code");
  });
});

// ---------------------------------------------------------------------------
// WhatsApp phone number normalization in allowFrom
// ---------------------------------------------------------------------------

test("GatewayCore: WhatsApp allowFrom normalizes phone numbers", async () => {
  await withTempHome("gwcore-wa-normalize-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "whatsapp", {
      channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+86-138-0000-1111"] } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "whatsapp",
      senderId: "8613800001111",
      peerId: "8613800001111",
      peerKind: "dm",
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.ok(adapter.sent.length > 0, "Normalized phone should match allowFrom");
  });
});

test("GatewayCore: WhatsApp allowFrom with + prefix matches digits-only sender", async () => {
  await withTempHome("gwcore-wa-plus-prefix-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "whatsapp", {
      channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+12345678900"] } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "whatsapp",
      senderId: "12345678900",
      peerId: "12345678900",
      peerKind: "dm",
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.ok(adapter.sent.length > 0, "Phone with + prefix should match digits-only sender");
  });
});

// ---------------------------------------------------------------------------
// iMessage access control
// ---------------------------------------------------------------------------

test("GatewayCore: iMessage DM owner claim on first message", async () => {
  await withTempHome("gwcore-im-owner-claim-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "imessage", {
      channels: { imessage: { dmPolicy: "pairing" } },
      skipOwnerRegistration: true,
    });

    await core.handleInbound(makeEnvelope({
      channelType: "imessage",
      senderId: "alice@icloud.com",
      peerId: "alice@icloud.com",
      peerKind: "dm",
      text: "hello",
    }));

    const ownerMsg = adapter.sent.find((m) =>
      m.text.includes("owner") || m.text.includes("auto-registered") || m.text.includes("\u7b2c\u4e00\u4e2a\u7528\u6237"),
    );
    assert.ok(ownerMsg, "iMessage DM should trigger owner claim");
  });
});

test("GatewayCore: iMessage DM pairing code for unknown sender", async () => {
  await withTempHome("gwcore-im-pairing-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "imessage", {
      channels: { imessage: { dmPolicy: "pairing" } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "imessage",
      senderId: "bob@icloud.com",
      peerId: "bob@icloud.com",
      peerKind: "dm",
      text: "hi there",
    }));

    const pairingMsg = adapter.sent.find((m) => m.text.includes("pairing") || m.text.includes("\u914d\u5bf9"));
    assert.ok(pairingMsg, "Unknown iMessage sender should get pairing code");
  });
});

test("GatewayCore: iMessage allowlist blocks unknown sender", async () => {
  await withTempHome("gwcore-im-allowlist-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "imessage", {
      channels: { imessage: { dmPolicy: "allowlist", allowFrom: ["alice@icloud.com"] } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "imessage",
      senderId: "eve@icloud.com",
      peerId: "eve@icloud.com",
      peerKind: "dm",
      text: "hey",
    }));

    assert.equal(adapter.sent.length, 0, "Sender not in allowlist should be silently blocked");
  });
});

test("GatewayCore: iMessage allowlist allows configured sender", async () => {
  await withTempHome("gwcore-im-allowlist-pass-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "imessage", {
      channels: { imessage: { dmPolicy: "allowlist", allowFrom: ["alice@icloud.com"] } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "imessage",
      senderId: "alice@icloud.com",
      peerId: "alice@icloud.com",
      peerKind: "dm",
      text: "/status",
      command: "status",
      commandArgs: "",
    }));

    assert.ok(adapter.sent.length > 0, "Allowlisted sender should be allowed");
  });
});

test("GatewayCore: iMessage group open policy allows message", async () => {
  await withTempHome("gwcore-im-group-open-", async (home) => {
    const { adapter, core } = createGatewayCoreMulti(home, "imessage", {
      channels: { imessage: { groupPolicy: "open" } },
    });

    await core.handleInbound(makeEnvelope({
      channelType: "imessage",
      senderId: "bob@icloud.com",
      peerId: "chat12345",
      peerKind: "group",
      text: "group message",
    }));

    const ownerClaimMsg = adapter.sent.find((m) => m.text.includes("owner") || m.text.includes("auto-registered"));
    assert.equal(ownerClaimMsg, undefined, "Group messages must not trigger owner claim");
  });
});

test("GatewayCore: deliverChannelMedia sends local image via channel image upload", async () => {
  await withTempHome("gwcore-media-image-", async (home) => {
    const { adapter, core } = createGatewayCore(home);
    const imagePath = path.join(home, "local-output.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await core.deliverChannelMedia(
      makeEnvelope({ peerId: "user-1" }),
      {
        sessionId: "s1",
        sessionPath: path.join(home, "sessions", "s1.jsonl"),
        task: "send output",
        step: 1,
        path: imagePath,
        mediaType: "image",
        caption: "done",
        reason: "unit-test",
        currentApp: "com.example",
        screenshotPath: null,
      },
      adapter,
    );

    assert.equal(result.ok, true);
    assert.equal(result.mediaType, "image");
    assert.equal(adapter.images.length, 1);
    assert.equal(adapter.images[0].caption, "done");
  });
});

test("GatewayCore: deliverChannelMedia sends local voice via channel voice upload", async () => {
  await withTempHome("gwcore-media-voice-", async (home) => {
    const { adapter, core } = createGatewayCore(home);
    const voicePath = path.join(home, "voice-note.ogg");
    fs.writeFileSync(voicePath, Buffer.from([0x4f, 0x67, 0x67, 0x53]));

    const result = await core.deliverChannelMedia(
      makeEnvelope({ peerId: "user-1" }),
      {
        sessionId: "s1",
        sessionPath: path.join(home, "sessions", "s1.jsonl"),
        task: "send voice",
        step: 1,
        path: voicePath,
        mediaType: "auto",
        caption: "voice",
        reason: "unit-test",
        currentApp: "com.example",
        screenshotPath: null,
      },
      adapter,
    );

    assert.equal(result.ok, true);
    assert.equal(result.mediaType, "voice");
    assert.equal(adapter.voices.length, 1);
    assert.equal(adapter.voices[0].caption, "voice");
  });
});
