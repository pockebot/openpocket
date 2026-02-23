import fs from "node:fs";
import path from "node:path";

import type { AgentAction, OpenPocketConfig } from "../types.js";
import { ensureDir, nowForFilename } from "../utils/paths.js";

export interface StepTrace {
  step: number;
  action: AgentAction;
  result: string;
  thought: string;
  currentApp: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "task";
}

function encodeInputText(text: string): string {
  return text
    .replace(/ /g, "%s")
    .replace(/\n/g, "%s");
}

function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

export class AutoArtifactBuilder {
  private readonly config: OpenPocketConfig;

  constructor(config: OpenPocketConfig) {
    this.config = config;
  }

  build(params: {
    task: string;
    sessionPath: string;
    ok: boolean;
    finalMessage: string;
    traces: StepTrace[];
  }): { skillPath: string | null; scriptPath: string | null } {
    if (!params.ok || params.traces.length === 0) {
      return { skillPath: null, scriptPath: null };
    }

    const stamp = nowForFilename();
    const slug = slugify(params.task);
    const skillPath = this.writeSkill(stamp, slug, params);
    const scriptPath = this.writeScript(stamp, slug, params.traces);
    return { skillPath, scriptPath };
  }

  private writeSkill(
    stamp: string,
    slug: string,
    params: {
      task: string;
      sessionPath: string;
      finalMessage: string;
      traces: StepTrace[];
    },
  ): string {
    const dir = ensureDir(path.join(this.config.workspaceDir, "skills", "auto"));
    const filePath = path.join(dir, `${stamp}-${slug}.md`);

    const steps = params.traces
      .slice(0, 20)
      .map((t) => `- Step ${t.step}: ${t.action.type} on ${t.currentApp}`)
      .join("\n");

    const content = [
      `# Auto Skill: ${params.task}`,
      "",
      `- Generated: ${new Date().toISOString()}`,
      `- Source session: ${params.sessionPath}`,
      "",
      "## Trigger",
      "",
      `- Use when user asks: ${params.task}`,
      "",
      "## Execution Outline",
      "",
      steps || "- No steps captured.",
      "",
      "## Final Result",
      "",
      params.finalMessage,
      "",
      "## Notes",
      "",
      "- Review and refine before using as stable production skill.",
      "",
    ].join("\n");

    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  private writeScript(stamp: string, slug: string, traces: StepTrace[]): string | null {
    const lines: string[] = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      'DEVICE="${1:-$(adb devices | awk \"NR>1 && /device$/ {print \\\$1; exit}\")}"',
      'if [ -z "${DEVICE}" ]; then echo "No adb device"; exit 1; fi',
      "",
    ];

    let useful = false;

    for (const trace of traces) {
      const action = trace.action;
      lines.push(`# step ${trace.step}: ${action.type}`);
      if (action.type === "tap") {
        useful = true;
        lines.push(`adb -s "${'${DEVICE}'}" shell input tap ${Math.round(action.x)} ${Math.round(action.y)}`);
      } else if (action.type === "swipe") {
        useful = true;
        lines.push(
          `adb -s "${'${DEVICE}'}" shell input swipe ${Math.round(action.x1)} ${Math.round(action.y1)} ${Math.round(action.x2)} ${Math.round(action.y2)} ${Math.max(100, Math.round(action.durationMs ?? 300))}`,
        );
      } else if (action.type === "type") {
        useful = true;
        if (hasNonAscii(action.text)) {
          lines.push(
            `adb -s "${'${DEVICE}'}" shell cmd clipboard set text ${shellSingleQuote(action.text)}`,
          );
          lines.push(`adb -s "${'${DEVICE}'}" shell input keyevent KEYCODE_PASTE`);
        } else {
          lines.push(`adb -s "${'${DEVICE}'}" shell input text "${encodeInputText(action.text)}"`);
        }
      } else if (action.type === "keyevent") {
        useful = true;
        lines.push(`adb -s "${'${DEVICE}'}" shell input keyevent ${action.keycode}`);
      } else if (action.type === "launch_app") {
        useful = true;
        lines.push(
          `adb -s "${'${DEVICE}'}" shell monkey -p ${action.packageName} -c android.intent.category.LAUNCHER 1`,
        );
      } else if (action.type === "wait") {
        useful = true;
        lines.push(`sleep ${Math.max(0.1, (action.durationMs ?? 1000) / 1000)}`);
      } else if (action.type === "shell") {
        useful = true;
        lines.push(`adb -s "${'${DEVICE}'}" shell ${action.command}`);
      } else if (action.type === "run_script") {
        useful = true;
        lines.push("# Embedded script fallback:");
        lines.push("cat <<'SCRIPT' > /tmp/openpocket_embedded.sh");
        lines.push(action.script);
        lines.push("SCRIPT");
        lines.push("bash /tmp/openpocket_embedded.sh");
      }
      lines.push("");
    }

    if (!useful) {
      return null;
    }

    const dir = ensureDir(path.join(this.config.workspaceDir, "scripts", "auto"));
    const filePath = path.join(dir, `${stamp}-${slug}.sh`);
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o700 });
    return filePath;
  }
}
