#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveHome() {
  return process.env.OPENPOCKET_HOME?.trim()
    ? path.resolve(process.env.OPENPOCKET_HOME.trim())
    : path.resolve(path.join(os.homedir(), ".openpocket"));
}

function compact(text, max = 160) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function slug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64) || "migrated-skill";
}

function extractBody(raw) {
  const normalized = raw.replace(/\r\n/g, "\n");
  const matched = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  return matched ? normalized.slice(matched[0].length) : normalized;
}

function migrate(root) {
  const out = { migrated: 0, skipped: 0 };
  if (!fs.existsSync(root)) {
    return out;
  }
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (entry.name.toLowerCase() === "readme.md") continue;
      if (entry.name.toLowerCase() === "skill.md") continue;

      const base = path.basename(entry.name, ".md");
      const skillName = slug(base);
      const skillDir = path.join(path.dirname(full), skillName);
      const skillPath = path.join(skillDir, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        out.skipped += 1;
        continue;
      }

      const raw = fs.readFileSync(full, "utf-8");
      const body = extractBody(raw).trim() || `# ${skillName}\n\n(legacy migrated skill)\n`;
      const firstLine = body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#")) || "Migrated skill from legacy markdown.";
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        skillPath,
        [
          "---",
          `name: ${skillName}`,
          `description: ${JSON.stringify(compact(firstLine))}`,
          "metadata: {}",
          "---",
          "",
          body,
          "",
        ].join("\n"),
        "utf-8",
      );
      out.migrated += 1;
    }
  }
  return out;
}

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(resolveHome(), "workspace", "skills");
const result = migrate(target);
// eslint-disable-next-line no-console
console.log(`migrated=${result.migrated} skipped=${result.skipped} root=${target}`);
