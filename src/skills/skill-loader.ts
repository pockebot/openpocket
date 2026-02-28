import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenPocketConfig, SkillInfo } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { ensureDir, openpocketHome } from "../utils/paths.js";

const SOURCE_PRIORITY: Record<SkillInfo["source"], number> = {
  workspace: 0,
  local: 1,
  bundled: 2,
};

const DEFAULT_SUMMARY_ITEMS = 20;
const DEFAULT_ACTIVE_SKILLS = 3;
const DEFAULT_ACTIVE_SKILL_MAX_CHARS = 7000;
const DEFAULT_ACTIVE_TOTAL_CHARS = 18000;
const MIN_ACTIVE_BLOCK_CHARS = 300;

const TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "or",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "by",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "as",
  "at",
  "from",
  "you",
  "your",
  "my",
  "our",
  "task",
  "app",
  "phone",
  "open",
  "use",
  "using",
  "skill",
  "skills",
  "一个",
  "这个",
  "那个",
  "以及",
  "然后",
  "需要",
  "可以",
  "进行",
  "功能",
  "任务",
  "应用",
  "手机",
  "技能",
]);

export interface LoadedSkill extends SkillInfo {
  content: string;
  contentChars: number;
  metadata: Record<string, unknown> | null;
}

export interface ActiveSkillPromptEntry {
  skill: SkillInfo;
  reason: string;
  score: number;
  contentChars: number;
  truncated: boolean;
}

export interface SkillPromptContext {
  summaryText: string;
  summaryEntries: Array<{ skill: SkillInfo; line: string }>;
  activePromptText: string;
  activePromptChars: number;
  activeEntries: ActiveSkillPromptEntry[];
}

type SkillRequirements = {
  bins: string[];
  env: string[];
  config: string[];
  os: string[];
};

type SkillTriggers = {
  any: string[];
  all: string[];
  none: string[];
};

function listSkillMarkdownFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const skillMd = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md");
    if (skillMd) {
      out.push(path.join(dir, skillMd.name));
    } else {
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".md")) {
          continue;
        }
        if (entry.name.toLowerCase() === "readme.md") {
          continue;
        }
        out.push(path.join(dir, entry.name));
      }
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }

  return out;
}

function stripQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function tryParseJson(value: string): Record<string, unknown> | null {
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

function parseFrontmatter(raw: string): {
  body: string;
  name: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const matched = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!matched) {
    return { body: normalized, name: null, description: null, metadata: null };
  }

  const block = matched[1];
  const body = normalized.slice(matched[0].length);
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
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === "name") {
      name = stripQuotes(value);
      continue;
    }
    if (key === "description") {
      description = stripQuotes(value);
      continue;
    }
    if (key === "metadata") {
      metadata = tryParseJson(value);
    }
  }

  return { body, name, description, metadata };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    return trimmed.split(/[,\s]+/g).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function mapOsToken(value: string): string {
  const token = value.toLowerCase().trim();
  if (!token) return "";
  if (token === "macos" || token === "mac" || token === "osx") return "darwin";
  if (token === "windows" || token === "win") return "win32";
  return token;
}

