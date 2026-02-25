import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentAction, OpenPocketConfig } from "../types.js";
import { applyPatch } from "./apply-patch.js";
import {
  buildSafeProcessEnv,
  pathWithin,
  resolveWorkdirPolicy,
  resolveWorkspacePathPolicy,
  validateCommandPolicy,
} from "../agent/tool-policy.js";

type ReadAction = Extract<AgentAction, { type: "read" }>;
type WriteAction = Extract<AgentAction, { type: "write" }>;
type EditAction = Extract<AgentAction, { type: "edit" }>;
type ApplyPatchAction = Extract<AgentAction, { type: "apply_patch" }>;
type ExecAction = Extract<AgentAction, { type: "exec" }>;
type ProcessAction = Extract<AgentAction, { type: "process" }>;

type ProcessSessionStatus = "running" | "completed" | "failed" | "killed" | "timeout";

type ProcessSession = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  status: ProcessSessionStatus;
  exitCode: number | null;
  timedOut: boolean;
  child: ChildProcessWithoutNullStreams | null;
  stdinClosed: boolean;
  output: string;
  donePromise: Promise<void>;
  resolveDone: () => void;
};

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nowId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

export class CodingExecutor {
  private readonly config: OpenPocketConfig;
  private readonly sessions = new Map<string, ProcessSession>();

  constructor(config: OpenPocketConfig) {
    this.config = config;
  }

  private resolveWorkspacePath(
    inputPath: string,
    purpose: string,
    options?: { allowSkillRootsForRead?: boolean },
  ): string {
    const resolved = resolveWorkspacePathPolicy({
      workspaceDir: this.config.workspaceDir,
      inputPath,
      purpose,
      workspaceOnly: this.config.codingTools.workspaceOnly,
      allowSkillRootsForRead: options?.allowSkillRootsForRead,
    });
    if (!resolved.ok || !resolved.resolved) {
      throw new Error(resolved.error ?? `${purpose}: path is not allowed.`);
    }
    return resolved.resolved;
  }

  private resolveWorkdir(inputPath?: string): string {
    const resolved = resolveWorkdirPolicy({
      workspaceDir: this.config.workspaceDir,
      inputPath,
      workspaceOnly: this.config.codingTools.workspaceOnly,
    });
    if (!resolved.ok || !resolved.resolved) {
      throw new Error(resolved.error ?? "exec: workdir is not allowed.");
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

  private appendSessionOutput(session: ProcessSession, chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!text) {
      return;
    }
    const combined = `${session.output}${text}`;
    const cap = Math.max(this.config.codingTools.maxOutputChars * 12, 48_000);
    if (combined.length <= cap) {
      session.output = combined;
      return;
    }
    session.output = `...[trimmed]\n${combined.slice(combined.length - cap)}`;
  }

  private finalizeSession(session: ProcessSession, params: {
    status: ProcessSessionStatus;
    exitCode: number | null;
    timedOut?: boolean;
  }): void {
    if (session.status !== "running") {
      return;
    }
    session.status = params.status;
    session.exitCode = params.exitCode;
    session.timedOut = Boolean(params.timedOut);
    session.endedAt = Date.now();
    session.child = null;
    session.resolveDone();
    this.evictOldSessions();
  }

  private evictOldSessions(): void {
    if (this.sessions.size <= 80) {
      return;
    }
    const all = [...this.sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const session of all) {
      if (this.sessions.size <= 60) {
        break;
      }
      if (session.status === "running") {
        continue;
      }
      this.sessions.delete(session.id);
    }
  }

  private formatSessionSummary(session: ProcessSession): string {
    const runtimeMs = (session.endedAt ?? Date.now()) - session.startedAt;
    return [
      `session=${session.id}`,
      `status=${session.status}`,
      `runtimeMs=${runtimeMs}`,
      `exitCode=${session.exitCode ?? "n/a"}`,
      `cwd=${session.cwd}`,
      `command=${session.command}`,
      session.output ? `output=\n${truncate(session.output.trim(), this.config.codingTools.maxOutputChars)}` : "output=(empty)",
    ].join("\n");
  }

  private async readFile(action: ReadAction): Promise<string> {
    const filePath = this.resolveWorkspacePath(action.path, "read", { allowSkillRootsForRead: true });
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    const from = Math.max(1, Math.round(action.from ?? 1));
    const maxLines = Math.max(1, Math.min(1000, Math.round(action.lines ?? 200)));
    const start = Math.max(0, from - 1);
    const end = Math.min(lines.length, start + maxLines);
    const snippet = lines.slice(start, end).join("\n");
    const rel = pathWithin(this.config.workspaceDir, filePath)
      ? (path.relative(this.config.workspaceDir, filePath) || path.basename(filePath))
      : filePath;
    return [
      `read path=${rel}`,
      `range=${from}-${end} totalLines=${lines.length}`,
      snippet || "(empty)",
    ].join("\n");
  }

  private async writeFile(action: WriteAction): Promise<string> {
    const filePath = this.resolveWorkspacePath(action.path, "write");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = String(action.content ?? "");
    if (action.append) {
      fs.appendFileSync(filePath, content, "utf8");
    } else {
      fs.writeFileSync(filePath, content, "utf8");
    }
    const rel = path.relative(this.config.workspaceDir, filePath) || path.basename(filePath);
    return `write path=${rel} bytes=${Buffer.byteLength(content, "utf8")} append=${Boolean(action.append)}`;
  }

  private async editFile(action: EditAction): Promise<string> {
    const filePath = this.resolveWorkspacePath(action.path, "edit");
    const find = String(action.find ?? "");
    if (!find) {
      throw new Error("edit: find must be non-empty.");
    }
    const replace = String(action.replace ?? "");
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.includes(find)) {
      throw new Error("edit: find text not present in target file.");
    }
    let replaced = 0;
    let next = raw;
    if (action.replaceAll) {
      const parts = raw.split(find);
      replaced = parts.length - 1;
      next = parts.join(replace);
    } else {
      replaced = 1;
      next = raw.replace(find, replace);
    }
    fs.writeFileSync(filePath, next, "utf8");
    const rel = path.relative(this.config.workspaceDir, filePath) || path.basename(filePath);
    return `edit path=${rel} replacements=${replaced}`;
  }

