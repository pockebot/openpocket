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

test("SkillLoader matches skills for task while keeping body out of prompt context", () => {
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
  assert.equal(context.activeEntries.length > 0, true);
  assert.equal(context.activePromptText, "");
  assert.equal(context.activePromptChars, 0);
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