function resolveConfigPath(config: OpenPocketConfig, keyPath: string): unknown {
  const parts = keyPath.split(".").map((part) => part.trim()).filter(Boolean);
  let cursor: unknown = config;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function commandExists(name: string): boolean {
  const command = name.trim();
  if (!command) {
    return false;
  }
  if (command.includes("/") && path.isAbsolute(command)) {
    return fs.existsSync(command);
  }
  const pathRaw = process.env.PATH || "";
  for (const part of pathRaw.split(path.delimiter)) {
    const dir = part.trim();
    if (!dir) {
      continue;
    }
    const full = path.join(dir, command);
    if (fs.existsSync(full)) {
      return true;
    }
  }
  return false;
}

function parseSkillRequirements(
  metadata: Record<string, unknown> | null,
): SkillRequirements {
  const openclawRaw = metadata?.openclaw;
  const openclaw = openclawRaw && typeof openclawRaw === "object" && !Array.isArray(openclawRaw)
    ? openclawRaw as Record<string, unknown>
    : null;

  const requiresRaw = openclaw?.requires;
  const requires = requiresRaw && typeof requiresRaw === "object" && !Array.isArray(requiresRaw)
    ? requiresRaw as Record<string, unknown>
    : null;

  return {
    bins: toStringArray(requires?.bins),
    env: toStringArray(requires?.env),
    config: toStringArray(requires?.config),
    os: toStringArray(openclaw?.os).map(mapOsToken).filter(Boolean),
  };
}

function parseSkillTriggers(
  metadata: Record<string, unknown> | null,
): SkillTriggers {
  const openclawRaw = metadata?.openclaw;
  const openclaw = openclawRaw && typeof openclawRaw === "object" && !Array.isArray(openclawRaw)
    ? openclawRaw as Record<string, unknown>
    : null;

  const triggersRaw = openclaw?.triggers;
  const triggers = triggersRaw && typeof triggersRaw === "object" && !Array.isArray(triggersRaw)
    ? triggersRaw as Record<string, unknown>
    : null;

  return {
    any: toStringArray(triggers?.any),
    all: toStringArray(triggers?.all),
    none: toStringArray(triggers?.none),
  };
}

function satisfiesRequirements(config: OpenPocketConfig, req: SkillRequirements): boolean {
  if (req.os.length > 0) {
    const current = mapOsToken(process.platform);
    if (!req.os.includes(current)) {
      return false;
    }
  }

  for (const bin of req.bins) {
    if (!commandExists(bin)) {
      return false;
    }
  }
  for (const envName of req.env) {
    if (!process.env[envName] || !String(process.env[envName]).trim()) {
      return false;
    }
  }
  for (const keyPath of req.config) {
    const value = resolveConfigPath(config, keyPath);
    if (!value) {
      return false;
    }
  }
  return true;
}

function parseSkill(pathname: string, source: SkillInfo["source"]): LoadedSkill {
  const raw = fs.readFileSync(pathname, "utf-8");
  const frontmatter = parseFrontmatter(raw);
  const body = frontmatter.body;
  const lines = body.split(/\r?\n/);

  const heading = lines.find((line) => line.trim().startsWith("# "))?.replace(/^#\s+/, "").trim();
  const description =
    frontmatter.description
    || lines
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"))
      ?.slice(0, 180)
    || "(no description)";

  const isSkillMd = path.basename(pathname).toLowerCase() === "skill.md";
  const base = isSkillMd ? path.basename(path.dirname(pathname)) : path.basename(pathname, ".md");
  const name = frontmatter.name || heading || base;
  return {
    id: base,
    name,
    description,
    source,
    path: pathname,
    content: body,
    contentChars: body.length,
    metadata: frontmatter.metadata,
  };
}

function parseLoadedSkill(pathname: string, source: SkillInfo["source"]): LoadedSkill {
  return parseSkill(pathname, source);
}

function normalizeText(value: string): string {
  return value.toLowerCase().trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9\u4e00-\u9fff]+/g)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item) return false;
      if (item.length < 2 && !/^[\u4e00-\u9fff]$/.test(item)) {
        return false;
      }
      return !TOKEN_STOP_WORDS.has(item);
    });
}

function escapedRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordMatch(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedNeedle) {
    return false;
  }
  if (/^[a-z0-9_-]+$/i.test(normalizedNeedle)) {
    const regex = new RegExp(`(^|[^a-z0-9_])${escapedRegex(normalizedNeedle)}([^a-z0-9_]|$)`, "i");
    return regex.test(haystack);
  }
  return haystack.includes(normalizedNeedle);
}

