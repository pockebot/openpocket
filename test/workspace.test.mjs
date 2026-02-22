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

  const sessionBody = fs.readFileSync(session.path, "utf-8");
  assert.match(sessionBody, /### Step 1/);
  assert.match(sessionBody, /status: SUCCESS/);
  assert.match(sessionBody, /search weather/);

  const memoryBody = fs.readFileSync(memoryPath, "utf-8");
  assert.match(memoryBody, /\[OK\]/);
  assert.match(memoryBody, /search weather/);
});
