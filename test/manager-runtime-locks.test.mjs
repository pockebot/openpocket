import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  acquireGatewayRuntimeLock,
  readGatewayRuntimeLock,
  releaseGatewayRuntimeLock,
  acquireTargetRuntimeLock,
  readTargetRuntimeLock,
  releaseTargetRuntimeLock,
} = await import("../dist/manager/runtime-locks.js");

async function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENPOCKET_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("runtime lock helpers acquire, read, and release gateway/target locks", async () => {
  await withTempHome("openpocket-runtime-locks-", async (home) => {
    const stateDir = path.join(home, "agent-state");
    const targetFingerprint = "physical-phone:DEVICE-123";

    const gatewayLock = acquireGatewayRuntimeLock({
      agentId: "alpha",
      stateDir,
      configPath: path.join(home, "config.json"),
      targetFingerprint,
    });
    assert.equal(gatewayLock.agentId, "alpha");
    assert.equal(Boolean(readGatewayRuntimeLock(stateDir)), true);

    const targetLock = acquireTargetRuntimeLock({
      agentId: "alpha",
      configPath: path.join(home, "config.json"),
      targetFingerprint,
    });
    assert.equal(targetLock.targetFingerprint, targetFingerprint);
    assert.equal(Boolean(readTargetRuntimeLock(targetFingerprint)), true);

    releaseGatewayRuntimeLock(stateDir);
    releaseTargetRuntimeLock(targetFingerprint);
    assert.equal(readGatewayRuntimeLock(stateDir), null);
    assert.equal(readTargetRuntimeLock(targetFingerprint), null);
  });
});
