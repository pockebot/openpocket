import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  ensureWorkspaceBootstrap,
  isWorkspaceOnboardingCompleted,
  markWorkspaceOnboardingCompleted,
  WorkspaceStore,
} = await import("../dist/memory/workspace.js");

test("ensureWorkspaceBootstrap creates required layout", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-workspace-bootstrap-"));
  ensureWorkspaceBootstrap(workspaceDir);

  const required = [
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "IDENTITY.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "MEMORY.md",
    "BOOTSTRAP.md",
    "TASK_PROGRESS_REPORTER.md",
    "TASK_OUTCOME_REPORTER.md",
    "BARE_SESSION_RESET_PROMPT.md",
    "PROFILE_ONBOARDING.json",
    path.join(".openpocket", "workspace-state.json"),
    path.join("memory", "README.md"),
    path.join("skills", "README.md"),
    path.join("scripts", "README.md"),
    path.join("cron", "README.md"),
    path.join("cron", "jobs.json"),
  ];

  for (const rel of required) {
    assert.equal(fs.existsSync(path.join(workspaceDir, rel)), true, rel);
  }
});

test("workspace onboarding state marks completion after bootstrap removal", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-workspace-state-"));
  ensureWorkspaceBootstrap(workspaceDir);

  assert.equal(isWorkspaceOnboardingCompleted(workspaceDir), false);
  fs.unlinkSync(path.join(workspaceDir, "BOOTSTRAP.md"));
  ensureWorkspaceBootstrap(workspaceDir);
  assert.equal(isWorkspaceOnboardingCompleted(workspaceDir), true);
});

test("markWorkspaceOnboardingCompleted writes completion marker", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-workspace-mark-"));
  ensureWorkspaceBootstrap(workspaceDir);

  assert.equal(isWorkspaceOnboardingCompleted(workspaceDir), false);
  markWorkspaceOnboardingCompleted(workspaceDir);
  assert.equal(isWorkspaceOnboardingCompleted(workspaceDir), true);
});

test("WorkspaceStore writes session steps final and daily memory", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-workspace-store-"));
  const store = new WorkspaceStore({ workspaceDir });

  const session = store.createSession("search weather", "gpt-5.2-codex", "gpt-5.2-codex");
  store.appendStep(
    session,
    1,
    "I should tap search input",
    JSON.stringify({ type: "tap", x: 10, y: 20 }),
    "Tapped at (10,20)",
  );
  store.finalizeSession(session, true, "Done");
  const memoryPath = store.appendDailyMemory("gpt-5.2-codex", "search weather", true, "Done");

  assert.equal(session.path.endsWith(".jsonl"), true);
  const transcriptBody = fs.readFileSync(session.path, "utf-8");
  assert.match(transcriptBody, /"type":"session"/);
  assert.match(transcriptBody, /search weather/);
  assert.match(transcriptBody, /Done/);

  const markdownPath = session.path.replace(/\.jsonl$/i, ".md");
  assert.equal(fs.existsSync(markdownPath), true);
  const sessionBody = fs.readFileSync(markdownPath, "utf-8");
  assert.match(sessionBody, /### Step 1/);
  assert.match(sessionBody, /status: SUCCESS/);
  assert.match(sessionBody, /search weather/);

  const sessionsStorePath = path.join(workspaceDir, "sessions", "sessions.json");
  assert.equal(fs.existsSync(sessionsStorePath), true);
  const sessionsStore = JSON.parse(fs.readFileSync(sessionsStorePath, "utf-8"));
  assert.equal(sessionsStore[session.id].sessionId, session.id);
  assert.equal(sessionsStore[session.id].sessionFile, session.path);

  const memoryBody = fs.readFileSync(memoryPath, "utf-8");
  assert.match(memoryBody, /\[OK\]/);
  assert.match(memoryBody, /search weather/);
});

test("WorkspaceStore reuses session transcript when sessionKey is stable", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-workspace-reuse-"));
  const store = new WorkspaceStore({ workspaceDir });

  const first = store.createSession(
    "first task",
    "gpt-5.2-codex",
    "gpt-5.2-codex",
    { sessionKey: "telegram:1001" },
  );
  store.finalizeSession(first, true, "first done");

  const second = store.createSession(
    "second task",
    "gpt-5.2-codex",
    "gpt-5.2-codex",
    { sessionKey: "telegram:1001" },
  );
  store.finalizeSession(second, true, "second done");

  assert.equal(second.id, first.id);
  assert.equal(second.path, first.path);

  const sessionsStorePath = path.join(workspaceDir, "sessions", "sessions.json");
  const sessionsStore = JSON.parse(fs.readFileSync(sessionsStorePath, "utf-8"));
  assert.equal(Boolean(sessionsStore["telegram:1001"]), true);
  assert.equal(sessionsStore["telegram:1001"].sessionId, first.id);
  assert.equal(sessionsStore["telegram:1001"].sessionFile, first.path);

  const transcriptLines = fs.readFileSync(first.path, "utf-8")
    .split(/\r?\n/g)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const assistantTexts = transcriptLines
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .map((entry) => {
      const content = entry.message?.content;
      if (!Array.isArray(content) || content.length === 0) {
        return "";
      }
      const firstPart = content[0];
      return typeof firstPart?.text === "string" ? firstPart.text : "";
    });
  assert.equal(assistantTexts.filter((text) => text === "session_started").length, 1);
  assert.equal(assistantTexts.includes("first done"), true);
  assert.equal(assistantTexts.includes("second done"), true);
  assert.equal(assistantTexts.some((text) => text.startsWith("status: ")), false);
});

test("WorkspaceStore resetSession rolls session id while keeping session key", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-workspace-reset-"));
  const store = new WorkspaceStore({ workspaceDir });

  const first = store.createSession(
    "first task",
    "gpt-5.2-codex",
    "gpt-5.2-codex",
    { sessionKey: "telegram:2001" },
  );
  store.finalizeSession(first, true, "first done");

  const reset = store.resetSession("telegram:2001");
  assert.equal(Boolean(reset), true);
  assert.notEqual(reset.sessionId, first.id);
  assert.notEqual(reset.sessionPath, first.path);

  const second = store.createSession(
    "second task",
    "gpt-5.2-codex",
    "gpt-5.2-codex",
    { sessionKey: "telegram:2001" },
  );
  store.finalizeSession(second, true, "second done");

  assert.equal(second.id, reset.sessionId);
  assert.equal(second.path, reset.sessionPath);

  const sessionsStorePath = path.join(workspaceDir, "sessions", "sessions.json");
  const sessionsStore = JSON.parse(fs.readFileSync(sessionsStorePath, "utf-8"));
  assert.equal(sessionsStore["telegram:2001"].sessionId, reset.sessionId);
  assert.equal(sessionsStore["telegram:2001"].sessionFile, reset.sessionPath);
  assert.equal(fs.existsSync(first.path), true);
});
