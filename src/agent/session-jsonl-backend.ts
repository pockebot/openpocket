import fs from "node:fs";
import path from "node:path";

import type {
  SessionBackend,
  SessionCreatePayload,
  SessionFinalizePayload,
  SessionStepPayload,
} from "./session-backend.js";
import { ensureDir } from "../utils/paths.js";

export function toJsonlSessionPath(sessionPath: string): string {
  return sessionPath.endsWith(".md") ? `${sessionPath.slice(0, -3)}.jsonl` : `${sessionPath}.jsonl`;
}

function writeJsonlLine(filePath: string, value: Record<string, unknown>): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

export class SessionJsonlBackend implements SessionBackend {
  create(payload: SessionCreatePayload): void {
    const jsonlPath = toJsonlSessionPath(payload.sessionPath);
    ensureDir(path.dirname(jsonlPath));
    const line = {
      event: "session_started",
      sessionId: payload.sessionId,
      sessionPath: payload.sessionPath,
      startedAt: payload.startedAt,
      task: payload.task,
      modelProfile: payload.modelProfile,
      modelName: payload.modelName,
    };
    fs.writeFileSync(jsonlPath, `${JSON.stringify(line)}\n`, "utf-8");
  }

  appendStep(payload: SessionStepPayload): void {
    const jsonlPath = toJsonlSessionPath(payload.sessionPath);
    writeJsonlLine(jsonlPath, {
      event: "step_appended",
      sessionId: payload.sessionId,
      sessionPath: payload.sessionPath,
      stepNo: payload.stepNo,
      at: payload.at,
      thought: payload.thought || "",
      actionJson: payload.actionJson,
      result: payload.result,
      trace: payload.trace ?? null,
    });
  }

  finalize(payload: SessionFinalizePayload): void {
    const jsonlPath = toJsonlSessionPath(payload.sessionPath);
    writeJsonlLine(jsonlPath, {
      event: "session_finalized",
      sessionId: payload.sessionId,
      sessionPath: payload.sessionPath,
      status: payload.status,
      endedAt: payload.endedAt,
      message: payload.message,
    });
  }
}
