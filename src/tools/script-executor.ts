import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { OpenPocketConfig } from "../types.js";
import { ensureDir, nowForFilename } from "../utils/paths.js";

export interface ScriptExecutionResult {
  ok: boolean;
  runId: string;
  runDir: string;
  scriptPath: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const DENY_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /rm\s+-rf\s+\/(\s|$)/i,
];

function stripComments(line: string): string {
  const idx = line.indexOf("#");
  if (idx < 0) {
    return line;
  }
  return line.slice(0, idx);
}

function splitToCommandSegments(line: string): string[] {
  return line
    .split(/&&|\|\||;/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function extractCommandName(segment: string): string {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[i])) {
    i += 1;
  }
  return tokens[i] ?? "";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

export class ScriptExecutor {
  private readonly config: OpenPocketConfig;
  private readonly scriptsDir: string;
  private readonly runsDir: string;

  constructor(config: OpenPocketConfig) {
    this.config = config;
    this.scriptsDir = ensureDir(path.join(config.workspaceDir, "scripts"));
    this.runsDir = ensureDir(path.join(this.scriptsDir, "runs"));
  }

  private validateScript(script: string): string | null {
    if (!this.config.scriptExecutor.enabled) {
      return "Script executor is disabled by config.";
    }

    if (script.trim().length === 0) {
      return "Script is empty.";
    }

    if (script.length > 12_000) {
      return "Script exceeds max length (12000 characters).";
    }

    for (const deny of DENY_PATTERNS) {
      if (deny.test(script)) {
        return `Script blocked by safety rule: ${deny}`;
      }
    }

    const allow = new Set(this.config.scriptExecutor.allowedCommands);
    const lines = script.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = stripComments(rawLine).trim();
      if (!line) {
        continue;
      }
      for (const segment of splitToCommandSegments(line)) {
        const cmd = extractCommandName(segment);
        if (!cmd) {
          continue;
        }
        if (!allow.has(cmd)) {
          return `Command '${cmd}' is not allowed by scriptExecutor.allowedCommands.`;
        }
      }
    }

    return null;
  }

  async execute(script: string, timeoutSec?: number): Promise<ScriptExecutionResult> {
    const validationError = this.validateScript(script);
    const runId = `${nowForFilename()}-${Math.random().toString(16).slice(2, 8)}`;
    const runDir = ensureDir(path.join(this.runsDir, `run-${runId}`));
    const scriptPath = path.join(runDir, "script.sh");

    fs.writeFileSync(scriptPath, `${script.trim()}\n`, { encoding: "utf-8", mode: 0o700 });

    if (validationError) {
      const result: ScriptExecutionResult = {
        ok: false,
        runId,
        runDir,
        scriptPath,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        stdout: "",
        stderr: validationError,
      };
      fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf-8");
      return result;
    }

    const timeoutMs = Math.max(1, timeoutSec ?? this.config.scriptExecutor.timeoutSec) * 1000;
    const maxChars = this.config.scriptExecutor.maxOutputChars;

    const started = Date.now();

    const result = await new Promise<ScriptExecutionResult>((resolve) => {
      const child = spawn("bash", [scriptPath], {
        cwd: this.scriptsDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          runId,
          runDir,
          scriptPath,
          exitCode: null,
          timedOut,
          durationMs: Date.now() - started,
          stdout: truncate(stdout, maxChars),
          stderr: truncate(`${stderr}\n${error.message}`.trim(), maxChars),
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: !timedOut && code === 0,
          runId,
          runDir,
          scriptPath,
          exitCode: code,
          timedOut,
          durationMs: Date.now() - started,
          stdout: truncate(stdout, maxChars),
          stderr: truncate(stderr, maxChars),
        });
      });
    });

    fs.writeFileSync(path.join(runDir, "stdout.log"), `${result.stdout}\n`, "utf-8");
    fs.writeFileSync(path.join(runDir, "stderr.log"), `${result.stderr}\n`, "utf-8");
    fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf-8");

    return result;
  }
}
