import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  loadWorkspaceTemplate,
  resetWorkspaceTemplateCache,
  resolveWorkspaceTemplateDir,
} = await import("../dist/memory/workspace-templates.js");

test("workspace templates resolve from OPENPOCKET_TEMPLATE_DIR and strip markdown frontmatter", () => {
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-template-dir-"));
  fs.writeFileSync(
    path.join(templateDir, "AGENTS.md"),
    [
      "---",
      "title: test",
      "---",
      "",
      "# AGENTS",
      "",
      "hello template",
    ].join("\n"),
    "utf-8",
  );

  const prev = process.env.OPENPOCKET_TEMPLATE_DIR;
  process.env.OPENPOCKET_TEMPLATE_DIR = templateDir;
  resetWorkspaceTemplateCache();

  const resolved = resolveWorkspaceTemplateDir();
  assert.equal(resolved, templateDir);

  const content = loadWorkspaceTemplate("AGENTS.md");
  assert.match(content, /^# AGENTS/m);
  assert.equal(content.includes("title: test"), false);

  if (prev === undefined) {
    delete process.env.OPENPOCKET_TEMPLATE_DIR;
  } else {
    process.env.OPENPOCKET_TEMPLATE_DIR = prev;
  }
  resetWorkspaceTemplateCache();
});
