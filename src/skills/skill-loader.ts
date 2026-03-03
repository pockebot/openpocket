import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenPocketConfig, SkillInfo } from "../types.js";
import { validateSkillPath } from "./spec-validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { ensureDir, openpocketHome } from "../utils/paths.js";

const SOURCE_PRIORITY: Record<SkillInfo["source"], number> = {
  bundled: 0,
  local: 1,
  workspace: 2,
};

const DEFAULT_SUMMARY_ITEMS = 20;
const DEFAULT_MAX_ACTIVE_SKILLS = 2;
const DEFAULT_MAX_ACTIVE_SKILL_CHARS = 4_000;
const DEFAULT_MAX_ACTIVE_TOTAL_CHARS = 7_500;
const ACTIVE_SKILL_MIN_SCORE = 6;

const SKILL_MATCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "for",
  "flow",
  "from",
  "help",
  "in",
  "into",
  "of",
  "on",
  "or",
  "play",
  "skill",
  "the",
  "to",
  "use",
  "with",
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

type SkillsSpecMode = OpenPocketConfig["agent"]["skillsSpecMode"];

function normalizeSkillsSpecMode(mode: unknown): SkillsSpecMode {
  const normalized = String(mode ?? "").toLowerCase().trim();
  if (normalized === "legacy" || normalized === "strict") {
    return normalized;
  }
  return "mixed";
}

function listSkillMarkdownFilesRecursive(root: string, mode: SkillsSpecMode): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (mode === "strict") {
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (entry.name.toLowerCase() !== "skill.md") {
          continue;
        }
        out.push(path.join(dir, entry.name));
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        }
      }
      continue;
    }

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

