import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { SessionPiTreeJsonlBackend } = await import("../dist/agent/session-pi-tree-jsonl-backend.js");
const {
  appendTaskJournalSnapshot,
  readLatestTaskJournalSnapshot,
} = await import("../dist/agent/journal/task-journal-store.js");

test("task journal store reads back latest snapshot from session custom entries", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-journal-"));
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

  const snapshot = {
    version: 1,
    task: "Find cheapest latte",
    runId: "run-1",
    updatedAt: now,
    todos: [{ id: "t1", text: "Compare 3 stores", status: "in_progress" }],
    evidence: [{ id: "e1", kind: "offer", title: "Paris Baguette cafe latte", fields: { price: 5.87 } }],
    artifacts: [{ id: "a1", kind: "file", value: "sessions/session-test.md", description: "debug log" }],
    progress: { milestones: ["search_started"], blockers: [] },
    completion: { status: "in_progress", missing: ["verify total with fees"] },
  };

  appendTaskJournalSnapshot(sessionPath, snapshot);

  const out = readLatestTaskJournalSnapshot(sessionPath);
  assert.deepEqual(out, snapshot);
});

