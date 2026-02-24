import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { AutoArtifactBuilder } = await import("../dist/skills/auto-artifact-builder.js");

test("AutoArtifactBuilder returns null when task not successful", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-artifact-empty-"));
  const builder = new AutoArtifactBuilder({ workspaceDir });
  const out = builder.build({
    task: "do task",
    sessionPath: "/tmp/session.md",
    ok: false,
    finalMessage: "failed",
    traces: [],
  });
  assert.equal(out.skillPath, null);
  assert.equal(out.scriptPath, null);
});

test("AutoArtifactBuilder respects agent.autoArtifactsEnabled=false", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-artifact-disabled-"));
  const builder = new AutoArtifactBuilder({
    workspaceDir,
    agent: { autoArtifactsEnabled: false },
  });
  const out = builder.build({
    task: "do task",
    sessionPath: "/tmp/session.md",
    ok: true,
    finalMessage: "done",
    traces: [
      {
        step: 1,
        thought: "tap",
        currentApp: "launcher",
        action: { type: "tap", x: 10, y: 20 },
        result: "ok",
      },
    ],
  });
  assert.equal(out.skillPath, null);
  assert.equal(out.scriptPath, null);
});

test("AutoArtifactBuilder creates skill and script files", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-artifact-ok-"));
  const builder = new AutoArtifactBuilder({ workspaceDir });
  const out = builder.build({
    task: "search san francisco weather",
    sessionPath: "/tmp/session.md",
    ok: true,
    finalMessage: "done",
    traces: [
      {
        step: 1,
        thought: "open app",
        currentApp: "launcher",
        action: { type: "tap", x: 10, y: 20 },
        result: "ok",
      },
      {
        step: 2,
        thought: "type query",
        currentApp: "chrome",
        action: { type: "type", text: "san\u00a0francisco weather" },
        result: "ok",
      },
      {
        step: 3,
        thought: "wait",
        currentApp: "chrome",
        action: { type: "wait", durationMs: 1200 },
        result: "ok",
      },
    ],
  });

  assert.equal(out.skillPath !== null, true);
  assert.equal(out.scriptPath !== null, true);
  assert.equal(fs.existsSync(out.skillPath), true);
  assert.equal(fs.existsSync(out.scriptPath), true);

  const skillBody = fs.readFileSync(out.skillPath, "utf-8");
  assert.match(skillBody, /Skill Draft/);
  assert.match(skillBody, /Status: draft/);
  assert.match(skillBody, /Source session: \/tmp\/session\.md/);

  const scriptBody = fs.readFileSync(out.scriptPath, "utf-8");
  assert.match(scriptBody, /shell input tap 10 20/);
  assert.match(scriptBody, /cmd clipboard set text/);
  assert.match(scriptBody, /KEYCODE_PASTE/);
});
