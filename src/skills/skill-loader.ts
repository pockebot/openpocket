import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenPocketConfig, SkillInfo } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { ensureDir, openpocketHome } from "../utils/paths.js";

function listMarkdownFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        if (entry.name.toLowerCase() === "readme.md") {
          continue;
        }
        out.push(fullPath);
      }
    }
  }

  return out;
}

function parseSkill(pathname: string, source: SkillInfo["source"]): SkillInfo {
  const raw = fs.readFileSync(pathname, "utf-8");
  const lines = raw.split(/\r?\n/);

  const heading = lines.find((line) => line.trim().startsWith("# "))?.replace(/^#\s+/, "").trim();
  const description =
    lines
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"))
      ?.slice(0, 180) ?? "(no description)";

  const base = path.basename(pathname, ".md");
  return {
    id: base,
    name: heading || base,
    description,
    source,
    path: pathname,
  };
}

export class SkillLoader {
  private readonly config: OpenPocketConfig;

  constructor(config: OpenPocketConfig) {
    this.config = config;
  }

  private sourceDirs(): Array<{ source: SkillInfo["source"]; dir: string }> {
    const workspaceDir = ensureDir(path.join(this.config.workspaceDir, "skills"));
    const localDir = ensureDir(path.join(openpocketHome(), "skills"));
    const bundledDir = path.resolve(path.join(__dirname, "..", "..", "skills"));

    return [
      { source: "workspace", dir: workspaceDir },
      { source: "local", dir: localDir },
      { source: "bundled", dir: bundledDir },
    ];
  }

  loadAll(): SkillInfo[] {
    const selected = new Map<string, SkillInfo>();

    for (const sourceDir of this.sourceDirs()) {
      const files = listMarkdownFilesRecursive(sourceDir.dir);
      for (const filePath of files) {
        const skill = parseSkill(filePath, sourceDir.source);
        if (!selected.has(skill.id)) {
          selected.set(skill.id, skill);
        }
      }
    }

    return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  summaryEntries(maxItems = 20): Array<{
    skill: SkillInfo;
    line: string;
  }> {
    return this.loadAll()
      .slice(0, Math.max(1, maxItems))
      .map((skill) => ({
        skill,
        line: `- [${skill.source}] ${skill.name} (${skill.path}): ${skill.description}`,
      }));
  }

  summaryText(maxItems = 20): string {
    const entries = this.summaryEntries(maxItems);
    if (entries.length === 0) {
      return "(no skills loaded)";
    }

    return entries.map((entry) => entry.line).join("\n");
  }
}