function formatSummaryLine(skill: SkillInfo): string {
  return `- name="${skill.name}" source="${skill.source}" location="${skill.path}" description="${skill.description.replace(/"/g, "'")}"`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(token: string): string {
  const normalized = token.toLowerCase().trim();
  if (normalized.length > 4 && normalized.endsWith("s")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function extractKeywords(value: string): string[] {
  const normalized = normalizeForMatch(value);
  if (!normalized) {
    return [];
  }
  const out = new Set<string>();
  for (const raw of normalized.split(" ")) {
    const token = normalizeToken(raw);
    if (token.length < 3) {
      continue;
    }
    if (SKILL_MATCH_STOPWORDS.has(token)) {
      continue;
    }
    out.add(token);
  }
  return [...out];
}

function parseTriggerPhrases(metadata: Record<string, unknown> | null): string[] {
  const openclawRaw = metadata?.openclaw;
  const openclaw = openclawRaw && typeof openclawRaw === "object" && !Array.isArray(openclawRaw)
    ? openclawRaw as Record<string, unknown>
    : null;
  const triggersRaw = openclaw?.triggers;
  const triggers = triggersRaw && typeof triggersRaw === "object" && !Array.isArray(triggersRaw)
    ? triggersRaw as Record<string, unknown>
    : null;
  const phrases = [
    ...toStringArray(triggers?.any),
    ...toStringArray(triggers?.all),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(phrases)];
}

type SkillTaskScore = {
  skill: LoadedSkill;
  score: number;
  reason: string;
};

function scoreSkillForTask(skill: LoadedSkill, task: string): SkillTaskScore {
  const normalizedTask = normalizeForMatch(task);
  if (!normalizedTask) {
    return { skill, score: 0, reason: "no task text" };
  }
  const taskTokens = new Set(
    extractKeywords(normalizedTask).map((token) => normalizeToken(token)),
  );

  let score = 0;
  const reasonBits: string[] = [];
  const isHumanAuthSkill = skill.id.startsWith("human-auth-");

  for (const phrase of parseTriggerPhrases(skill.metadata)) {
    const normalizedPhrase = normalizeForMatch(phrase);
    if (!normalizedPhrase) {
      continue;
    }
    if (normalizedTask.includes(normalizedPhrase)) {
      const phraseWordCount = normalizedPhrase.split(" ").filter(Boolean).length;
      score += phraseWordCount >= 2 ? 10 : 4;
      reasonBits.push(`trigger:"${phrase}"`);
    }
  }

  const signatureKeywords = [
    ...extractKeywords(skill.id),
    ...extractKeywords(skill.name),
    ...extractKeywords(skill.description),
  ];
  const uniqueSignature = [...new Set(signatureKeywords.map((token) => normalizeToken(token)))];
  const matchedSignature = uniqueSignature.filter((token) => taskTokens.has(token));
  if (matchedSignature.length > 0) {
    score += matchedSignature.length * 2;
    reasonBits.push(`keyword:${matchedSignature.slice(0, 4).join(",")}`);
  }

  const nameKeywords = extractKeywords(`${skill.id} ${skill.name}`).map((token) => normalizeToken(token));
  const uniqueNameKeywords = [...new Set(nameKeywords)];
  if (uniqueNameKeywords.length > 0) {
    const matchedName = uniqueNameKeywords.filter((token) => taskTokens.has(token));
    if (matchedName.length === uniqueNameKeywords.length) {
      score += 4;
      reasonBits.push("all-name-keywords");
    }
  }

  if (isHumanAuthSkill) {
    const humanAuthIntent = /request.human.auth|human.auth|human.phone|oauth|login|password|passkey|otp|2fa|sms.code|verification.code|payment.card|biometric|nfc/.test(normalizedTask);
    if (!humanAuthIntent) {
      score -= 6;
      reasonBits.push("human-auth-penalty");
    }
  }

  return {
    skill,
    score,
    reason: reasonBits.join("; ") || "weak match",
  };
}

function formatActiveSkillBlock(
  skill: LoadedSkill,
  reason: string,
  score: number,
  content: string,
): string {
  const safeName = escapeAttr(skill.name);
  const safeSource = escapeAttr(skill.source);
  const safePath = escapeAttr(skill.path);
  const safeReason = escapeAttr(reason);
  const safeScore = Number.isFinite(score) ? score.toFixed(2) : "0.00";
  return [
    `<active_skill name="${safeName}" source="${safeSource}" location="${safePath}" score="${safeScore}" reason="${safeReason}">`,
    content.trim(),
    "</active_skill>",
  ].join("\n");
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
      { source: "bundled", dir: bundledDir },
      { source: "local", dir: localDir },
      { source: "workspace", dir: workspaceDir },
    ];
  }

  private loadDetailedFromSourceDir(
    sourceDir: { source: SkillInfo["source"]; dir: string },
    options: { ignoreRequirements?: boolean } = {},
  ): LoadedSkill[] {
    const out: LoadedSkill[] = [];
    const skillsSpecMode = normalizeSkillsSpecMode(this.config.agent.skillsSpecMode);
    const files = listSkillMarkdownFilesRecursive(sourceDir.dir, skillsSpecMode);
    for (const filePath of files) {
      if (skillsSpecMode === "strict") {
        const validation = validateSkillPath(filePath, { strict: true });
        if (!validation.ok) {
          continue;
        }
      }
      const skill = parseLoadedSkill(filePath, sourceDir.source);
      if (!options.ignoreRequirements) {
        const requirements = parseSkillRequirements(skill.metadata);
        if (!satisfiesRequirements(this.config, requirements)) {
          continue;
        }
      }
      out.push(skill);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  loadDetailedBySource(
    source: SkillInfo["source"],
    options: { ignoreRequirements?: boolean } = {},
  ): LoadedSkill[] {
    const sourceDir = this.sourceDirs().find((item) => item.source === source);
    if (!sourceDir) {
      return [];
    }
    return this.loadDetailedFromSourceDir(sourceDir, options);
  }

  loadDetailedAll(): LoadedSkill[] {
    const selected = new Map<string, LoadedSkill>();

    for (const sourceDir of this.sourceDirs()) {
      const sourceSkills = this.loadDetailedFromSourceDir(sourceDir);
      for (const skill of sourceSkills) {
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

  buildPromptContextForTask(
    task: string,
    options?: {
      maxSummaryItems?: number;
      maxActiveSkills?: number;
      maxActiveSkillChars?: number;
      maxActiveTotalChars?: number;
    },
  ): SkillPromptContext {
    const allSkills = this.loadDetailedAll();
    const requestedSummaryItems = options?.maxSummaryItems;
    const maxSummaryItems = Number.isFinite(requestedSummaryItems)
      ? Math.max(1, Math.round(Number(requestedSummaryItems)))
      : Math.max(1, allSkills.length || DEFAULT_SUMMARY_ITEMS);
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
    const requestedActiveSkills = options?.maxActiveSkills;
    const maxActiveSkills = Number.isFinite(requestedActiveSkills)
      ? Math.max(0, Math.round(Number(requestedActiveSkills)))
      : DEFAULT_MAX_ACTIVE_SKILLS;
    const requestedPerSkillChars = options?.maxActiveSkillChars;
    const maxActiveSkillChars = Number.isFinite(requestedPerSkillChars)
      ? Math.max(200, Math.round(Number(requestedPerSkillChars)))
      : DEFAULT_MAX_ACTIVE_SKILL_CHARS;
    const requestedTotalChars = options?.maxActiveTotalChars;
    const maxActiveTotalChars = Number.isFinite(requestedTotalChars)
      ? Math.max(400, Math.round(Number(requestedTotalChars)))
      : DEFAULT_MAX_ACTIVE_TOTAL_CHARS;

    const scored = allSkills
      .map((skill) => scoreSkillForTask(skill, task))
      .filter((entry) => entry.score >= ACTIVE_SKILL_MIN_SCORE)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        const sourceDelta = SOURCE_PRIORITY[a.skill.source] - SOURCE_PRIORITY[b.skill.source];
        if (sourceDelta !== 0) {
          return sourceDelta;
        }
        return a.skill.name.localeCompare(b.skill.name);
      })
      .slice(0, maxActiveSkills);

    const activeEntries: ActiveSkillPromptEntry[] = [];
    const activeBlocks: string[] = [];
    let usedChars = 0;

    for (const scoredSkill of scored) {
      const remainingChars = maxActiveTotalChars - usedChars;
      if (remainingChars <= 0) {
        break;
      }
      const allowedChars = Math.max(200, Math.min(maxActiveSkillChars, remainingChars));
      const fullContent = scoredSkill.skill.content.trim();
      const truncated = fullContent.length > allowedChars;
      const content = truncated
        ? `${fullContent.slice(0, Math.max(0, allowedChars - 26)).trimEnd()}\n...[truncated by skill-loader]`
        : fullContent;
      const block = formatActiveSkillBlock(scoredSkill.skill, scoredSkill.reason, scoredSkill.score, content);

      activeEntries.push({
        skill: {
          id: scoredSkill.skill.id,
          name: scoredSkill.skill.name,
          description: scoredSkill.skill.description,
          source: scoredSkill.skill.source,
          path: scoredSkill.skill.path,
        },
        reason: scoredSkill.reason,
        score: scoredSkill.score,
        contentChars: content.length,
        truncated,
      });
      activeBlocks.push(block);
      usedChars += block.length;
    }

    const activePromptText = activeBlocks.join("\n\n");

    return {
      summaryText,
      summaryEntries,
      activePromptText,
      activePromptChars: activePromptText.length,
      activeEntries,
    };
  }
}
