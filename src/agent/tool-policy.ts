import path from "node:path";
import { fileURLToPath } from "node:url";

import { openpocketHome } from "../utils/paths.js";

type ValidateCommandPolicyParams = {
  command: string;
  allowCommands: string[];
  allowlistName: string;
  enabled?: boolean;
  disabledMessage?: string;
  emptyMessage?: string;
};

type ResolveWorkspacePathPolicyParams = {
  workspaceDir: string;
  inputPath: string;
  purpose: string;
  workspaceOnly: boolean;
  allowSkillRootsForRead?: boolean;
};

type ResolveWorkdirPolicyParams = {
  workspaceDir: string;
  inputPath?: string;
  workspaceOnly: boolean;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_SKILLS_DIR = path.resolve(path.join(__dirname, "..", "..", "skills"));

export const COMMAND_DENY_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\brm\s+.*-[a-z]*r[a-z]*f[a-z]*\s+\//i,
  /\brm\s+.*-[a-z]*f[a-z]*r[a-z]*\s+\//i,
  /\brm\s+-rf\s/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\beval\b/i,
  /\bsource\b/i,
  /`[^`]+`/,
  /\$\([^)]+\)/,
];

const SENSITIVE_ENV_KEY_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
];

function splitPipelineSegments(line: string): string[] {
  return line
    .split(/&&|\|\||;|\|/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function extractCommandName(segment: string): string {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[i])) {
    i += 1;
  }
  const raw = tokens[i] ?? "";
  return raw.includes("/") ? raw.split("/").pop() ?? "" : raw;
}

export function pathWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveWorkspacePathPolicy(params: ResolveWorkspacePathPolicyParams): {
  ok: boolean;
  resolved?: string;
  error?: string;
} {
  const raw = String(params.inputPath ?? "").trim();
  if (!raw) {
    return { ok: false, error: `${params.purpose}: path is required.` };
  }

  const resolved = path.resolve(params.workspaceDir, raw);
  if (!params.workspaceOnly) {
    return { ok: true, resolved };
  }
  if (pathWithin(params.workspaceDir, resolved)) {
    return { ok: true, resolved };
  }

  if (params.allowSkillRootsForRead) {
    const skillRoots = [
      path.join(params.workspaceDir, "skills"),
      path.join(openpocketHome(), "skills"),
      BUNDLED_SKILLS_DIR,
    ];
    if (skillRoots.some((root) => pathWithin(root, resolved))) {
      return { ok: true, resolved };
    }
  }

  return { ok: false, error: `${params.purpose}: path escapes workspace (${raw}).` };
}

export function resolveWorkdirPolicy(params: ResolveWorkdirPolicyParams): {
  ok: boolean;
  resolved?: string;
  error?: string;
} {
  if (!params.inputPath || !params.inputPath.trim()) {
    return { ok: true, resolved: params.workspaceDir };
  }

  const raw = params.inputPath.trim();
  const resolved = path.resolve(params.workspaceDir, raw);
  if (!params.workspaceOnly) {
    return { ok: true, resolved };
  }

  const relative = path.relative(params.workspaceDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: `exec: workdir escapes workspace (${raw}).` };
  }

  return { ok: true, resolved };
}

export function validateCommandPolicy(params: ValidateCommandPolicyParams): string | null {
  if (params.enabled === false) {
    return params.disabledMessage ?? "command execution is disabled by config.";
  }

  if (!params.command.trim()) {
    return params.emptyMessage ?? "command is empty.";
  }

  for (const deny of COMMAND_DENY_PATTERNS) {
    if (deny.test(params.command)) {
      return `command blocked by safety rule: ${deny}`;
    }
  }

  const allow = new Set(params.allowCommands);
  const allowAll = allow.has("*");
  const lines = params.command.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    for (const segment of splitPipelineSegments(line)) {
      const cmd = extractCommandName(segment);
      if (!cmd) {
        continue;
      }
      if (!allowAll && !allow.has(cmd)) {
        return `command '${cmd}' is not allowed by ${params.allowlistName}.`;
      }
    }
  }

  return null;
}

export function buildSafeProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const isSensitive = SENSITIVE_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (!isSensitive) {
      env[key] = value;
    }
  }

  for (const key of ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"]) {
    if (baseEnv[key] !== undefined) {
      env[key] = baseEnv[key];
    }
  }

  return env;
}
