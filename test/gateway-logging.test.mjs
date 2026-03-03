import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { createGatewayLogEmitter } = await import("../dist/gateway/logging.js");

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

test("createGatewayLogEmitter suppresses disabled modules", () => {
  withTempHome("gateway-log-module-", () => {
    const cfg = loadConfig();
    const lines = [];
    const emit = createGatewayLogEmitter(cfg, [(line) => lines.push(line)]);

    emit("[OpenPocket][heartbeat][debug] 2026-03-03T00:00:00.000Z busy=true runtimeSec=6");
    emit("[OpenPocket][gateway-core][core][info] 2026-03-03T00:00:00.000Z gateway core started model=gpt-5.2-codex");

    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("gateway core started"), true);
  });
});

test("createGatewayLogEmitter enforces level threshold", () => {
  withTempHome("gateway-log-level-", () => {
    const cfg = loadConfig();
    cfg.gatewayLogging.level = "warn";

    const lines = [];
    const emit = createGatewayLogEmitter(cfg, [(line) => lines.push(line)]);

    emit("[OpenPocket][gateway-core][task][info] 2026-03-03T00:00:00.000Z task done ok=true");
    emit("[OpenPocket][gateway-core][task][warn] 2026-03-03T00:00:01.000Z task retry scheduled");

    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("[warn]"), true);
  });
});

test("createGatewayLogEmitter redacts payloads by default", () => {
  withTempHome("gateway-log-redact-", () => {
    const cfg = loadConfig();
    cfg.gatewayLogging.modules.task = true;
    cfg.gatewayLogging.level = "debug";

    const lines = [];
    const emit = createGatewayLogEmitter(cfg, [(line) => lines.push(line)]);

    emit('[OpenPocket][gateway-core][task][info] 2026-03-03T00:00:00.000Z task accepted task="open gmail and read inbox" path=/tmp/a.txt');

    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes('task=[hidden]'), true);
    assert.equal(lines[0].includes('path=[hidden]'), true);
  });
});

test("createGatewayLogEmitter keeps payload previews when enabled", () => {
  withTempHome("gateway-log-payload-", () => {
    const cfg = loadConfig();
    cfg.gatewayLogging.modules.task = true;
    cfg.gatewayLogging.level = "debug";
    cfg.gatewayLogging.includePayloads = true;
    cfg.gatewayLogging.maxPayloadChars = 40;

    const lines = [];
    const emit = createGatewayLogEmitter(cfg, [(line) => lines.push(line)]);

    emit('[OpenPocket][gateway-core][task][debug] 2026-03-03T00:00:00.000Z task accepted task="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"');

    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("task=[hidden]"), false);
    assert.equal(lines[0].includes("..."), true);
  });
});
