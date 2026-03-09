import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const {
  inferScheduleIntentLocale,
  normalizeScheduleIntentCandidate,
} = await import("../dist/gateway/schedule-intent.js");

test("schedule intent normalization builds confirmation from model output", () => {
  const zhRequest = "\u6bcf\u5929\u65e9\u4e0a 8 \u70b9\u5e2e\u6211\u6253\u5f00 Slack";
  assert.equal(inferScheduleIntentLocale(zhRequest), "zh");

  const intent = normalizeScheduleIntentCandidate("\u6bcf\u5929\u65e9\u4e0a 8 \u70b9\u5e2e\u6211\u6253\u5f00 Slack \u53bb\u6253\u5361", {
    isScheduleIntent: true,
    task: "Open Slack and complete check-in",
    schedule: {
      kind: "cron",
      expr: "0 8 * * *",
      summaryText: "Every day at 08:00",
    },
  }, {
    timezone: "Asia/Shanghai",
  });

  assert.ok(intent);
  assert.equal(intent?.schedule.kind, "cron");
  assert.equal(intent?.schedule.expr, "0 8 * * *");
  assert.equal(intent?.schedule.summaryText, "Every day at 08:00");
  assert.match(intent?.confirmationPrompt ?? "", /confirm/i);
});

test("schedule intent normalization requires RFC3339 at value for one-shot schedules", () => {
  const invalid = normalizeScheduleIntentCandidate("Open Slack tomorrow at 8am", {
    isScheduleIntent: true,
    task: "Open Slack",
    schedule: {
      kind: "at",
      summaryText: "tomorrow at 08:00",
    },
  }, {
    timezone: "America/Los_Angeles",
  });
  assert.equal(invalid, null);

  const valid = normalizeScheduleIntentCandidate("Open Slack tomorrow at 8am", {
    isScheduleIntent: true,
    task: "Open Slack",
    schedule: {
      kind: "at",
      at: "2026-03-08T08:00:00-08:00",
      summaryText: "tomorrow at 08:00",
    },
  }, {
    timezone: "America/Los_Angeles",
  });
  assert.ok(valid);
  assert.equal(valid?.schedule.kind, "at");
  assert.equal(valid?.schedule.at, "2026-03-08T08:00:00-08:00");
});

test("schedule intent module no longer embeds local keyword parsing tables", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "gateway", "schedule-intent.ts"), "utf-8");

  assert.doesNotMatch(source, /NEGATIVE_TASK_TERMS_ZH/);
  assert.doesNotMatch(source, /ACTION_PREFIXES_ZH/);
  assert.doesNotMatch(source, /ZH_DAILY_PATTERN/);
  assert.doesNotMatch(source, /parseZhTimePrefix/);
});

test("chat assistant uses model-based schedule extraction", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "gateway", "chat-assistant.ts"), "utf-8");

  assert.match(source, /extractScheduleIntentWithModel/);
  assert.doesNotMatch(source, /parseScheduleIntentInput\(/);
});
