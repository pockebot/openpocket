import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { CronService } = await import("../dist/gateway/cron-service.js");

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

function waitMicrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("CronService executes due jobs and persists state", async () => {
  await withTempHome("openpocket-cron-", async () => {
    const cfg = loadConfig();
    cfg.cron.enabled = true;
    cfg.cron.tickSec = 1;

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
              chatId: null,
              model: null,
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

    let nowMs = 0;
    let tick = () => {};
    const runs = [];

    const service = new CronService(cfg, {
      nowMs: () => nowMs,
      setIntervalFn: (handler) => {
        tick = handler;
        return {};
      },
      clearIntervalFn: () => {},
      runTask: async (job) => {
        runs.push(job.id);
        return {
          accepted: true,
          ok: true,
          message: "ok",
        };
      },
      log: () => {},
    });

    service.start();
    await waitMicrotask();
    assert.deepEqual(runs, []);

    nowMs = 11_000;
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-a"]);

    nowMs = 15_000;
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-a"]);

    nowMs = 22_000;
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-a", "job-a"]);

    const statePath = path.join(cfg.stateDir, "cron-state.json");
    assert.equal(fs.existsSync(statePath), true);
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(typeof state.jobs["job-a"].lastRunAtMs, "number");
    assert.equal(state.jobs["job-a"].lastStatus, "ok");
  });
});

