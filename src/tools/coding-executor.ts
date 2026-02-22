import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentAction, OpenPocketConfig } from "../types";
import { applyPatch } from "./apply-patch";

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

/** Split a pipe chain into individual command segments. */
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
  // Strip any leading path (e.g. /usr/bin/node -> node) to prevent allowlist bypass.
  return raw.includes("/") ? raw.split("/").pop() ?? "" : raw;
}

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

  /** Build an env object that strips sensitive API keys and tokens. */
  private buildSafeEnv(): Record<string, string | undefined> {
    const sensitivePatterns = [
      /api[_-]?key/i,
      /secret/i,
      /token/i,
      /password/i,
      /credential/i,
      /auth/i,
    ];
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      const isSensitive = sensitivePatterns.some((pattern) => pattern.test(key));
      if (!isSensitive) {
        env[key] = value;
      }
    }
    // Preserve PATH and common non-sensitive vars even if they match loosely.
    env.PATH = process.env.PATH;
    env.HOME = process.env.HOME;
    env.USER = process.env.USER;
    env.SHELL = process.env.SHELL;
    env.LANG = process.env.LANG;
    env.TERM = process.env.TERM;
    return env;
  }

  private resolveWorkspacePath(inputPath: string, purpose: string): string {
    const raw = String(inputPath || "").trim();
    if (!raw) {
      throw new Error(`${purpose}: path is required.`);
    }
    const resolved = path.resolve(this.config.workspaceDir, raw);
    if (!this.config.codingTools.workspaceOnly) {
      return resolved;
    }
    const relative = path.relative(this.config.workspaceDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${purpose}: path escapes workspace (${raw}).`);
    }
    return resolved;
  }

  private resolveWorkdir(inputPath?: string): string {
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
      throw new Error(`exec: workdir escapes workspace (${raw}).`);
    }
    return resolved;
  }

  private validateCommand(command: string): string | null {
    if (!this.config.codingTools.enabled) {
      return "coding tools are disabled by config.";
    }
    if (!command.trim()) {
      return "command is empty.";
    }
    // Run deny patterns against the raw (un-stripped) command to prevent bypass via
    // comments, backticks, or $() substitutions.
    for (const deny of DENY_PATTERNS) {
      if (deny.test(command)) {
        return `command blocked by safety rule: ${deny}`;
      }
    }
    const allow = new Set(this.config.codingTools.allowedCommands);
    const lines = command.split(/\r?\n/);
    for (const rawLine of lines) {
      // Do NOT strip comments before allowlist check — the full raw line
      // is what bash actually executes.
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
    const filePath = this.resolveWorkspacePath(action.path, "read");
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    const from = Math.max(1, Math.round(action.from ?? 1));
    const maxLines = Math.max(1, Math.min(1000, Math.round(action.lines ?? 200)));
    const start = Math.max(0, from - 1);
    const end = Math.min(lines.length, start + maxLines);
    const snippet = lines.slice(start, end).join("\n");
    const rel = path.relative(this.config.workspaceDir, filePath) || path.basename(filePath);
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
      env: this.buildSafeEnv(),
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
