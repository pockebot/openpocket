import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { SkillLoader } = await import("../dist/skills/skill-loader.js");

test("SkillLoader strict mode loads only SKILL.md layout", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skills-strict-layout-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();
  cfg.agent.skillsSpecMode = "strict";

  const skillsDir = path.join(cfg.workspaceDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  fs.writeFileSync(
    path.join(skillsDir, "legacy.md"),
    [
      "---",
      "name: legacy",
      "description: legacy file",
      "---",
      "",
      "# legacy",
    ].join("\n"),
    "utf-8",
  );

  const strictDir = path.join(skillsDir, "strict-skill");
  fs.mkdirSync(strictDir, { recursive: true });
  fs.writeFileSync(
    path.join(strictDir, "SKILL.md"),
    [
      "---",
      "name: strict-skill",
      "description: strict layout file",
      "---",
      "",
      "# strict-skill",
    ].join("\n"),
    "utf-8",
  );

  const loader = new SkillLoader(cfg);
  const skills = loader.loadAll();
  assert.equal(skills.some((s) => s.id === "legacy"), false);
  assert.equal(skills.some((s) => s.id === "strict-skill"), true);
});

test("SkillLoader strict mode filters out invalid SKILL.md name/path mismatches", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skills-strict-invalid-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();
  cfg.agent.skillsSpecMode = "strict";

  const skillsDir = path.join(cfg.workspaceDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  const invalidDir = path.join(skillsDir, "invalid-path-name");
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(
    path.join(invalidDir, "SKILL.md"),
    [
      "---",
      "name: another-name",
      "description: invalid for strict path rule",
      "---",
      "",
      "# another-name",
    ].join("\n"),
    "utf-8",
  );

  const validDir = path.join(skillsDir, "valid-name");
  fs.mkdirSync(validDir, { recursive: true });
  fs.writeFileSync(
    path.join(validDir, "SKILL.md"),
    [
      "---",
      "name: valid-name",
      "description: valid strict skill",
      "---",
      "",
      "# valid-name",
    ].join("\n"),
    "utf-8",
  );

  const loader = new SkillLoader(cfg);
  const skills = loader.loadAll();
  assert.equal(skills.some((s) => s.id === "invalid-path-name"), false);
  assert.equal(skills.some((s) => s.id === "valid-name"), true);
});

test("SkillLoader mixed mode still loads legacy markdown files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skills-mixed-legacy-"));
  process.env.OPENPOCKET_HOME = home;
  const cfg = loadConfig();
  cfg.agent.skillsSpecMode = "mixed";

  const skillsDir = path.join(cfg.workspaceDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "legacy-open-app.md"),
    "# Legacy Open App\n\nOpen app by name.",
    "utf-8",
  );

  const loader = new SkillLoader(cfg);
  const skills = loader.loadAll();
  assert.equal(skills.some((s) => s.id === "legacy-open-app"), true);
});
