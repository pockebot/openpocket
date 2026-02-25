import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { CodingExecutor } = await import("../dist/tools/coding-executor.js");

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

test("CodingExecutor contract: write/read/edit/apply_patch round-trip", async () => {
  await withTempHome("openpocket-coding-contract-", async () => {
    const cfg = loadConfig();
    const executor = new CodingExecutor(cfg);

    const target = "smoke_out/main.js";
    const initial = "console.log('dual-side-smoke-ok');\n";
    const updated = "console.log('dual-side-smoke-ok-v2');\n";

    const writeResult = await executor.execute({
      type: "write",
      thought: "contract",
      path: target,
      content: initial,
      append: false,
    });
    assert.match(writeResult, /write path=smoke_out\/main.js/);

    const readResult = await executor.execute({
      type: "read",
      thought: "contract",
      path: target,
      from: 1,
      lines: 20,
    });
    assert.match(readResult, /dual-side-smoke-ok/);

    const editResult = await executor.execute({
      type: "edit",
      thought: "contract",
      path: target,
      find: "dual-side-smoke-ok",
      replace: "dual-side-smoke-ok-v2",
      replaceAll: false,
    });
    assert.match(editResult, /replacements=1/);

    const patchResult = await executor.execute({
      type: "apply_patch",
      thought: "contract",
      input: [
        "*** Begin Patch",
        "*** Update File: smoke_out/main.js",
        "@@",
        `-${updated.trimEnd()}`,
        "+console.log('dual-side-smoke-ok-v3');",
        "*** End Patch",
      ].join("\n"),
    });
    assert.match(patchResult, /(Done!|Success\. Updated the following files)/i);

    const finalRead = await executor.execute({
      type: "read",
      thought: "contract",
      path: target,
      from: 1,
      lines: 20,
    });
    assert.match(finalRead, /dual-side-smoke-ok-v3/);
  });
});

test("CodingExecutor contract: exec background + process poll/log", async () => {
  await withTempHome("openpocket-coding-process-", async () => {
    const cfg = loadConfig();
    const executor = new CodingExecutor(cfg);

    const execResult = await executor.execute({
      type: "exec",
      thought: "contract",
      command: "node -e \"setTimeout(()=>{console.log('bg-ok')}, 10)\"",
      background: true,
      timeoutSec: 5,
    });
    assert.match(execResult, /exec started in background/);
    const sessionMatch = execResult.match(/session=([A-Za-z0-9-]+)/);
    assert.ok(sessionMatch, "background exec should return session id");
    const sessionId = sessionMatch[1];

    const pollResult = await executor.execute({
      type: "process",
      thought: "contract",
      action: "poll",
      sessionId,
      timeoutMs: 3000,
    });
    assert.match(pollResult, /session=/);
    assert.match(pollResult, /status=(completed|failed|timeout|killed)/);

    const logResult = await executor.execute({
      type: "process",
      thought: "contract",
      action: "log",
      sessionId,
      offset: 0,
      limit: 50,
    });
    assert.match(logResult, /process log session=/);
  });
});

test("CodingExecutor contract: blocks workspace escape and disallowed commands", async () => {
  await withTempHome("openpocket-coding-guard-", async () => {
    const cfg = loadConfig();
    const executor = new CodingExecutor(cfg);

    await assert.rejects(
      () => executor.execute({
        type: "write",
        thought: "contract",
        path: "../outside.txt",
        content: "should fail",
      }),
      /escapes workspace/i,
    );

    await assert.rejects(
      () => executor.execute({
        type: "exec",
        thought: "contract",
        command: "date",
      }),
      /not allowed/i,
    );

    await assert.rejects(
      () => executor.execute({
        type: "exec",
        thought: "contract",
        command: "rm -rf /",
      }),
      /blocked by safety rule/i,
    );
  });
});
