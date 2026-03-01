import fs from "node:fs";
import path from "node:path";

export type SkillSpecValidationSeverity = "error" | "warn";

export interface SkillSpecValidationIssue {
  code: string;
  message: string;
  severity: SkillSpecValidationSeverity;
  field?: string;
}

export interface SkillSpecFrontmatter {
  name: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  raw: Record<string, string>;
  hasFrontmatter: boolean;
  body: string;
}

export interface SkillSpecValidationResult {
  ok: boolean;
  issues: SkillSpecValidationIssue[];
  frontmatter: SkillSpecFrontmatter;
}

function stripQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function tryParseJsonObject(value: string): Record<string, unknown> | null {
  const normalized = stripQuotes(value);
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseFrontmatter(raw: string): SkillSpecFrontmatter {
  const normalized = raw.replace(/\r\n/g, "\n");
  const matched = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!matched) {
    return {
      name: null,
      description: null,
      metadata: null,
      raw: {},
      hasFrontmatter: false,
      body: normalized,
    };
  }

  const block = matched[1];
  const body = normalized.slice(matched[0].length);
  const rawFields: Record<string, string> = {};
  let name: string | null = null;
  let description: string | null = null;
  let metadata: Record<string, unknown> | null = null;

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
    if (!kv) {
      continue;
    }
    const key = kv[1];
    const keyLower = key.toLowerCase();
    const value = kv[2].trim();
    rawFields[keyLower] = value;
    if (keyLower === "name") {
      name = stripQuotes(value);
      continue;
    }
    if (keyLower === "description") {
      description = stripQuotes(value);
      continue;
    }
    if (keyLower === "metadata") {
      metadata = tryParseJsonObject(value);
    }
  }

  return {
    name,
    description,
    metadata,
    raw: rawFields,
    hasFrontmatter: true,
    body,
  };
}

function normalizeSkillNameForPath(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function validateFrontmatterCommon(frontmatter: SkillSpecFrontmatter): SkillSpecValidationIssue[] {
  const issues: SkillSpecValidationIssue[] = [];
  if (!frontmatter.hasFrontmatter) {
    issues.push({
      code: "FRONTMATTER_MISSING",
      message: "Skill document must start with YAML frontmatter block.",
      severity: "error",
    });
    return issues;
  }

  if (!frontmatter.name || !frontmatter.name.trim()) {
    issues.push({
      code: "NAME_MISSING",
      message: "Frontmatter must include non-empty `name`.",
      severity: "error",
      field: "name",
    });
  }

  if (!frontmatter.description || !frontmatter.description.trim()) {
    issues.push({
      code: "DESCRIPTION_MISSING",
      message: "Frontmatter must include non-empty `description`.",
      severity: "error",
      field: "description",
    });
  }
  return issues;
}

function validateStrictPathRules(
  filePath: string | undefined,
  frontmatter: SkillSpecFrontmatter,
): SkillSpecValidationIssue[] {
  const issues: SkillSpecValidationIssue[] = [];
  if (!filePath) {
    return issues;
  }

  const base = path.basename(filePath);
  if (base.toLowerCase() !== "skill.md") {
    issues.push({
      code: "SKILL_FILENAME_INVALID",
      message: "Strict mode requires file name `SKILL.md`.",
      severity: "error",
      field: "path",
    });
  }

  const dirName = path.basename(path.dirname(filePath));
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(dirName)) {
    issues.push({
      code: "SKILL_DIR_INVALID",
      message: "Strict mode requires parent skill directory to be kebab-case [a-z0-9-].",
      severity: "error",
      field: "path",
    });
  }

  const skillName = frontmatter.name?.trim() ?? "";
  if (skillName && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillName)) {
    issues.push({
      code: "NAME_INVALID",
      message: "Strict mode requires frontmatter `name` to be kebab-case [a-z0-9-].",
      severity: "error",
      field: "name",
    });
  }

  if (skillName && dirName && normalizeSkillNameForPath(skillName) !== dirName) {
    issues.push({
      code: "NAME_PATH_MISMATCH",
      message: "Strict mode requires frontmatter `name` to match parent directory name.",
      severity: "error",
      field: "name",
    });
  }
  return issues;
}

export function validateSkillDocument(
  rawContent: string,
  options?: {
    strict?: boolean;
    filePath?: string;
  },
): SkillSpecValidationResult {
  const strict = Boolean(options?.strict);
  const frontmatter = parseFrontmatter(rawContent);
  const issues = validateFrontmatterCommon(frontmatter);
  if (strict) {
    issues.push(...validateStrictPathRules(options?.filePath, frontmatter));
  }
  return {
    ok: !issues.some((item) => item.severity === "error"),
    issues,
    frontmatter,
  };
}

export function validateSkillPath(
  filePath: string,
  options?: {
    strict?: boolean;
  },
): SkillSpecValidationResult {
  const raw = fs.readFileSync(filePath, "utf-8");
  return validateSkillDocument(raw, {
    strict: options?.strict,
    filePath,
  });
}
