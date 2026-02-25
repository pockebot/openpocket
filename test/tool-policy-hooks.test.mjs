import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { PiCodingToolsExecutor } = await import("../dist/agent/pi-coding-tools.js");
const { CodingExecutor } = await import("../dist/tools/coding-executor.js");
const { ScriptExecutor } = await import("../dist/tools/script-executor.js");

async function withTempHome(prefix, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prevHome = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("tool policy applies consistent allow/deny behavior across coding backends", async () => {
  await withTempHome("openpocket-policy-align-", async () => {
    const cfg = loadConfig();
    cfg.codingTools.allowedCommands = ["echo"];
    cfg.scriptExecutor.allowedCommands = ["echo"];

    const coding = new CodingExecutor(cfg);
    const piCoding = new PiCodingToolsExecutor(cfg);
    const script = new ScriptExecutor(cfg);

    await assert.rejects(
      () => coding.execute({ type: "exec", command: "date" }),
      /codingTools\.allowedCommands/i,
    );
    await assert.rejects(
      () => piCoding.execute({ type: "exec", command: "date" }),
      /codingTools\.allowedCommands/i,
    );

    const scriptDenied = await script.execute("date");
    assert.equal(scriptDenied.ok, false);
    assert.match(scriptDenied.stderr, /scriptExecutor\.allowedCommands/i);

    await assert.rejects(
      () => coding.execute({ type: "exec", command: "echo $(pwd)" }),
      /blocked by safety rule/i,
    );
    await assert.rejects(
      () => piCoding.execute({ type: "exec", command: "echo $(pwd)" }),
      /blocked by safety rule/i,
    );

    const scriptBlocked = await script.execute("echo $(pwd)");
    assert.equal(scriptBlocked.ok, false);
    assert.match(scriptBlocked.stderr, /blocked by safety rule/i);
  });
});

test("tool policy supports wildcard allowlist in both coding and script executors", async () => {
  await withTempHome("openpocket-policy-wildcard-", async () => {
    const cfg = loadConfig();
    cfg.codingTools.allowedCommands = ["*"];
    cfg.scriptExecutor.allowedCommands = ["*"];

    const coding = new CodingExecutor(cfg);
    const script = new ScriptExecutor(cfg);

    const codingOut = await coding.execute({
      type: "exec",
      command: "mkdir -p smoke_out/policy && echo wildcard-coding",
    });
    assert.match(codingOut, /wildcard-coding/);

    const scriptOut = await script.execute("mkdir -p smoke_out/policy_script && echo wildcard-script");
    assert.equal(scriptOut.ok, true, scriptOut.stderr);
    assert.match(scriptOut.stdout, /wildcard-script/);
  });
});

test("tool policy strips sensitive env vars for coding and script command execution", async () => {
  await withTempHome("openpocket-policy-env-", async () => {
    const prevOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "tool-policy-secret-value";
    try {
      const cfg = loadConfig();
      cfg.codingTools.allowedCommands = ["node"];
      cfg.scriptExecutor.allowedCommands = ["node"];

      const coding = new CodingExecutor(cfg);
      const script = new ScriptExecutor(cfg);

      const codingOut = await coding.execute({
        type: "exec",
        command:
          "node -e \"process.stdout.write(String(process.env.OPENAI_API_KEY===undefined?'none':process.env.OPENAI_API_KEY))\"",
      });
      assert.match(codingOut, /none/);

      const scriptOut = await script.execute(
        "node -e \"process.stdout.write(String(process.env.OPENAI_API_KEY===undefined?'none':process.env.OPENAI_API_KEY))\"",
      );
      assert.equal(scriptOut.ok, true, scriptOut.stderr);
      assert.match(scriptOut.stdout, /none/);
    } finally {
      if (prevOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prevOpenAi;
      }
    }
  });
});

test("workspace boundary checks remain enforced across coding paths", async () => {
  await withTempHome("openpocket-policy-workspace-", async () => {
    const cfg = loadConfig();
    cfg.codingTools.allowedCommands = ["echo"];

    const coding = new CodingExecutor(cfg);
    const piCoding = new PiCodingToolsExecutor(cfg);

    await assert.rejects(
      () => coding.execute({ type: "write", path: "../escape.txt", content: "nope" }),
      /escapes workspace/i,
    );
    const piWrite = await piCoding.execute({ type: "write", path: "../escape.txt", content: "nope" });
    assert.equal(piWrite, null);

    await assert.rejects(
      () => coding.execute({ type: "exec", command: "echo ok", workdir: "../" }),
      /workdir escapes workspace/i,
    );
    const piExec = await piCoding.execute({ type: "exec", command: "echo ok", workdir: "../" });
    assert.equal(piExec, null);
  });
});
