import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { WorkspaceStore } = await import("../dist/memory/workspace.js");

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

function jsonlPathFromSessionPath(sessionPath) {
  return sessionPath.replace(/\.md$/i, ".jsonl");
}

test("WorkspaceStore defaults to markdown session output only", async () => {
  await withTempHome("openpocket-session-backend-default-", () => {
    const cfg = loadConfig();
    assert.equal(cfg.sessionStorage.backend, "markdown");
    assert.equal(cfg.sessionStorage.dualWriteJsonl, false);

    const store = new WorkspaceStore(cfg);
    const session = store.createSession("default output test", "gpt-5.2-codex", "gpt-5.2-codex");
    store.appendStep(
      session,
      1,
      "collect state",
      JSON.stringify({ type: "wait", durationMs: 200 }),
      "Waited 200ms",
    );
    store.finalizeSession(session, true, "done");

    const jsonlPath = jsonlPathFromSessionPath(session.path);
    assert.equal(fs.existsSync(session.path), true);
    assert.equal(fs.existsSync(jsonlPath), false);
  });
});

test("WorkspaceStore dual-write mode emits markdown and jsonl transcripts", async () => {
  await withTempHome("openpocket-session-backend-dual-", () => {
    const cfg = loadConfig();
    cfg.sessionStorage.dualWriteJsonl = true;

    const store = new WorkspaceStore(cfg);
    const session = store.createSession("dual write output test", "gpt-5.2-codex", "gpt-5.2-codex");
    store.appendStep(
      session,
      1,
      "tap search",
      JSON.stringify({ type: "tap", x: 12, y: 34 }),
      "Tapped at (12,34)",
    );
    store.finalizeSession(session, true, "done");

    const jsonlPath = jsonlPathFromSessionPath(session.path);
    assert.equal(fs.existsSync(session.path), true);
    assert.equal(fs.existsSync(jsonlPath), true);

    const lines = fs.readFileSync(jsonlPath, "utf-8")
      .split(/\r?\n/g)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    assert.equal(lines.length, 3);
    assert.equal(lines[0].event, "session_started");
    assert.equal(lines[1].event, "step_appended");
    assert.equal(lines[2].event, "session_finalized");
    assert.equal(lines[0].sessionId, session.id);
    assert.equal(lines[2].status, "SUCCESS");
  });
});