test("CronService still executes V2 every-schedule jobs via compatibility shim", async () => {
  await withTempHome("openpocket-cron-v2-", async () => {
    const cfg = loadConfig();
    cfg.cron.enabled = true;
    cfg.cron.tickSec = 1;

    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
    fs.writeFileSync(
      jobsFile,
      `${JSON.stringify(
        {
          version: 2,
          jobs: [
            {
              id: "job-v2",
              name: "Job V2",
              enabled: true,
              schedule: {
                kind: "every",
                expr: null,
                at: null,
                everyMs: 10_000,
                tz: "UTC",
                summaryText: "Every 10 seconds",
              },
              payload: {
                kind: "agent_turn",
                task: "Open settings app and check Wi-Fi",
              },
              delivery: {
                mode: "announce",
                channel: "telegram",
                to: "12345",
              },
              model: null,
              promptMode: "minimal",
              createdAt: "2026-03-07T00:00:00.000Z",
              updatedAt: "2026-03-07T00:00:00.000Z",
              createdBy: "test",
              sourceChannel: "telegram",
              sourcePeerId: "12345",
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

    let nowMs = 0;
    let tick = () => {};
    const runs = [];

    const service = new CronService(cfg, {
      nowMs: () => nowMs,
      setIntervalFn: (handler) => {
        tick = handler;
        return {};
      },
      clearIntervalFn: () => {},
      runTask: async (job) => {
        runs.push({ id: job.id, task: job.payload.task, deliveryTo: job.delivery?.to });
        return {
          accepted: true,
          ok: true,
          message: "ok",
        };
      },
      log: () => {},
    });

    service.start();
    await waitMicrotask();
    assert.deepEqual(runs, []);

    nowMs = 11_000;
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, [{ id: "job-v2", task: "Open settings app and check Wi-Fi", deliveryTo: "12345" }]);
  });
});

test("CronService falls back to a safe interval when legacy everySec is invalid", async () => {
  await withTempHome("openpocket-cron-invalid-legacy-", async () => {
    const cfg = loadConfig();
    cfg.cron.enabled = true;
    cfg.cron.tickSec = 1;

    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
    fs.writeFileSync(
      jobsFile,
      `${JSON.stringify(
        {
          jobs: [
            {
              id: "job-invalid",
              name: "Job Invalid",
              enabled: true,
              everySec: "oops",
              task: "Open settings app and check Wi-Fi",
              chatId: null,
              model: null,
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

    let nowMs = 0;
    let tick = () => {};
    const runs = [];

    const service = new CronService(cfg, {
      nowMs: () => nowMs,
      setIntervalFn: (handler) => {
        tick = handler;
        return {};
      },
      clearIntervalFn: () => {},
      runTask: async (job) => {
        runs.push(job.id);
        return {
          accepted: true,
          ok: true,
          message: "ok",
        };
      },
      log: () => {},
    });

    service.start();
    await waitMicrotask();
    assert.deepEqual(runs, []);

    nowMs = 61_000;
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-invalid"]);
  });
});

test("CronService executes cron-expression jobs on wall-clock schedule", async () => {
  await withTempHome("openpocket-cron-cronexpr-", async () => {
    const cfg = loadConfig();
    cfg.cron.enabled = true;
    cfg.cron.tickSec = 1;

    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
    fs.writeFileSync(
      jobsFile,
      `${JSON.stringify(
        {
          version: 2,
          jobs: [
            {
              id: "job-cron",
              name: "Job Cron",
              enabled: true,
              schedule: {
                kind: "cron",
                expr: "0 8 * * *",
                at: null,
                everyMs: null,
                tz: "UTC",
                summaryText: "Every day at 08:00 UTC",
              },
              payload: {
                kind: "agent_turn",
                task: "Open settings app and check Wi-Fi",
              },
              delivery: null,
              model: null,
              promptMode: "minimal",
              createdAt: "2026-03-07T00:00:00.000Z",
              updatedAt: "2026-03-07T00:00:00.000Z",
              createdBy: "test",
              sourceChannel: "telegram",
              sourcePeerId: "12345",
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

    let nowMs = Date.parse("2026-03-07T07:59:00.000Z");
    let tick = () => {};
    const runs = [];

    const service = new CronService(cfg, {
      nowMs: () => nowMs,
      setIntervalFn: (handler) => {
        tick = handler;
        return {};
      },
      clearIntervalFn: () => {},
      runTask: async (job) => {
        runs.push(job.id);
        return {
          accepted: true,
          ok: true,
          message: "ok",
        };
      },
      log: () => {},
    });

    service.start();
    await waitMicrotask();
    assert.deepEqual(runs, []);

    nowMs = Date.parse("2026-03-07T08:00:00.000Z");
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-cron"]);

    nowMs = Date.parse("2026-03-07T08:01:00.000Z");
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-cron"]);

    nowMs = Date.parse("2026-03-08T08:00:00.000Z");
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-cron", "job-cron"]);
  });
});

test("CronService executes a cron job when the tick lands just after the scheduled minute", async () => {
  await withTempHome("openpocket-cron-cronexpr-late-tick-", async () => {
    const cfg = loadConfig();
    cfg.cron.enabled = true;
    cfg.cron.tickSec = 10;

    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
    fs.writeFileSync(
      jobsFile,
      `${JSON.stringify(
        {
          version: 2,
          jobs: [
            {
              id: "job-cron-late-tick",
              name: "Job Cron Late Tick",
              enabled: true,
              schedule: {
                kind: "cron",
                expr: "0 8 * * *",
                at: null,
                everyMs: null,
                tz: "UTC",
                summaryText: "Every day at 08:00 UTC",
              },
              payload: {
                kind: "agent_turn",
                task: "Open settings app and check Wi-Fi",
              },
              delivery: null,
              model: null,
              promptMode: "minimal",
              createdAt: "2026-03-07T00:00:00.000Z",
              updatedAt: "2026-03-07T00:00:00.000Z",
              createdBy: "test",
              sourceChannel: "telegram",
              sourcePeerId: "12345",
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

    let nowMs = Date.parse("2026-03-07T07:59:55.000Z");
    let tick = () => {};
    const runs = [];

    const service = new CronService(cfg, {
      nowMs: () => nowMs,
      setIntervalFn: (handler) => {
        tick = handler;
        return {};
      },
      clearIntervalFn: () => {},
      runTask: async (job) => {
        runs.push(job.id);
        return {
          accepted: true,
          ok: true,
          message: "ok",
        };
      },
      log: () => {},
    });

    service.start();
    await waitMicrotask();
    assert.deepEqual(runs, []);

    nowMs = Date.parse("2026-03-07T08:00:05.000Z");
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-cron-late-tick"]);
  });
});

test("CronService computes next cron occurrence correctly across DST start", async () => {
  await withTempHome("openpocket-cron-dst-start-", async () => {
    const cfg = loadConfig();
    cfg.cron.enabled = true;
    cfg.cron.tickSec = 1;

    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
    fs.writeFileSync(
      jobsFile,
      `${JSON.stringify(
        {
          version: 2,
          jobs: [
            {
              id: "job-dst",
              name: "Job DST",
              enabled: true,
              schedule: {
                kind: "cron",
                expr: "5 18 * * *",
                at: null,
                everyMs: null,
                tz: "America/Los_Angeles",
                summaryText: "Every day at 18:05 Los Angeles time",
              },
              payload: {
                kind: "agent_turn",
                task: "Open settings app and check Wi-Fi",
              },
              delivery: null,
              model: null,
              promptMode: "minimal",
              createdAt: "2026-03-07T23:19:57.705Z",
              updatedAt: "2026-03-07T23:19:57.705Z",
              createdBy: "test",
              sourceChannel: "telegram",
              sourcePeerId: "12345",
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

    let nowMs = Date.parse("2026-03-08T04:59:07.577Z");
    let tick = () => {};

    const service = new CronService(cfg, {
      nowMs: () => nowMs,
      setIntervalFn: (handler) => {
        tick = handler;
        return {};
      },
      clearIntervalFn: () => {},
      runTask: async () => ({
        accepted: true,
        ok: true,
        message: "ok",
      }),
      log: () => {},
    });

    service.start();
    await waitMicrotask();

    const statePath = path.join(cfg.stateDir, "cron-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.jobs["job-dst"].nextRunAtMs, Date.parse("2026-03-09T01:05:00.000Z"));

    nowMs = Date.parse("2026-03-09T01:05:00.000Z");
    tick();
    await waitMicrotask();
  });
});

test("CronService executes one-shot at jobs only once", async () => {
  await withTempHome("openpocket-cron-at-", async () => {
    const cfg = loadConfig();
    cfg.cron.enabled = true;
    cfg.cron.tickSec = 1;

    const jobsFile = path.join(cfg.workspaceDir, "cron", "jobs.json");
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
    fs.writeFileSync(
      jobsFile,
      `${JSON.stringify(
        {
          version: 2,
          jobs: [
            {
              id: "job-at",
              name: "Job At",
              enabled: true,
              schedule: {
                kind: "at",
                expr: null,
                at: "2026-03-07T08:00:00.000Z",
                everyMs: null,
                tz: "UTC",
                summaryText: "2026-03-07 08:00 UTC",
              },
              payload: {
                kind: "agent_turn",
                task: "Open settings app and check Wi-Fi",
              },
              delivery: null,
              model: null,
              promptMode: "minimal",
              createdAt: "2026-03-07T00:00:00.000Z",
              updatedAt: "2026-03-07T00:00:00.000Z",
              createdBy: "test",
              sourceChannel: "telegram",
              sourcePeerId: "12345",
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

    let nowMs = Date.parse("2026-03-07T07:59:00.000Z");
    let tick = () => {};
    const runs = [];

    const service = new CronService(cfg, {
      nowMs: () => nowMs,
      setIntervalFn: (handler) => {
        tick = handler;
        return {};
      },
      clearIntervalFn: () => {},
      runTask: async (job) => {
        runs.push(job.id);
        return {
          accepted: true,
          ok: true,
          message: "ok",
        };
      },
      log: () => {},
    });

    service.start();
    await waitMicrotask();
    assert.deepEqual(runs, []);

    nowMs = Date.parse("2026-03-07T08:00:00.000Z");
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-at"]);

    nowMs = Date.parse("2026-03-07T09:00:00.000Z");
    tick();
    await waitMicrotask();
    assert.deepEqual(runs, ["job-at"]);
  });
});
