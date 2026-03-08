import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { CronRegistry } = await import("../dist/gateway/cron-registry.js");

async function withTempHome(prefix, fn) {
  const prev = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENPOCKET_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prev;
    }
  }
}

test("CronRegistry migrates legacy jobs into structured jobs", async () => {
  await withTempHome("openpocket-cron-registry-legacy-", async () => {
    const cfg = loadConfig();
    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
    fs.writeFileSync(
      jobsFile,
      `${JSON.stringify(
        {
          jobs: [
            {
              id: "job-a",
              name: "Job A",
              enabled: true,
              everySec: 10,
              task: "Open settings app and check Wi-Fi",
              chatId: 12345,
              model: "gpt-5.2-codex",
              runOnStartup: false,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    cfg.cron.jobsFile = jobsFile;

    const registry = new CronRegistry(cfg);
    const jobs = registry.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "job-a");
    assert.equal(jobs[0].schedule.kind, "every");
    assert.equal(jobs[0].schedule.everyMs, 10_000);
    assert.equal(jobs[0].payload.kind, "agent_turn");
    assert.equal(jobs[0].payload.task, "Open settings app and check Wi-Fi");
    assert.equal(jobs[0].delivery?.channel, "telegram");
    assert.equal(jobs[0].delivery?.to, "12345");
    assert.equal(jobs[0].model, "gpt-5.2-codex");
    assert.equal(jobs[0].createdBy, "legacy_migration");
  });
});

test("CronRegistry add update remove and duplicate id enforcement work with the new schema", async () => {
  await withTempHome("openpocket-cron-registry-new-", async () => {
    const cfg = loadConfig();
    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.writeFileSync(jobsFile, `${JSON.stringify({ version: 2, jobs: [] }, null, 2)}\n`, "utf-8");
    cfg.cron.jobsFile = jobsFile;
    const registry = new CronRegistry(cfg);

    const created = registry.add({
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
        to: "chat-1",
      },
      model: "gpt-5.2-codex",
      promptMode: "minimal",
      createdBy: "telegram:user-1",
      sourceChannel: "telegram",
      sourcePeerId: "chat-1",
    });

    assert.equal(created.id, "daily-slack-checkin");
    assert.equal(created.createdAt.length > 0, true);
    assert.equal(created.updatedAt.length > 0, true);
    assert.equal(registry.list().length, 1);

    assert.throws(() => {
      registry.add({
        id: "daily-slack-checkin",
        name: "duplicate",
        enabled: true,
        schedule: {
          kind: "cron",
          expr: "0 9 * * *",
          at: null,
          everyMs: null,
          tz: "Asia/Shanghai",
          summaryText: "Daily 09:00",
        },
        payload: { kind: "agent_turn", task: "Duplicate" },
        delivery: null,
        model: null,
      });
    }, /already exists/i);

    const updated = registry.update("daily-slack-checkin", {
      enabled: false,
      name: "Updated Slack Check-in",
    });
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.name, "Updated Slack Check-in");

    const saved = JSON.parse(fs.readFileSync(jobsFile, "utf-8"));
    assert.equal(saved.version, 2);
    assert.equal(saved.jobs.length, 1);
    assert.equal(saved.jobs[0].payload.kind, "agent_turn");
    assert.equal(saved.jobs[0].delivery.channel, "telegram");

    assert.equal(registry.remove("daily-slack-checkin"), true);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.remove("daily-slack-checkin"), false);
  });
});

test("CronRegistry rejects invalid everyMs payloads instead of storing NaN", async () => {
  await withTempHome("openpocket-cron-registry-invalid-interval-", async () => {
    const cfg = loadConfig();
    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.writeFileSync(jobsFile, `${JSON.stringify({ version: 2, jobs: [] }, null, 2)}\n`, "utf-8");
    cfg.cron.jobsFile = jobsFile;

    const registry = new CronRegistry(cfg);
    assert.throws(() => {
      registry.add({
        id: "bad-every-job",
        name: "Bad Every Job",
        enabled: true,
        schedule: {
          kind: "every",
          expr: null,
          at: null,
          everyMs: "oops",
          tz: "UTC",
          summaryText: "broken",
        },
        payload: {
          kind: "agent_turn",
          task: "Do something",
        },
        delivery: null,
        model: null,
      });
    }, /invalid cron job/i);

    const saved = JSON.parse(fs.readFileSync(jobsFile, "utf-8"));
    assert.deepEqual(saved.jobs, []);
  });
});

test("CronRegistry fails fast on invalid jobs file contents", async () => {
  await withTempHome("openpocket-cron-registry-invalid-file-", async () => {
    const cfg = loadConfig();
    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.writeFileSync(jobsFile, "{not valid json", "utf-8");
    cfg.cron.jobsFile = jobsFile;

    const registry = new CronRegistry(cfg);
    assert.throws(() => registry.list(), /invalid cron jobs file/i);
    assert.throws(() => {
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
        delivery: null,
        model: null,
      });
    }, /invalid cron jobs file/i);
  });
});

test("CronRegistry fails fast when any individual stored job is invalid", async () => {
  await withTempHome("openpocket-cron-registry-invalid-entry-", async () => {
    const cfg = loadConfig();
    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.writeFileSync(
      jobsFile,
      `${JSON.stringify(
        {
          version: 2,
          jobs: [
            {
              id: "ok-job",
              name: "OK Job",
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
              delivery: null,
              model: null,
              createdAt: "2026-03-07T00:00:00.000Z",
              updatedAt: "2026-03-07T00:00:00.000Z",
            },
            {
              id: "bad-job",
              name: "Bad Job",
              enabled: true,
              schedule: {
                kind: "every",
                expr: null,
                at: null,
                everyMs: "oops",
                tz: "UTC",
                summaryText: "broken",
              },
              payload: {
                kind: "agent_turn",
                task: "broken",
              },
              delivery: null,
              model: null,
              createdAt: "2026-03-07T00:00:00.000Z",
              updatedAt: "2026-03-07T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    cfg.cron.jobsFile = jobsFile;

    const registry = new CronRegistry(cfg);
    assert.throws(() => registry.list(), /invalid cron jobs file/i);
  });
});

test("workspace bootstrap writes the new cron schema guidance and example job", async () => {
  await withTempHome("openpocket-cron-registry-workspace-", async () => {
    const cfg = loadConfig();

    const cronReadme = fs.readFileSync(path.join(cfg.workspaceDir, "cron", "README.md"), "utf-8");
    const cronJobs = JSON.parse(fs.readFileSync(path.join(cfg.workspaceDir, "cron", "jobs.json"), "utf-8"));

    assert.match(cronReadme, /OpenPocket manages `jobs\.json`/i);
    assert.match(cronReadme, /schedule\.kind/);
    assert.equal(Array.isArray(cronJobs.jobs), true);
    assert.equal(cronJobs.version, 2);
    assert.equal(cronJobs.jobs[0].payload.kind, "agent_turn");
    assert.equal(typeof cronJobs.jobs[0].schedule.kind, "string");
  });
});
