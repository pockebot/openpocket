import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { AutoSkillRefiner } = await import("../dist/skills/auto-skill-refiner.js");

test("AutoSkillRefiner returns input draft as promoted in mixed mode", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-refiner-mixed-"));
  const draftPath = path.join(workspaceDir, "skills", "auto", "draft.md");
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, "# Draft\n\nBody", "utf-8");

  const refiner = new AutoSkillRefiner({
    workspaceDir,
    agent: { skillsSpecMode: "mixed" },
  });
  const out = refiner.refine({
    draftSkillPath: draftPath,
    task: "open app",
    finalMessage: "done",
  });
  assert.equal(out.promotedPath, draftPath);
  assert.equal(out.issues.length, 0);
});

test("AutoSkillRefiner keeps strict-valid draft as-is", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-refiner-strict-pass-"));
  const draftDir = path.join(workspaceDir, "skills", "auto", "valid-skill");
  fs.mkdirSync(draftDir, { recursive: true });
  const draftPath = path.join(draftDir, "SKILL.md");
  fs.writeFileSync(
    draftPath,
    [
      "---",
      "name: valid-skill",
      "description: A valid strict skill",
      "---",
      "",
      "# valid-skill",
      "",
      "Body.",
    ].join("\n"),
    "utf-8",
  );

  const refiner = new AutoSkillRefiner({
    workspaceDir,
    agent: { skillsSpecMode: "strict" },
  });
  const out = refiner.refine({
    draftSkillPath: draftPath,
    task: "open app",
    finalMessage: "done",
  });
  assert.equal(out.promotedPath, draftPath);
  assert.equal(out.issues.length, 0);
});

test("AutoSkillRefiner converts non-strict draft into strict SKILL.md candidate", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-refiner-strict-convert-"));
  const draftPath = path.join(workspaceDir, "skills", "auto", "20260228-123456-open-app.md");
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(
    draftPath,
    [
      "# Skill Draft: Open app",
      "",
      "- Status: draft",
      "",
      "## Procedure",
      "",
      "1. launch app",
    ].join("\n"),
    "utf-8",
  );

  const refiner = new AutoSkillRefiner({
    workspaceDir,
    agent: { skillsSpecMode: "strict" },
  });
  const out = refiner.refine({
    draftSkillPath: draftPath,
    task: "open app",
    finalMessage: "done",
  });

  assert.equal(out.promotedPath !== null, true);
  assert.equal(out.issues.length, 0);
  assert.match(out.promotedPath, /skills[\\/]auto[\\/][a-z0-9-]+[\\/]SKILL\.md$/);
  const refined = fs.readFileSync(out.promotedPath, "utf-8");
  assert.match(refined, /^---\n/m);
  assert.match(refined, /name:\s*[a-z0-9-]+/);
  assert.match(refined, /description:\s*"/);
});
