import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  validateSkillDocument,
  validateSkillPath,
} = await import("../dist/skills/spec-validator.js");

test("validateSkillDocument strict passes for compliant SKILL.md content", () => {
  const content = [
    "---",
    "name: compliant-skill",
    "description: A strict-mode compliant skill.",
    'metadata: {"openclaw":{"triggers":{"any":["compliant"]}}}',
    "---",
    "",
    "# compliant-skill",
    "",
    "Body content.",
  ].join("\n");

  const out = validateSkillDocument(content, {
    strict: true,
    filePath: "/tmp/compliant-skill/SKILL.md",
  });
  assert.equal(out.ok, true);
  assert.equal(out.issues.length, 0);
  assert.equal(out.frontmatter.name, "compliant-skill");
});

test("validateSkillDocument fails when frontmatter is missing", () => {
  const out = validateSkillDocument("# No frontmatter", {
    strict: true,
    filePath: "/tmp/no-frontmatter/SKILL.md",
  });
  assert.equal(out.ok, false);
  assert.equal(out.issues.some((issue) => issue.code === "FRONTMATTER_MISSING"), true);
});

test("validateSkillDocument fails when name or description is missing", () => {
  const out = validateSkillDocument(
    ["---", "name: only-name", "---", "", "# only-name"].join("\n"),
    {
      strict: true,
      filePath: "/tmp/only-name/SKILL.md",
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.issues.some((issue) => issue.code === "DESCRIPTION_MISSING"), true);
});

test("validateSkillDocument strict fails on name/path mismatch", () => {
  const out = validateSkillDocument(
    [
      "---",
      "name: mismatch-name",
      "description: test",
      "---",
      "",
      "# mismatch-name",
    ].join("\n"),
    {
      strict: true,
      filePath: "/tmp/another-dir/SKILL.md",
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.issues.some((issue) => issue.code === "NAME_PATH_MISMATCH"), true);
});

test("validateSkillPath strict fails when filename is not SKILL.md", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-skill-spec-"));
  const dir = path.join(root, "sample-skill");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "sample.md");
  fs.writeFileSync(
    filePath,
    ["---", "name: sample-skill", "description: sample", "---", "", "# sample-skill"].join("\n"),
    "utf-8",
  );

  const out = validateSkillPath(filePath, { strict: true });
  assert.equal(out.ok, false);
  assert.equal(out.issues.some((issue) => issue.code === "SKILL_FILENAME_INVALID"), true);
});
