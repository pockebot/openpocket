import assert from "node:assert/strict";
import test from "node:test";

const { createPiSessionBridge } = await import("../dist/agent/pi-session-bridge.js");
const { normalizePiSessionEvent } = await import("../dist/agent/pi-session-events.js");

function makeMockSession() {
  const listeners = new Set();
  const calls = {
    prompts: [],
    aborts: 0,
    disposes: 0,
  };

  const session = {
    sessionId: "session-bridge-test",
    sessionFile: "/tmp/session-bridge-test.jsonl",
    async prompt(text) {
      calls.prompts.push(text);
    },
    async abort() {
      calls.aborts += 1;
    },
    dispose() {
      calls.disposes += 1;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return { session, listeners, calls };
}

test("createPiSessionBridge builds bridge from injected createSession", async () => {
  const mock = makeMockSession();
  const captured = { options: null };
  const bridge = await createPiSessionBridge({
    createOptions: { cwd: "/tmp/openpocket-bridge-test" },
    createSession: async (options) => {
      captured.options = options;
      return {
        session: mock.session,
        extensionsResult: {
          extensions: [],
          commands: [],
          tools: [],
          shortcuts: [],
          errors: [],
        },
      };
    },
  });

  assert.equal(bridge.sessionId, "session-bridge-test");
  assert.equal(bridge.sessionFile, "/tmp/session-bridge-test.jsonl");
  assert.equal(captured.options.cwd, "/tmp/openpocket-bridge-test");
});

test("PiSessionBridge forwards prompt/abort/dispose to underlying session", async () => {
  const mock = makeMockSession();
  const bridge = await createPiSessionBridge({
    createSession: async () => ({
      session: mock.session,
      extensionsResult: {
        extensions: [],
        commands: [],
        tools: [],
        shortcuts: [],
        errors: [],
      },
    }),
  });

  await bridge.prompt("hello bridge");
  await bridge.abort();
  bridge.dispose();

  assert.deepEqual(mock.calls.prompts, ["hello bridge"]);
  assert.equal(mock.calls.aborts, 1);
  assert.equal(mock.calls.disposes, 1);
});

test("PiSessionBridge subscribeNormalized emits normalized event payload", async () => {
  const mock = makeMockSession();
  const bridge = await createPiSessionBridge({
    createSession: async () => ({
      session: mock.session,
      extensionsResult: {
        extensions: [],
        commands: [],
        tools: [],
        shortcuts: [],
        errors: [],
      },
    }),
  });

  const normalized = [];
  const unsubscribe = bridge.subscribeNormalized((event) => {
    normalized.push(event);
  });

  for (const listener of mock.listeners) {
    listener({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "abc",
      },
    });
    listener({
      type: "tool_execution_start",
      toolName: "read",
    });
    listener({
      type: "tool_execution_end",
      toolName: "read",
      isError: false,
    });
  }
  unsubscribe();

  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized[0], { type: "assistant_text_delta", delta: "abc" });
  assert.deepEqual(normalized[1], { type: "tool_execution_start", toolName: "read" });
  assert.deepEqual(normalized[2], { type: "tool_execution_end", toolName: "read", isError: false });
});

test("normalizePiSessionEvent returns null for unsupported message_update subtype", () => {
  const out = normalizePiSessionEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "unknown_delta",
      delta: "noop",
    },
  });
  assert.equal(out, null);
});
