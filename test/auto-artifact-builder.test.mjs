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

test("AutoArtifactBuilder emits strict-layout SKILL.md in strict skillsSpecMode", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-artifact-strict-"));
  const builder = new AutoArtifactBuilder({
    workspaceDir,
    agent: { skillsSpecMode: "strict" },
  });
  const out = builder.build({
    task: "Open YouTube and search latest OpenAI",
    sessionPath: "/tmp/session-strict.md",
    ok: true,
    finalMessage: "done",
    traces: [
      {
        step: 1,
        thought: "open app",
        currentApp: "launcher",
        action: { type: "launch_app", packageName: "com.google.android.youtube" },
        result: "ok",
      },
      {
        step: 2,
        thought: "wait",
        currentApp: "com.google.android.youtube",
        action: { type: "wait", durationMs: 1000 },
        result: "ok",
      },
    ],
  });

  assert.equal(out.skillPath !== null, true);
  assert.equal(out.scriptPath !== null, true);
  assert.match(out.skillPath, /skills[\\/]auto[\\/]\d{8}-\d{6}-open-youtube-and-search-latest-openai[\\/]SKILL\.md$/);

  const skillBody = fs.readFileSync(out.skillPath, "utf-8");
  assert.match(skillBody, /^---\n/m);
  assert.match(skillBody, /name:\s*[a-z0-9-]+/);
  assert.match(skillBody, /description:\s*"/);
  assert.match(skillBody, /# Skill Draft:/);
});

test("AutoArtifactBuilder rotates timestamped paths for repeated successful tasks", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-artifact-stable-path-"));
  const builder = new AutoArtifactBuilder({
    workspaceDir,
    agent: { skillsSpecMode: "strict" },
  });

  const first = builder.build({
    task: "Open maps and search coffee nearby",
    sessionPath: "/tmp/session-stable-1.md",
    ok: true,
    finalMessage: "first done",
    traces: [
      {
        step: 1,
        thought: "open maps",
        currentApp: "launcher",
        action: { type: "launch_app", packageName: "com.google.android.apps.maps" },
        result: "ok",
      },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const second = builder.build({
    task: "Open maps and search coffee nearby",
    sessionPath: "/tmp/session-stable-2.md",
    ok: true,
    finalMessage: "second done",
    traces: [
      {
        step: 1,
        thought: "open maps",
        currentApp: "launcher",
        action: { type: "launch_app", packageName: "com.google.android.apps.maps" },
        result: "ok",
      },
      {
        step: 2,
        thought: "wait",
        currentApp: "com.google.android.apps.maps",
        action: { type: "wait", durationMs: 1000 },
        result: "ok",
      },
    ],
  });

  assert.notEqual(first.skillPath, second.skillPath);
  assert.notEqual(first.scriptPath, second.scriptPath);
  assert.match(second.skillPath, /skills[\\/]auto[\\/]\d{8}-\d{6}-open-maps-and-search-coffee-nearby[\\/]SKILL\.md$/);
  assert.match(second.scriptPath, /scripts[\\/]auto[\\/]\d{8}-\d{6}-open-maps-and-search-coffee-nearby\.sh$/);
  assert.equal(fs.existsSync(second.skillPath), true);
  assert.equal(fs.existsSync(second.scriptPath), true);
  assert.equal(fs.existsSync(first.skillPath), false);
  assert.equal(fs.existsSync(first.scriptPath), false);

  const skillBody = fs.readFileSync(second.skillPath, "utf-8");
  assert.match(skillBody, /second done/);
});

test("AutoArtifactBuilder escapes ui_target fields in generated skill draft", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-artifact-ui-escape-"));
  const builder = new AutoArtifactBuilder({ workspaceDir });
  const uiText = "line1 \"quoted\"\nline2";
  const uiResourceId = "id/field<&>\"'";
  const uiContentDesc = "pick \"photo\" <now> & confirm";

  const out = builder.build({
    task: "open picker and confirm",
    sessionPath: "/tmp/session-ui.md",
    ok: true,
    finalMessage: "done",
    traces: [
      {
        step: 1,
        thought: "tap target",
        currentApp: "com.example",
        action: { type: "tap_element", elementId: "7", reason: "open picker" },
        result: "ok",
        uiContext: {
          elementId: "7",
          label: "Picker Button",
          text: uiText,
          resourceId: uiResourceId,
          contentDesc: uiContentDesc,
          className: "android.widget.TextView",
          clickable: true,
        },
      },
    ],
  });

  assert.equal(out.skillPath !== null, true);
  const skillBody = fs.readFileSync(out.skillPath, "utf-8");
  assert.match(skillBody, /ui_target:/);
  assert.match(skillBody, new RegExp(`text=${JSON.stringify(uiText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(skillBody, new RegExp(`resourceId=${JSON.stringify(uiResourceId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(skillBody, new RegExp(`contentDesc=${JSON.stringify(uiContentDesc).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(skillBody, /class="android\.widget\.TextView"/);
  assert.match(skillBody, /clickable=true/);
});
