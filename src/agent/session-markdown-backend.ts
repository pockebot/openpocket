import fs from "node:fs";
import path from "node:path";

import type {
  SessionBackend,
  SessionCreatePayload,
  SessionFinalizePayload,
  SessionStepPayload,
} from "./session-backend.js";
import { ensureDir } from "../utils/paths.js";

export class SessionMarkdownBackend implements SessionBackend {
  create(payload: SessionCreatePayload): void {
    ensureDir(path.dirname(payload.sessionPath));
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
    fs.writeFileSync(payload.sessionPath, `${body}\n`, "utf-8");
  }

  appendStep(payload: SessionStepPayload): void {
    const block = [
      `### Step ${payload.stepNo}`,
      "",
      `- at: ${payload.at}`,
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
    ].join("\n");
    fs.appendFileSync(payload.sessionPath, block, "utf-8");
  }

  finalize(payload: SessionFinalizePayload): void {
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
    fs.appendFileSync(payload.sessionPath, block, "utf-8");
  }
}
