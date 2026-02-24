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

function compactText(text: string, maxChars = 220): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function actionSummary(action: AgentAction): string {
  if (action.type === "tap") {
    return `tap(${Math.round(action.x)}, ${Math.round(action.y)})`;
  }
  if (action.type === "tap_element") {
    return `tap_element(elementId=${action.elementId})`;
  }
  if (action.type === "swipe") {
    return `swipe(${Math.round(action.x1)}, ${Math.round(action.y1)} -> ${Math.round(action.x2)}, ${Math.round(action.y2)})`;
  }
  if (action.type === "type") {
    return `type(${JSON.stringify(compactText(action.text, 72))})`;
  }
  if (action.type === "keyevent") {
    return `keyevent(${action.keycode})`;
  }
  if (action.type === "launch_app") {
    return `launch_app(${action.packageName})`;
  }
  if (action.type === "wait") {
    return `wait(${Math.round(action.durationMs ?? 1000)}ms)`;
  }
  if (action.type === "shell") {
    return `shell(${compactText(action.command, 96)})`;
  }
  if (action.type === "run_script") {
    return "run_script(<embedded>)";
  }
  if (action.type === "request_human_auth") {
    return `request_human_auth(${action.capability})`;
  }
  if (action.type === "request_user_decision") {
    return `request_user_decision(${compactText(action.question, 72)})`;
  }
  if (action.type === "finish") {
    return "finish(...)";
  }
  return action.type;
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
    const artifactsEnabled = (this.config as { agent?: { autoArtifactsEnabled?: boolean } })
      .agent?.autoArtifactsEnabled ?? true;
    if (!artifactsEnabled || !params.ok || params.traces.length === 0) {
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

    const shortTask = compactText(params.task, 180);
    const traceSlice = params.traces.slice(0, 25);
    const actionKinds = new Set(traceSlice.map((trace) => trace.action.type));
    const confidence = traceSlice.length >= 4 && actionKinds.size >= 2 ? "medium" : "low";
    const procedure = traceSlice
      .map((trace, index) => {
        const stepLine = `${index + 1}. ${actionSummary(trace.action)} (app=${trace.currentApp || "unknown"})`;
        const thought = compactText(trace.thought, 160);
        const result = compactText(trace.result, 180);
        const details = [
          thought ? `   - intent: ${thought}` : "",
          result ? `   - observed: ${result}` : "",
        ].filter(Boolean);
        return [stepLine, ...details].join("\n");
      })
      .join("\n");

    const content = [
      `# Skill Draft: ${shortTask}`,
      "",
      `- Status: draft (auto-generated, needs review)`,
      `- Confidence: ${confidence}`,
      `- Generated: ${new Date().toISOString()}`,
      `- Source session: ${params.sessionPath}`,
      "",
      "## When To Use",
      "",
      `- User asks something equivalent to: ${shortTask}`,
      `- Same app surface/workflow and similar UI layout is available.`,
      "",
      "## Preconditions",
      "",
      "- Emulator/device is online and controllable.",
      "- Required account/login state from source session is still valid.",
      "- If sensitive data/auth is needed, call `request_human_auth` instead of guessing.",
      "",
      "## Procedure (Draft)",
      "",
      procedure || "1. No deterministic steps captured.",
      "",
      "## Completion Criteria",
      "",
      "- Task-specific expected end state is reached on screen.",
      "- Final user-visible result is explicitly confirmed before finish.",
      "",
      "## Last Known Outcome",
      "",
      compactText(params.finalMessage, 500) || "(empty)",
      "",
      "## Refinement Checklist",
      "",
      "- Replace fragile coordinates with semantic element intent where possible.",
      "- Add explicit failure branches (empty state, auth wall, loading timeout).",
      "- Validate on at least one fresh run before promoting out of `skills/auto`.",
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
