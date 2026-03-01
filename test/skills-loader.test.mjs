import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { SkillLoader } = await import("../dist/skills/skill-loader.js");

test("SkillLoader loads workspace skills", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skills-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();

  const skillsDir = path.join(cfg.workspaceDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "search-app.md"),
    "# Search App\n\nFind and open app quickly by name.",
    "utf-8",
  );

  const loader = new SkillLoader(cfg);
  const skills = loader.loadAll();
  assert.equal(skills.some((s) => s.id === "search-app"), true);
  const summary = loader.summaryText();
  assert.match(summary, /Search App/);
  assert.match(summary, /location="/);
});

test("SkillLoader exposes skill index and leaves active skill prompt empty", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skills-active-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();

  const skillsDir = path.join(cfg.workspaceDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "paybyphone-nearest.md"),
    [
      "# PayByPhone Nearest Flow",
      "",
      "Handle Park at nearest location flow.",
      "",
      "## Steps",
      "- Open PayByPhone",
      "- Use nearest flow",
      "- If empty, request_human_auth(location)",
    ].join("\n"),
    "utf-8",
  );

  const loader = new SkillLoader(cfg);
  const context = loader.buildPromptContextForTask(
    "Open PayByPhone and continue nearest location flow, use location auth if empty.",
  );

  assert.match(context.summaryText, /PayByPhone Nearest Flow/);
  assert.equal(context.activeEntries.length, 0);
  assert.equal(context.activePromptText, "");
  assert.equal(context.activePromptChars, 0);
});

test("SkillLoader keeps tricky skill names in summary index without auto-loading body", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skills-escape-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();

  const skillsDir = path.join(cfg.workspaceDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  const triggerPhrase = "token<&>\"'";
  const metadata = JSON.stringify({
    openclaw: {
      triggers: {
        any: [triggerPhrase],
      },
    },
  });

  fs.writeFileSync(
    path.join(skillsDir, "escape-skill.md"),
    [
      "---",
      `metadata: ${metadata}`,
      "---",
      "",
      "# Skill <A&B> \"quote\" 'apos'",
      "",
      "Test content body.",
    ].join("\n"),
    "utf-8",
  );

  const loader = new SkillLoader(cfg);
  const context = loader.buildPromptContextForTask(
    `Please run ${triggerPhrase} flow for Skill <A&B> "quote" 'apos' now.`,
  );

  assert.match(context.summaryText, /Skill <A&B>/);
  assert.equal(context.activeEntries.length, 0);
  assert.equal(context.activePromptText, "");
});

test("SkillLoader supports SKILL.md directory layout and metadata gating", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skills-gating-"));
  process.env.OPENPOCKET_HOME = home;
  delete process.env.TEST_SKILL_ENV_READY;
  const cfg = loadConfig();

  const skillDir = path.join(cfg.workspaceDir, "skills", "paybyphone_flow");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      'name: "PayByPhone Flow"',
      'description: "Nearest parking with location auth fallback"',
      'metadata: {"openclaw":{"requires":{"env":["TEST_SKILL_ENV_READY"],"config":["agent.verbose"]},"os":["darwin","linux"]}}',
      "---",
      "",
      "# PayByPhone Flow",
      "",
      "Use request_human_auth(location) when nearby is empty.",
    ].join("\n"),
    "utf-8",
  );

  const loader = new SkillLoader(cfg);
  const blocked = loader.loadAll();
  assert.equal(blocked.some((skill) => skill.id === "paybyphone_flow"), false);

  process.env.TEST_SKILL_ENV_READY = "1";
  const enabled = loader.loadAll();
  const skill = enabled.find((item) => item.id === "paybyphone_flow");
  assert.equal(Boolean(skill), true);
  assert.equal(skill?.name, "PayByPhone Flow");
  assert.match(skill?.path || "", /paybyphone_flow[\\/]+SKILL\.md$/i);
});

test("SkillLoader lists all discovered skills in summary regardless task text", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skills-trigger-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();

  const skillsDir = path.join(cfg.workspaceDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  const xSkillDir = path.join(skillsDir, "x-twitter-login-recovery");
  fs.mkdirSync(xSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(xSkillDir, "SKILL.md"),
    [
      "---",
      'name: "X Twitter Login Recovery"',
      'description: "Recover X login when attestation denied happens"',
      'metadata: {"openclaw":{"triggers":{"any":["x","twitter","tweet","attestation denied","attestationdenied","推特"]}}}',
      "---",
      "",
      "# X Twitter Login Recovery",
      "",
      "Use deterministic fallback order for login recovery.",
    ].join("\n"),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(skillsDir, "generic-login.md"),
    "# Generic Login\n\nHandle normal username/password login flows.",
    "utf-8",
  );

  const loader = new SkillLoader(cfg);
  const context = loader.buildPromptContextForTask(
    "Open X app, login, and fix LoginError.AttestationDenied before posting a tweet.",
  );

  assert.match(context.summaryText, /X Twitter Login Recovery/);
  assert.match(context.summaryText, /Generic Login/);
  assert.equal(context.activeEntries.length, 0);
});
