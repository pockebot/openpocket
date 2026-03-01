import fs from "node:fs";
import path from "node:path";

import type { OpenPocketConfig } from "../types.js";
import {
  type SkillSpecValidationIssue,
  validateSkillDocument,
  validateSkillPath,
} from "./spec-validator.js";

export interface AutoSkillRefineResult {
  draftPath: string | null;
  refinedPath: string | null;
  promotedPath: string | null;
  issues: SkillSpecValidationIssue[];
}

function strictName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64) || "auto-skill";
}

function compactText(text: string, maxChars = 180): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stripExistingFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const matched = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!matched) {
    return normalized;
  }
  return normalized.slice(matched[0].length);
}

export class AutoSkillRefiner {
  private readonly config: OpenPocketConfig;

  constructor(config: OpenPocketConfig) {
    this.config = config;
  }

  refine(params: { draftSkillPath: string | null; task: string; finalMessage: string }): AutoSkillRefineResult {
    if (!params.draftSkillPath) {
      return { draftPath: null, refinedPath: null, promotedPath: null, issues: [] };
    }
    if (!fs.existsSync(params.draftSkillPath)) {
      return {
        draftPath: params.draftSkillPath,
        refinedPath: null,
        promotedPath: null,
        issues: [{
          code: "DRAFT_SKILL_MISSING",
          message: `Draft skill path does not exist: ${params.draftSkillPath}`,
          severity: "error",
          field: "path",
        }],
      };
    }

    const mode = this.config.agent.skillsSpecMode ?? "mixed";
    if (mode !== "strict") {
      return {
        draftPath: params.draftSkillPath,
        refinedPath: params.draftSkillPath,
        promotedPath: params.draftSkillPath,
        issues: [],
      };
    }

    const draftValidation = validateSkillPath(params.draftSkillPath, { strict: true });
    if (draftValidation.ok) {
      return {
        draftPath: params.draftSkillPath,
        refinedPath: params.draftSkillPath,
        promotedPath: params.draftSkillPath,
        issues: [],
      };
    }

    const raw = fs.readFileSync(params.draftSkillPath, "utf-8");
    const body = stripExistingFrontmatter(raw).trim() || "# Auto Skill Draft\n\n(Empty draft)";
    const parsed = path.parse(params.draftSkillPath);
    const baseName = parsed.base.toLowerCase() === "skill.md"
      ? path.basename(path.dirname(params.draftSkillPath))
      : parsed.name;
    const skillName = strictName(baseName);
    const outDir = path.join(this.config.workspaceDir, "skills", "auto", skillName);
    fs.mkdirSync(outDir, { recursive: true });
    const refinedPath = path.join(outDir, "SKILL.md");

    const description = compactText(`Refined auto skill for: ${params.task}`, 170);
    const metadata = JSON.stringify({
      openclaw: {
        generated: {
          kind: "auto_skill_refined",
          source: params.draftSkillPath,
        },
        triggers: {
          any: [compactText(params.task, 100)],
        },
      },
    });

    const refined = [
      "---",
      `name: ${skillName}`,
      `description: ${JSON.stringify(description || "Refined auto skill")}`,
      `metadata: ${metadata}`,
      "---",
      "",
      body,
      "",
      "## Refined Outcome",
      "",
      compactText(params.finalMessage, 500) || "(empty)",
      "",
    ].join("\n");

    fs.writeFileSync(refinedPath, refined, "utf-8");
    const refinedValidation = validateSkillPath(refinedPath, { strict: true });
    if (refinedValidation.ok) {
      return {
        draftPath: params.draftSkillPath,
        refinedPath,
        promotedPath: refinedPath,
        issues: [],
      };
    }

    return {
      draftPath: params.draftSkillPath,
      refinedPath,
      promotedPath: null,
      issues: refinedValidation.issues,
    };
  }
}
