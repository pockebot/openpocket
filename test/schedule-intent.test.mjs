import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const {
  inferScheduleIntentLocale,
  normalizeScheduleIntentCandidate,
} = await import("../dist/gateway/schedule-intent.js");

test("schedule intent normalization builds confirmation from model output", () => {
  assert.equal(inferScheduleIntentLocale("每天早上 8 点帮我打开 Slack"), "zh");

  const intent = normalizeScheduleIntentCandidate("每天早上 8 点帮我打开 Slack 去打卡", {
    isScheduleIntent: true,
    task: "打开 Slack 去打卡",
    schedule: {
      kind: "cron",
      expr: "0 8 * * *",
      summaryText: "每天 08:00",
    },
  }, {
    timezone: "Asia/Shanghai",
  });

  assert.ok(intent);
  assert.equal(intent?.schedule.kind, "cron");
  assert.equal(intent?.schedule.expr, "0 8 * * *");
  assert.equal(intent?.schedule.summaryText, "每天 08:00");
  assert.match(intent?.confirmationPrompt ?? "", /确认/);
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
