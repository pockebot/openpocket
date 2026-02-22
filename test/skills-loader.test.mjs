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
});
