import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";

import type { AgentAction, OpenPocketConfig } from "../types.js";
import { openpocketHome } from "../utils/paths.js";

type PiCodingAction = Extract<AgentAction, {
  type: "read" | "write" | "edit" | "exec" | "process" | "apply_patch";
}>;

const DENY_PATTERNS: RegExp[] = [
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_SKILLS_DIR = path.resolve(path.join(__dirname, "..", "..", "skills"));

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

function flattenToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const value = (item as Record<string, unknown>).text;
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text;
}

export class PiCodingToolsExecutor {
  private readonly config: OpenPocketConfig;
  private readonly readTool: AgentTool<any>;
  private readonly writeTool: AgentTool<any>;
  private readonly editTool: AgentTool<any>;
  private readonly bashTool: AgentTool<any>;

  constructor(config: OpenPocketConfig) {
    this.config = config;
    this.readTool = createReadTool(this.config.workspaceDir, { autoResizeImages: false });
    this.writeTool = createWriteTool(this.config.workspaceDir);
    this.editTool = createEditTool(this.config.workspaceDir);
    this.bashTool = createBashTool(this.config.workspaceDir);
  }

  private pathWithin(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  private canUsePath(rawPath: string, options?: { allowSkillRootsForRead?: boolean }): boolean {
    if (!rawPath || !rawPath.trim()) {
      return false;
    }
    if (!this.config.codingTools.workspaceOnly) {
      return true;
    }

    const resolved = path.resolve(this.config.workspaceDir, rawPath.trim());
    if (this.pathWithin(this.config.workspaceDir, resolved)) {
      return true;
    }

    if (!options?.allowSkillRootsForRead) {
      return false;
    }

    const skillRoots = [
      path.join(this.config.workspaceDir, "skills"),
      path.join(openpocketHome(), "skills"),
      BUNDLED_SKILLS_DIR,
    ];
    return skillRoots.some((root) => this.pathWithin(root, resolved));
  }

  private resolveWorkdir(inputPath?: string): string | null {
    if (!inputPath || !inputPath.trim()) {
      return this.config.workspaceDir;
    }
    const raw = inputPath.trim();
    const resolved = path.resolve(this.config.workspaceDir, raw);
    if (!this.config.codingTools.workspaceOnly) {
      return resolved;
    }
    const relative = path.relative(this.config.workspaceDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return resolved;
  }

  private validateCommand(command: string): string | null {
    if (!command.trim()) {
      return "command is empty.";
    }
    for (const deny of DENY_PATTERNS) {
      if (deny.test(command)) {
        return `command blocked by safety rule: ${deny}`;
      }
    }

    const allow = new Set(this.config.codingTools.allowedCommands);
    const lines = command.split(/\r?\n/);
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
        if (!allow.has(cmd)) {
          return `command '${cmd}' is not allowed by codingTools.allowedCommands.`;
        }
      }
    }
    return null;
  }

  async execute(action: PiCodingAction): Promise<string | null> {
    if (!this.config.codingTools.enabled) {
      return null;
    }

    if (action.type === "read") {
      if (!this.canUsePath(action.path, { allowSkillRootsForRead: true })) {
        return null;
      }
      const result = await this.readTool.execute("pi-read", {
        path: action.path,
        offset: action.from,
        limit: action.lines,
      });
      return flattenToolText(result) || `read: ${action.path}`;
    }

    if (action.type === "write") {
      if (action.append) {
        return null;
      }
      if (!this.canUsePath(action.path)) {
        return null;
      }
      const result = await this.writeTool.execute("pi-write", {
        path: action.path,
        content: action.content,
      });
      return flattenToolText(result) || `write: ${action.path}`;
    }

    if (action.type === "edit") {
      if (action.replaceAll) {
        return null;
      }
      if (!this.canUsePath(action.path)) {
        return null;
      }
      const result = await this.editTool.execute("pi-edit", {
        path: action.path,
        oldText: action.find,
        newText: action.replace,
      });
      return flattenToolText(result) || `edit: ${action.path}`;
    }

    if (action.type === "exec") {
      if (action.background || action.yieldMs) {
        return null;
      }

      const validationError = this.validateCommand(action.command);
      if (validationError) {
        throw new Error(`exec rejected: ${validationError}`);
      }

      const cwd = this.resolveWorkdir(action.workdir);
      if (!cwd) {
        return null;
      }

      const timeoutSec = Math.max(1, Math.round(action.timeoutSec ?? this.config.codingTools.timeoutSec));
      const bashTool = cwd === this.config.workspaceDir ? this.bashTool : createBashTool(cwd);
      const result = await bashTool.execute("pi-bash", {
        command: action.command,
        timeout: timeoutSec,
      });
      return flattenToolText(result) || "exec completed";
    }

    return null;
  }
}
