import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FALLBACK_TEMPLATE_DIR = path.resolve(__dirname, "../../docs/reference/templates");

let cachedTemplateDir: string | null = null;
const templateContentCache = new Map<string, string>();

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const bodyStart = endIndex + "\n---".length;
  return content.slice(bodyStart).replace(/^\s+/, "");
}

export function resolveWorkspaceTemplateDir(opts?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (cachedTemplateDir) {
    return cachedTemplateDir;
  }

  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const envTemplateDir = env.OPENPOCKET_TEMPLATE_DIR?.trim();

  const candidates = [
    envTemplateDir ? path.resolve(envTemplateDir) : null,
    cwd ? path.resolve(cwd, "docs", "reference", "templates") : null,
    FALLBACK_TEMPLATE_DIR,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      cachedTemplateDir = candidate;
      return candidate;
    }
  }

  const first = candidates[0] ?? FALLBACK_TEMPLATE_DIR;
  throw new Error(
    `OpenPocket workspace template directory not found. Tried: ${candidates.join(", ")} (first candidate: ${first})`,
  );
}

export function loadWorkspaceTemplate(name: string): string {
  const templateDir = resolveWorkspaceTemplateDir();
  const templatePath = path.join(templateDir, name);
  const cacheKey = path.resolve(templatePath);
  const cached = templateContentCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let content: string;
  try {
    content = fs.readFileSync(templatePath, "utf-8");
  } catch {
    throw new Error(
      `Missing OpenPocket workspace template: ${name} (${templatePath}). Ensure docs/reference/templates is present.`,
    );
  }

  const normalized = name.toLowerCase().endsWith(".md")
    ? `${stripFrontMatter(content).trimEnd()}\n`
    : `${content.trimEnd()}\n`;
  templateContentCache.set(cacheKey, normalized);
  return normalized;
}

export function resetWorkspaceTemplateCache(): void {
  cachedTemplateDir = null;
  templateContentCache.clear();
}
