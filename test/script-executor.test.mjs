import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { ScriptExecutor } = await import("../dist/tools/script-executor.js");

test("ScriptExecutor executes allowed commands", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-script-ok-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();
  const exec = new ScriptExecutor(cfg);

  const result = await exec.execute("echo hello_openpocket");
  assert.equal(result.ok, true, result.stderr);
  assert.match(result.stdout, /hello_openpocket/);
  assert.equal(fs.existsSync(path.join(result.runDir, "result.json")), true);
});

test("ScriptExecutor blocks commands outside allowlist", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-script-deny-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();
  const exec = new ScriptExecutor(cfg);

  const result = await exec.execute("date");
  assert.equal(result.ok, false);
  assert.match(result.stderr, /not allowed/i);
});
