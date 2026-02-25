import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";

import type { AgentAction, OpenPocketConfig } from "../types.js";
import {
  resolveWorkdirPolicy,
  resolveWorkspacePathPolicy,
  validateCommandPolicy,
} from "./tool-policy.js";

type PiCodingAction = Extract<AgentAction, {
  type: "read" | "write" | "edit" | "exec" | "process" | "apply_patch";
}>;

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

  private canUsePath(rawPath: string, options?: { allowSkillRootsForRead?: boolean }): boolean {
    const resolved = resolveWorkspacePathPolicy({
      workspaceDir: this.config.workspaceDir,
      inputPath: rawPath,
      purpose: "path",
      workspaceOnly: this.config.codingTools.workspaceOnly,
      allowSkillRootsForRead: options?.allowSkillRootsForRead,
    });
    return resolved.ok;
  }

  private resolveWorkdir(inputPath?: string): string | null {
    const resolved = resolveWorkdirPolicy({
      workspaceDir: this.config.workspaceDir,
      inputPath,
      workspaceOnly: this.config.codingTools.workspaceOnly,
    });
    if (!resolved.ok || !resolved.resolved) {
      return null;
    }
    return resolved.resolved;
  }

  private validateCommand(command: string): string | null {
    return validateCommandPolicy({
      enabled: this.config.codingTools.enabled,
      disabledMessage: "coding tools are disabled by config.",
      command,
      emptyMessage: "command is empty.",
      allowCommands: this.config.codingTools.allowedCommands,
      allowlistName: "codingTools.allowedCommands",
    });
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
