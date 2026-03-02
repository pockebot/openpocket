import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function runCli(args, env = {}) {
  return spawnSync("node", [cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENPOCKET_SKIP_ENV_SETUP: "1",
      OPENPOCKET_SKIP_GATEWAY_PID_CHECK: "1",
      ...env,
    },
    encoding: "utf-8",
  });
}

function makeHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("skills list only shows loaded workspace skills", () => {
  const home = makeHome("openpocket-cli-skills-list-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const workspaceSkillPath = path.join(home, "workspace", "skills", "workspace-only.md");
  fs.mkdirSync(path.dirname(workspaceSkillPath), { recursive: true });
  fs.writeFileSync(
    workspaceSkillPath,
    [
      "---",
      "name: Workspace Only",
      "description: Workspace scoped skill",
      "---",
      "# Workspace Only",
      "This skill should appear in workspace list.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const localSkillPath = path.join(home, "skills", "local-only.md");
  fs.mkdirSync(path.dirname(localSkillPath), { recursive: true });
  fs.writeFileSync(
    localSkillPath,
    [
      "---",
      "name: Local Only",
      "description: Local scoped skill",
      "---",
      "# Local Only",
      "This skill should not appear in workspace list.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const run = runCli(["skills", "list"], { OPENPOCKET_HOME: home });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Loaded Workspace Skills/);
  assert.match(run.stdout, /\[workspace\] Workspace Only \(workspace-only\)/);
  assert.doesNotMatch(run.stdout, /\[bundled\]/);
  assert.doesNotMatch(run.stdout, /\[local\]/);
});

test("skills load requires interactive terminal unless --all is provided", () => {
  const home = makeHome("openpocket-cli-skills-load-tty-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const run = runCli(["skills", "load"], { OPENPOCKET_HOME: home });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /interactive terminal/i);
});

test("skills load --all copies bundled skills missing from workspace", () => {
  const home = makeHome("openpocket-cli-skills-load-all-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const existingDir = path.join(home, "workspace", "skills", "human-auth-location");
  fs.mkdirSync(existingDir, { recursive: true });
  const existingPath = path.join(existingDir, "SKILL.md");
  fs.writeFileSync(
    existingPath,
    [
      "---",
      "name: Workspace Human Auth Location",
      "description: Workspace override marker",
      "---",
      "# Workspace Human Auth Location",
      "Workspace copy marker.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const run = runCli(["skills", "load", "--all"], { OPENPOCKET_HOME: home });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Skills load summary: selected=\d+ copied=\d+ skipped=\d+/);

  const loadedSkillPath = path.join(home, "workspace", "skills", "solitaire-play", "SKILL.md");
  const loadedSkillAgentPath = path.join(home, "workspace", "skills", "solitaire-play", "agents", "openai.yaml");
  assert.equal(fs.existsSync(loadedSkillPath), true, "solitaire-play SKILL.md should be copied to workspace");
  assert.equal(fs.existsSync(loadedSkillAgentPath), true, "solitaire-play nested assets should be copied to workspace");

  const list = runCli(["skills", "list"], { OPENPOCKET_HOME: home });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  assert.match(list.stdout, /\[workspace\] solitaire-play \(solitaire-play\)/);

  const marker = fs.readFileSync(existingPath, "utf-8");
  assert.match(marker, /Workspace copy marker\./);
});
