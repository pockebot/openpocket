import assert from "node:assert/strict";
import test from "node:test";

const {
  ANDROID_CUSTOM_TOOL_NAMES,
  createAndroidCustomTools,
  ensureAndroidCustomToolNames,
} = await import("../dist/agent/android-custom-tools.js");

function toolByName(tools, name) {
  const hit = tools.find((tool) => tool.name === name);
  assert.ok(hit, `missing tool ${name}`);
  return hit;
}

test("ensureAndroidCustomToolNames appends all android custom tool names", () => {
  const merged = ensureAndroidCustomToolNames(["read", "write", "read"]);
  assert.ok(Array.isArray(merged));
  assert.ok(merged.includes("read"));
  assert.ok(merged.includes("write"));
  for (const name of ANDROID_CUSTOM_TOOL_NAMES) {
    assert.ok(merged.includes(name), `missing merged android tool ${name}`);
  }
});

test("createAndroidCustomTools routes calls through AdbRuntime and triggers state-change hook", async () => {
  const calls = [];
  const stateChanges = [];
  const adb = {
    executeAction: async (action, preferredDeviceId) => {
      calls.push({ action, preferredDeviceId });
      return `ok:${action.type}`;
    },
  };

  const tools = createAndroidCustomTools({
    adb,
    preferredDeviceId: "emulator-5554",
    onStateChange: async (event) => {
      stateChanges.push(event);
    },
  });

  const tapResult = await toolByName(tools, "tap").execute("t1", {
    thought: "tap test",
    x: 100,
    y: 200,
  });
  const typeResult = await toolByName(tools, "type_text").execute("t2", {
    thought: "type test",
    text: "hello",
  });
  const dragResult = await toolByName(tools, "drag").execute("t2.5", {
    thought: "drag test",
    x1: 200,
    y1: 300,
    x2: 500,
    y2: 800,
    durationMs: 450,
  });
  const shellResult = await toolByName(tools, "shell").execute("t3", {
    thought: "shell test",
    command: "echo hello && echo world",
    useShellWrap: true,
  });

  assert.equal(tapResult.details.ok, true);
  assert.match(tapResult.content[0].text, /ok:tap/);
  assert.equal(typeResult.details.actionType, "type");
  assert.equal(dragResult.details.actionType, "drag");
  assert.equal(shellResult.details.actionType, "shell");

  assert.equal(calls.length, 4);
  assert.equal(calls[0].action.type, "tap");
  assert.equal(calls[1].action.type, "type");
  assert.equal(calls[2].action.type, "drag");
  assert.equal(calls[3].action.type, "shell");
  assert.equal(calls[3].action.useShellWrap, true);
  assert.equal(calls[3].preferredDeviceId, "emulator-5554");

  assert.equal(stateChanges.length, 4);
  assert.equal(stateChanges[0].action.type, "tap");
  assert.equal(stateChanges[2].action.type, "drag");
  assert.equal(stateChanges[3].action.type, "shell");
  assert.equal(stateChanges[3].output, "ok:shell");
});

test("createAndroidCustomTools normalizes error result surface", async () => {
  let stateHookCalled = false;
  const adb = {
    executeAction: async () => {
      throw new Error("simulated adb failure");
    },
  };
  const tools = createAndroidCustomTools({
    adb,
    onStateChange: async () => {
      stateHookCalled = true;
    },
  });

  const result = await toolByName(tools, "swipe").execute("t-err", {
    thought: "swipe test",
    x1: 1,
    y1: 2,
    x2: 3,
    y2: 4,
    durationMs: 500,
  });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.actionType, "swipe");
  assert.match(result.content[0].text, /Action execution error: simulated adb failure/);
  assert.equal(stateHookCalled, false);
});
