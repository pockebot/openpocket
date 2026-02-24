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

function markdownPathFromTranscriptPath(sessionPath) {
  return sessionPath.replace(/\.jsonl$/i, ".md");
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/g)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function collectText(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => (item && typeof item === "object" && item.type === "text" ? String(item.text ?? "") : ""))
    .join("\n");
}

test("WorkspaceStore defaults to OpenClaw store + pi tree transcript + markdown log", async () => {
  await withTempHome("openpocket-session-backend-default-", () => {
    const cfg = loadConfig();
    assert.equal(cfg.sessionStorage.mode, "unified");
    assert.equal(cfg.sessionStorage.markdownLog, true);

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

    assert.equal(session.path.endsWith(".jsonl"), true);
    assert.equal(fs.existsSync(session.path), true);

    const transcriptLines = readJsonl(session.path);
    assert.equal(transcriptLines[0].type, "session");
    assert.equal(Number(transcriptLines[0].version), 3);

    const messageEntries = transcriptLines.filter((entry) => entry.type === "message");
    assert.equal(messageEntries.length >= 3, true);
    assert.equal(messageEntries[0].parentId, null);
    for (let i = 1; i < messageEntries.length; i += 1) {
      assert.equal(messageEntries[i].parentId, messageEntries[i - 1].id);
    }

    const messageTexts = messageEntries.map((entry) => collectText(entry.message));
    assert.equal(messageTexts.some((text) => text.includes("default output test")), true);
    assert.equal(messageTexts.some((text) => text === "done"), true);

    const markdownPath = markdownPathFromTranscriptPath(session.path);
    assert.equal(fs.existsSync(markdownPath), true);

    assert.equal(fs.existsSync(cfg.sessionStorage.storePath), true);
    const sessionsStore = JSON.parse(fs.readFileSync(cfg.sessionStorage.storePath, "utf-8"));
    assert.equal(sessionsStore[session.id].sessionId, session.id);
    assert.equal(sessionsStore[session.id].sessionFile, session.path);
    assert.equal(typeof sessionsStore[session.id].updatedAt, "number");
  });
});

test("WorkspaceStore markdownLog=false disables markdown sidecar but keeps pi tree transcript", async () => {
  await withTempHome("openpocket-session-backend-no-md-", () => {
    const cfg = loadConfig();
    cfg.sessionStorage.markdownLog = false;

    const store = new WorkspaceStore(cfg);
    const session = store.createSession("pi-only output test", "gpt-5.2-codex", "gpt-5.2-codex");
    store.appendStep(
      session,
      1,
      "tap search",
      JSON.stringify({ type: "tap", x: 12, y: 34 }),
      "Tapped at (12,34)",
    );
    store.finalizeSession(session, true, "done");

    assert.equal(fs.existsSync(session.path), true);
    assert.equal(session.path.endsWith(".jsonl"), true);
    assert.equal(readJsonl(session.path)[0].type, "session");

    const markdownPath = markdownPathFromTranscriptPath(session.path);
    assert.equal(fs.existsSync(markdownPath), false);

    const sessionsStore = JSON.parse(fs.readFileSync(cfg.sessionStorage.storePath, "utf-8"));
    assert.equal(sessionsStore[session.id].sessionId, session.id);
    assert.equal(sessionsStore[session.id].sessionFile, session.path);
  });
});
