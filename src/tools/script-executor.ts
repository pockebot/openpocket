import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { OpenPocketConfig } from "../types.js";
import { ensureDir, nowForFilename } from "../utils/paths.js";
import { buildSafeProcessEnv, validateCommandPolicy } from "../agent/tool-policy.js";

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
    if (script.length > 12_000) {
      return "Script exceeds max length (12000 characters).";
    }

    return validateCommandPolicy({
      enabled: this.config.scriptExecutor.enabled,
      disabledMessage: "Script executor is disabled by config.",
      command: script,
      emptyMessage: "Script is empty.",
      allowCommands: this.config.scriptExecutor.allowedCommands,
      allowlistName: "scriptExecutor.allowedCommands",
    });
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
        env: buildSafeProcessEnv(process.env),
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
