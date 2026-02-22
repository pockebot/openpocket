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
