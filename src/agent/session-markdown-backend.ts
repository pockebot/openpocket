import fs from "node:fs";
import path from "node:path";

import type {
  SessionBackend,
  SessionCreatePayload,
  SessionFinalizePayload,
  SessionStepPayload,
} from "./session-backend.js";
import { ensureDir } from "../utils/paths.js";

export function toMarkdownSessionPath(sessionPath: string): string {
  return sessionPath.endsWith(".jsonl") ? `${sessionPath.slice(0, -6)}.md` : `${sessionPath}.md`;
}

export class SessionMarkdownBackend implements SessionBackend {
  create(payload: SessionCreatePayload): void {
    const markdownPath = toMarkdownSessionPath(payload.sessionPath);
    ensureDir(path.dirname(markdownPath));
    if (fs.existsSync(markdownPath)) {
      const block = [
        "",
        "---",
        "",
        `## Task (${payload.startedAt})`,
        "",
        payload.task,
        "",
        "## Steps",
        "",
      ].join("\n");
      fs.appendFileSync(markdownPath, block, "utf-8");
      return;
    }
    const body = [
      "# OpenPocket Session",
      "",
      `- id: ${payload.sessionId}`,
      `- started_at: ${payload.startedAt}`,
      `- model_profile: ${payload.modelProfile}`,
      `- model_name: ${payload.modelName}`,
      "",
      "## Task",
      "",
      payload.task,
      "",
      "## Steps",
      "",
    ].join("\n");
    fs.writeFileSync(markdownPath, `${body}\n`, "utf-8");
  }

  appendStep(payload: SessionStepPayload): void {
    const trace = payload.trace;
    const markdownPath = toMarkdownSessionPath(payload.sessionPath);
    const block = [
      `### Step ${payload.stepNo}`,
      "",
      `- at: ${payload.at}`,
      trace ? `- action: ${trace.actionType}` : null,
      trace ? `- app: ${trace.currentApp}` : null,
      trace ? `- duration_ms: ${trace.durationMs}` : null,
      trace ? `- status: ${trace.status}` : null,
      "- thought:",
      "```text",
      payload.thought || "(empty)",
      "```",
      "- action:",
      "```json",
      payload.actionJson,
      "```",
      "- execution_result:",
      "```text",
      payload.result,
      "```",
      "",
    ].filter((line): line is string => line !== null).join("\n");
    fs.appendFileSync(markdownPath, block, "utf-8");
  }

  finalize(payload: SessionFinalizePayload): void {
    const markdownPath = toMarkdownSessionPath(payload.sessionPath);
    const block = [
      "## Final",
      "",
      `- status: ${payload.status}`,
      `- ended_at: ${payload.endedAt}`,
      "",
      "### Message",
      "",
      payload.message,
      "",
    ].join("\n");
    fs.appendFileSync(markdownPath, block, "utf-8");
  }
}
