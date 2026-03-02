import assert from "node:assert/strict";
import test from "node:test";

const { normalizeAction } = await import("../dist/agent/actions.js");

test("normalizeAction handles invalid payload", () => {
  const out = normalizeAction(null);
  assert.equal(out.type, "wait");
  assert.match(out.reason, /invalid action payload/);
});

test("normalizeAction converts numeric fields for tap/swipe/drag/long_press_drag", () => {
  const tap = normalizeAction({ type: "tap", x: "12", y: "34" });
  assert.deepEqual(tap, { type: "tap", x: 12, y: 34, reason: undefined });

  const swipe = normalizeAction({
    type: "swipe",
    x1: "1",
    y1: "2",
    x2: "3",
    y2: "4",
    durationMs: "500",
  });
  assert.equal(swipe.type, "swipe");
  assert.equal(swipe.durationMs, 500);

  const drag = normalizeAction({
    type: "drag",
    x1: "11",
    y1: "22",
    x2: "33",
    y2: "44",
    durationMs: "480",
  });
  assert.equal(drag.type, "drag");
  assert.equal(drag.durationMs, 480);

  const longPressDrag = normalizeAction({
    type: "long_press_drag",
    x1: "10",
    y1: "20",
    x2: "30",
    y2: "40",
    holdMs: "700",
    durationMs: "260",
  });
  assert.equal(longPressDrag.type, "long_press_drag");
  assert.equal(longPressDrag.holdMs, 700);
  assert.equal(longPressDrag.durationMs, 260);
});

test("normalizeAction sets defaults for run_script and finish", () => {
  const runScript = normalizeAction({ type: "run_script", script: "echo hi" });
  assert.equal(runScript.type, "run_script");
  assert.equal(runScript.timeoutSec, 60);

  const finish = normalizeAction({ type: "finish" });
  assert.equal(finish.type, "finish");
  assert.equal(finish.message, "Task finished.");
});

test("normalizeAction supports request_human_auth with defaults", () => {
  const request = normalizeAction({
    type: "request_human_auth",
    capability: "camera",
    instruction: "Please capture a photo to continue.",
    uiTemplate: {
      templateId: "camera-photo",
      title: "Camera Auth",
      allowPhotoAttachment: true,
    },
    templatePath: "human-auth/templates/camera.json",
  });
  assert.equal(request.type, "request_human_auth");
  assert.equal(request.capability, "camera");
  assert.equal(request.timeoutSec, 300);
  assert.equal(request.uiTemplate?.templateId, "camera-photo");
  assert.equal(request.uiTemplate?.allowPhotoAttachment, true);
  assert.equal(request.templatePath, "human-auth/templates/camera.json");

  const fallback = normalizeAction({
    type: "request_human_auth",
    capability: "not-supported",
  });
  assert.equal(fallback.type, "request_human_auth");
  assert.equal(fallback.capability, "unknown");
  assert.match(fallback.instruction, /Human authorization is required/);
});

test("normalizeAction supports request_user_input with defaults", () => {
  const request = normalizeAction({
    type: "request_user_input",
    question: "Please share your vehicle plate number.",
    placeholder: "ABC-1234",
  });
  assert.equal(request.type, "request_user_input");
  assert.equal(request.question, "Please share your vehicle plate number.");
  assert.equal(request.placeholder, "ABC-1234");
  assert.equal(request.timeoutSec, 300);

  const fallback = normalizeAction({
    type: "request_user_input",
    instruction: "请输入车辆信息",
    placeholder: "   ",
  });
  assert.equal(fallback.type, "request_user_input");
  assert.equal(fallback.question, "请输入车辆信息");
  assert.equal(fallback.placeholder, undefined);
  assert.equal(fallback.timeoutSec, 300);
});

test("normalizeAction falls back for unknown action", () => {
  const out = normalizeAction({ type: "unknown_x" });
  assert.equal(out.type, "wait");
  assert.match(out.reason, /unknown action type/);
});

test("normalizeAction supports memory tools with defaults", () => {
  const search = normalizeAction({ type: "memory_search", query: "weather preferences" });
  assert.equal(search.type, "memory_search");
  assert.equal(search.query, "weather preferences");
  assert.equal(search.maxResults, 6);
  assert.equal(search.minScore, 0.2);

  const get = normalizeAction({ type: "memory_get", path: "memory/2026-02-22.md" });
  assert.equal(get.type, "memory_get");
  assert.equal(get.path, "memory/2026-02-22.md");
  assert.equal(get.from, 1);
  assert.equal(get.lines, 120);
});

test("normalizeAction supports shell wrapping flag", () => {
  const shell = normalizeAction({
    type: "shell",
    command: "echo hello && echo world",
    useShellWrap: true,
  });
  assert.equal(shell.type, "shell");
  assert.equal(shell.command, "echo hello && echo world");
  assert.equal(shell.useShellWrap, true);
});

test("normalizeAction supports batch_actions", () => {
  const batch = normalizeAction({
    type: "batch_actions",
    actions: [
      { type: "tap", x: "12", y: "24" },
      { type: "drag", x1: "12", y1: "24", x2: "30", y2: "40", durationMs: "420" },
      { type: "type_text", text: "hello" },
      { type: "wait", durationMs: "250" },
    ],
  });
  assert.equal(batch.type, "batch_actions");
  assert.equal(batch.actions.length, 4);
  assert.deepEqual(batch.actions[0], { type: "tap", x: 12, y: 24, reason: undefined });
  assert.deepEqual(batch.actions[1], { type: "drag", x1: 12, y1: 24, x2: 30, y2: 40, durationMs: 420, reason: undefined });
  assert.deepEqual(batch.actions[2], { type: "type", text: "hello", reason: undefined });
  assert.deepEqual(batch.actions[3], { type: "wait", durationMs: 250, reason: undefined });
});
