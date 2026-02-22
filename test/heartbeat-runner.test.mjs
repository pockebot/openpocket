import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../dist/config/index.js");
const { HeartbeatRunner } = require("../dist/gateway/heartbeat-runner.js");

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

test("HeartbeatRunner writes heartbeat log and warns on stuck task", () => {
  withTempHome("openpocket-heartbeat-", () => {
    const cfg = loadConfig();
    cfg.heartbeat.enabled = true;
    cfg.heartbeat.writeLogFile = true;
    cfg.heartbeat.stuckTaskWarnSec = 10;

    const logs = [];
    const runner = new HeartbeatRunner(cfg, {
      nowMs: () => 100_000,
      log: (line) => logs.push(line),
      readSnapshot: () => ({
        busy: true,
        currentTask: "run weather task",
        taskRuntimeMs: 15_000,
        devices: 1,
        bootedDevices: 1,
      }),
    });

    runner.runOnce();

    assert.equal(logs.some((line) => line.includes("[OpenPocket][heartbeat]")), true);
    assert.equal(logs.some((line) => line.includes("[OpenPocket][heartbeat][warn]")), true);

    const logFile = path.join(cfg.stateDir, "heartbeat.log");
    assert.equal(fs.existsSync(logFile), true);
    const rows = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    assert.equal(rows.length >= 1, true);
    const payload = JSON.parse(rows.at(-1));
    assert.equal(payload.busy, true);
    assert.equal(payload.runtimeSec, 15);
  });
});
