import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { WorkspaceStore } = await import("../dist/memory/workspace.js");
const { normalizePiSessionEvent } = await import("../dist/agent/pi-session-events.js");

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

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf-8")
    .split(/\r?\n/g)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test("normalizePiSessionEvent extracts text from tool_execution_update.partialResult", () => {
  const event = normalizePiSessionEvent({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "exec",
    args: { command: "pwd" },
    partialResult: {
      content: [
        { type: "text", text: "line-1\n" },
        { type: "text", text: "line-2\n" },
      ],
    },
  });

  assert.deepEqual(event, {
    type: "tool_execution_update",
    toolName: "exec",
    toolCallId: "call-1",
    args: { command: "pwd" },
    text: "line-1\nline-2\n",
  });
});

test("WorkspaceStore appends normalized runtime events into unified session jsonl", async () => {
  await withTempHome("openpocket-session-event-unification-", () => {
    const cfg = loadConfig();
    const store = new WorkspaceStore(cfg);

    const session = store.createSession(
      "event unification smoke",
      "gpt-5.2-codex",
      "gpt-5.2-codex",
    );

    store.appendEvent(
      session,
      "tool_execution_start",
      {
        toolCallId: "call-evt-1",
        toolName: "write",
        args: { path: "smoke_out/main.js" },
      },
      "tool_execution_start write",
    );

    store.appendEvent(
      session,
      "tool_execution_end",
      {
        toolCallId: "call-evt-1",
        toolName: "write",
        isError: false,
      },
      "tool_execution_end write",
    );

    store.finalizeSession(session, true, "done");
    const entries = readJsonl(session.path);
    const customEvents = entries.filter((entry) => (
      entry.type === "custom" && entry.customType === "openpocket_event"
    ));

    assert.equal(customEvents.length >= 2, true);
    assert.equal(customEvents[0].data.details.eventType, "tool_execution_start");
    assert.equal(customEvents[0].data.details.toolCallId, "call-evt-1");
    assert.equal(customEvents[0].data.details.toolName, "write");
    assert.equal(customEvents[1].data.details.eventType, "tool_execution_end");
    assert.equal(customEvents[1].data.details.isError, false);
  });
});