function summarizeLine(text: string, maxChars = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function escapeXmlAttributeValue(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSummaryLine(skill: SkillInfo): string {
  return `- name="${skill.name}" source="${skill.source}" location="${skill.path}" description="${skill.description.replace(/"/g, "'")}"`;
}

function trimToChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  if (maxChars <= 0) {
    return { text: "", truncated: true };
  }
  const slice = text.slice(0, maxChars);
  const cutAtNewline = slice.lastIndexOf("\n");
  const truncatedBase = cutAtNewline >= 200 ? slice.slice(0, cutAtNewline) : slice;
  return {
    text: `${truncatedBase.trimEnd()}\n\n...(truncated)`,
    truncated: true,
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

  loadDetailedAll(): LoadedSkill[] {
    const selected = new Map<string, LoadedSkill>();

    for (const sourceDir of this.sourceDirs()) {
      const files = listSkillMarkdownFilesRecursive(sourceDir.dir);
      for (const filePath of files) {
        const skill = parseLoadedSkill(filePath, sourceDir.source);
        const requirements = parseSkillRequirements(skill.metadata);
        if (!satisfiesRequirements(this.config, requirements)) {
          continue;
        }
        if (!selected.has(skill.id)) {
          selected.set(skill.id, skill);
        }
      }
    }

    return [...selected.values()].sort((a, b) => {
      const sourceDelta = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
      if (sourceDelta !== 0) return sourceDelta;
      return a.name.localeCompare(b.name);
    });
  }

  loadAll(): SkillInfo[] {
    return this.loadDetailedAll().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      path: skill.path,
    }));
  }

  summaryEntries(maxItems = DEFAULT_SUMMARY_ITEMS): Array<{
    skill: SkillInfo;
    line: string;
  }> {
    return this.loadAll()
      .slice(0, Math.max(1, maxItems))
      .map((skill) => ({
        skill,
        line: formatSummaryLine(skill),
      }));
  }

  summaryText(maxItems = DEFAULT_SUMMARY_ITEMS): string {
    const entries = this.summaryEntries(maxItems);
    if (entries.length === 0) {
      return "(no skills loaded)";
    }

    return entries.map((entry) => entry.line).join("\n");
  }

  private scoreSkill(task: string, skill: LoadedSkill): { score: number; reason: string } {
    const normalizedTask = normalizeText(task);
    if (!normalizedTask) {
      return { score: 0, reason: "" };
    }

    const reasons: string[] = [];
    let score = 0;
    const triggers = parseSkillTriggers(skill.metadata);

    const matchedNone = triggers.none.filter((phrase) => hasWordMatch(normalizedTask, phrase));
    if (matchedNone.length > 0) {
      return { score: 0, reason: `blocked by metadata.none (${matchedNone[0]})` };
    }

    const matchedAll = triggers.all.filter((phrase) => hasWordMatch(normalizedTask, phrase));
    if (triggers.all.length > 0 && matchedAll.length === triggers.all.length) {
      score += 160;
      reasons.push(`metadata.all x${matchedAll.length}`);
    }

    const matchedAny = triggers.any.filter((phrase) => hasWordMatch(normalizedTask, phrase));
    if (matchedAny.length > 0) {
      score += 110 + Math.min(60, matchedAny.length * 15);
      reasons.push(`metadata.any x${matchedAny.length}`);
    }

    if (hasWordMatch(normalizedTask, `$${skill.id}`) || hasWordMatch(normalizedTask, skill.id)) {
      score += 120;
      reasons.push(`explicit id match (${skill.id})`);
    }

    if (hasWordMatch(normalizedTask, skill.name)) {
      score += 80;
      reasons.push(`name match (${skill.name})`);
    }

    const baseName = path.basename(skill.path, ".md");
    if (baseName && baseName !== skill.id && hasWordMatch(normalizedTask, baseName)) {
      score += 60;
      reasons.push(`file match (${baseName})`);
    }

    const taskTokens = new Set(tokenize(task));
    const skillCorpus = [skill.id, skill.name, skill.description, skill.content.slice(0, 6000)].join("\n");
    const skillTokens = new Set(tokenize(skillCorpus));
    let overlap = 0;
    for (const token of taskTokens) {
      if (skillTokens.has(token)) {
        overlap += 1;
      }
    }
    if (overlap > 0) {
      score += Math.min(45, overlap * 9);
      reasons.push(`token overlap x${overlap}`);
    }

    if (score > 0 && skill.source === "workspace") {
      score += 8;
      reasons.push("workspace priority");
    }

    return {
      score,
      reason: reasons.join("; "),
    };
  }

  buildPromptContextForTask(
    task: string,
    options?: {
      maxSummaryItems?: number;
      maxActiveSkills?: number;
      maxActiveSkillChars?: number;
      maxActiveTotalChars?: number;
    },
  ): SkillPromptContext {
    const maxSummaryItems = Math.max(1, options?.maxSummaryItems ?? DEFAULT_SUMMARY_ITEMS);
    const maxActiveSkills = Math.max(1, options?.maxActiveSkills ?? DEFAULT_ACTIVE_SKILLS);
    const maxActiveSkillChars = Math.max(500, options?.maxActiveSkillChars ?? DEFAULT_ACTIVE_SKILL_MAX_CHARS);
    const maxActiveTotalChars = Math.max(1000, options?.maxActiveTotalChars ?? DEFAULT_ACTIVE_TOTAL_CHARS);

    const allSkills = this.loadDetailedAll();
    const summaryEntries = allSkills
      .slice(0, maxSummaryItems)
      .map((skill) => ({
        skill: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source,
          path: skill.path,
        } satisfies SkillInfo,
        line: formatSummaryLine({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source,
          path: skill.path,
        }),
      }));
    const summaryText = summaryEntries.length > 0
      ? summaryEntries.map((entry) => entry.line).join("\n")
      : "(no skills loaded)";

    const scored = allSkills
      .map((skill) => {
        const scoredSkill = this.scoreSkill(task, skill);
        return { skill, ...scoredSkill };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        const scoreDelta = b.score - a.score;
        if (scoreDelta !== 0) return scoreDelta;
        const sourceDelta = SOURCE_PRIORITY[a.skill.source] - SOURCE_PRIORITY[b.skill.source];
        if (sourceDelta !== 0) return sourceDelta;
        return a.skill.name.localeCompare(b.skill.name);
      });

    let remainingChars = maxActiveTotalChars;
    const activeEntries: ActiveSkillPromptEntry[] = [];

    for (const item of scored) {
      if (activeEntries.length >= maxActiveSkills || remainingChars <= MIN_ACTIVE_BLOCK_CHARS) {
        break;
      }

      const blockBudget = Math.min(maxActiveSkillChars, remainingChars);
      if (blockBudget < MIN_ACTIVE_BLOCK_CHARS) {
        break;
      }

      const projectedChars = Math.min(item.skill.contentChars, blockBudget);
      const reasonLine = summarizeLine(item.reason || "task relevance match", 220);
      remainingChars -= projectedChars;
      activeEntries.push({
        skill: {
          id: item.skill.id,
          name: item.skill.name,
          description: item.skill.description,
          source: item.skill.source,
          path: item.skill.path,
        },
        reason: reasonLine || "task relevance match",
        score: item.score,
        contentChars: projectedChars,
        truncated: item.skill.contentChars > projectedChars,
      });
    }

    const activeBlocks: string[] = [];
    for (const entry of activeEntries) {
      const matchedSkill = scored.find((item) => item.skill.id === entry.skill.id);
      if (!matchedSkill) {
        continue;
      }
      let block = matchedSkill.skill.content;
      if (block.length > entry.contentChars) {
        block = block.slice(0, entry.contentChars).trimEnd() + "\n[...truncated]";
      }
      const safeName = escapeXmlAttributeValue(entry.skill.name);
      const safeSource = escapeXmlAttributeValue(entry.skill.source);
      const safeScore = escapeXmlAttributeValue(String(entry.score));
      const safeReason = escapeXmlAttributeValue(entry.reason || "");
      activeBlocks.push(
        `<active_skill name="${safeName}" source="${safeSource}" score="${safeScore}" reason="${safeReason}">\n${block}\n</active_skill>`,
      );
    }
    const activePromptText = activeBlocks.length > 0
      ? activeBlocks.join("\n\n")
      : "";

    return {
      summaryText,
      summaryEntries,
      activePromptText,
      activePromptChars: activePromptText.length,
      activeEntries,
    };
  }
}
