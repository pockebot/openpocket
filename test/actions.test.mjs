import assert from "node:assert/strict";
import test from "node:test";

const { normalizeAction } = await import("../dist/agent/actions.js");

test("normalizeAction handles invalid payload", () => {
  const out = normalizeAction(null);
  assert.equal(out.type, "wait");
  assert.match(out.reason, /invalid action payload/);
});

test("normalizeAction converts numeric fields for tap/swipe", () => {
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
  });
  assert.equal(request.type, "request_human_auth");
  assert.equal(request.capability, "camera");
  assert.equal(request.timeoutSec, 300);

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