  private async applyPatchAction(action: ApplyPatchAction): Promise<string> {
    if (!this.config.codingTools.applyPatchEnabled) {
      throw new Error("apply_patch is disabled by config.");
    }
    const input = String(action.input ?? "");
    const result = await applyPatch(input, {
      cwd: this.config.workspaceDir,
      workspaceOnly: this.config.codingTools.workspaceOnly,
    });
    return result.text;
  }

  private async execCommand(action: ExecAction): Promise<string> {
    const command = String(action.command ?? "").trim();
    const validationError = this.validateCommand(command);
    if (validationError) {
      throw new Error(`exec rejected: ${validationError}`);
    }

    const cwd = this.resolveWorkdir(action.workdir);
    const timeoutSec = Math.max(1, Math.round(action.timeoutSec ?? this.config.codingTools.timeoutSec));
    const timeoutMs = timeoutSec * 1000;
    const allowBackground = this.config.codingTools.allowBackground;
    const backgroundRequested = Boolean(action.background) && allowBackground;
    const yieldMs = Math.max(0, Math.round(action.yieldMs ?? 0));

    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: buildSafeProcessEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: ProcessSession = {
      id: nowId(),
      command,
      cwd,
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      exitCode: null,
      timedOut: false,
      child,
      stdinClosed: false,
      output: "",
      donePromise,
      resolveDone,
    };
    this.sessions.set(session.id, session);

    const timeout = setTimeout(() => {
      if (session.status !== "running") {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore kill errors
      }
      this.finalizeSession(session, { status: "timeout", exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => this.appendSessionOutput(session, chunk));
    child.stderr.on("data", (chunk) => this.appendSessionOutput(session, chunk));
    child.on("error", (error) => {
      this.appendSessionOutput(session, `\n[exec-error] ${error.message}\n`);
      this.finalizeSession(session, { status: "failed", exitCode: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (session.status !== "running") {
        return;
      }
      if (signal) {
        this.finalizeSession(session, { status: "killed", exitCode: code });
        return;
      }
      this.finalizeSession(session, {
        status: code === 0 ? "completed" : "failed",
        exitCode: code,
      });
    });

    if (backgroundRequested) {
      return `exec started in background: session=${session.id}\ncommand=${command}\ncwd=${cwd}`;
    }

    if (yieldMs > 0 && allowBackground) {
      await Promise.race([session.donePromise, sleep(yieldMs)]);
      if (session.status === "running") {
        return `exec still running: session=${session.id}\nuse process action=poll/log/kill`;
      }
      return this.formatSessionSummary(session);
    }

    await session.donePromise;
    return this.formatSessionSummary(session);
  }

  private findSession(sessionId: string): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`process: session not found (${sessionId})`);
    }
    return session;
  }

  private processList(): string {
    const items = [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
    if (items.length === 0) {
      return "process list: no sessions";
    }
    const lines = items.map((session) => {
      const runtimeMs = (session.endedAt ?? Date.now()) - session.startedAt;
      return `${session.id} status=${session.status} runtimeMs=${runtimeMs} command=${session.command}`;
    });
    return `process list (${items.length}):\n${lines.join("\n")}`;
  }

  private processLog(action: ProcessAction): string {
    if (!action.sessionId) {
      throw new Error("process log: sessionId is required.");
    }
    const session = this.findSession(action.sessionId);
    const allLines = session.output.split(/\r?\n/);
    const total = allLines.length;
    const defaultLimit = 200;
    const limit = Math.max(1, Math.min(2000, Math.round(action.limit ?? defaultLimit)));
    const offset = action.offset === undefined
      ? Math.max(0, total - limit)
      : Math.max(0, Math.min(total, Math.round(action.offset)));
    const end = Math.min(total, offset + limit);
    const snippet = allLines.slice(offset, end).join("\n");
    return [
      `process log session=${session.id}`,
      `status=${session.status}`,
      `range=${offset}-${end} total=${total}`,
      snippet || "(empty)",
    ].join("\n");
  }

  private async processPoll(action: ProcessAction): Promise<string> {
    if (!action.sessionId) {
      throw new Error("process poll: sessionId is required.");
    }
    const session = this.findSession(action.sessionId);
    const timeoutMs = Math.max(0, Math.min(120_000, Math.round(action.timeoutMs ?? 0)));
    if (session.status === "running" && timeoutMs > 0) {
      const started = Date.now();
      while (session.status === "running" && Date.now() - started < timeoutMs) {
        await sleep(120);
      }
    }
    return this.formatSessionSummary(session);
  }

  private processWrite(action: ProcessAction): string {
    if (!action.sessionId) {
      throw new Error("process write: sessionId is required.");
    }
    const session = this.findSession(action.sessionId);
    if (session.status !== "running" || !session.child || !session.child.stdin || session.stdinClosed) {
      throw new Error(`process write: session ${session.id} is not writable.`);
    }
    const input = String(action.input ?? "");
    session.child.stdin.write(input);
    return `process write: session=${session.id} bytes=${Buffer.byteLength(input, "utf8")}`;
  }

  private processKill(action: ProcessAction): string {
    if (!action.sessionId) {
      throw new Error("process kill: sessionId is required.");
    }
    const session = this.findSession(action.sessionId);
    if (session.status !== "running" || !session.child) {
      return `process kill: session=${session.id} already ${session.status}`;
    }
    try {
      session.child.kill("SIGTERM");
    } catch {
      // ignore signal errors
    }
    this.finalizeSession(session, { status: "killed", exitCode: null });
    return `process kill: session=${session.id} requested`;
  }

  private async processAction(action: ProcessAction): Promise<string> {
    const op = action.action;
    if (op === "list") {
      return this.processList();
    }
    if (op === "log") {
      return this.processLog(action);
    }
    if (op === "poll") {
      return this.processPoll(action);
    }
    if (op === "write") {
      return this.processWrite(action);
    }
    if (op === "kill") {
      return this.processKill(action);
    }
    throw new Error(`process: unsupported action '${op}'`);
  }

  async execute(action: AgentAction): Promise<string> {
    if (action.type === "read") {
      return this.readFile(action);
    }
    if (action.type === "write") {
      return this.writeFile(action);
    }
    if (action.type === "edit") {
      return this.editFile(action);
    }
    if (action.type === "apply_patch") {
      return this.applyPatchAction(action);
    }
    if (action.type === "exec") {
      return this.execCommand(action);
    }
    if (action.type === "process") {
      return this.processAction(action);
    }
    throw new Error(`coding executor does not support action type '${action.type}'`);
  }
}
