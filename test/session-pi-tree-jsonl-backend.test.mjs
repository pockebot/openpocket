import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { SessionPiTreeJsonlBackend } = await import("../dist/agent/session-pi-tree-jsonl-backend.js");

function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("SessionPiTreeJsonlBackend stores step/event/meta logs as custom entries (not custom messages)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-session-"));
  const sessionPath = path.join(tmpDir, "session-test.jsonl");
  const backend = new SessionPiTreeJsonlBackend();
  const now = new Date().toISOString();

  backend.create({
    sessionId: "s1",
    sessionPath,
    sessionKey: "k1",
    task: "hello",
    modelProfile: "profile",
    modelName: "model",
    startedAt: now,
  });

  backend.appendStep({
    sessionId: "s1",
    sessionPath,
    sessionKey: "k1",
    stepNo: 1,
    at: now,
    thought: "thinking",
    actionJson: "{\n  \"type\": \"tap\"\n}",
    result: "ok",
    trace: {
      actionType: "tap",
      currentApp: "com.example",
      startedAt: now,
      endedAt: now,
      durationMs: 1,
      status: "ok",
    },
  });

  backend.appendEvent({
    sessionId: "s1",
    sessionPath,
    sessionKey: "k1",
    at: now,
    eventType: "custom_event",
    details: { a: 1 },
    text: "event text",
  });

  const entries = readJsonl(sessionPath);

  const customMessages = entries.filter((entry) => (
    entry?.type === "message" && entry?.message?.role === "custom"
  ));
  assert.equal(customMessages.length, 0);

  const customEntries = entries.filter((entry) => entry?.type === "custom");
  assert.ok(customEntries.some((entry) => entry.customType === "openpocket_session_meta"));
  assert.ok(customEntries.some((entry) => entry.customType === "openpocket_step"));
  assert.ok(customEntries.some((entry) => entry.customType === "openpocket_action_trace"));
  assert.ok(customEntries.some((entry) => entry.customType === "openpocket_event"));
});

