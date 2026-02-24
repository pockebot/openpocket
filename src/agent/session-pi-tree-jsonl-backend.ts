import path from "node:path";

import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";

import type {
  SessionBackend,
  SessionCreatePayload,
  SessionFinalizePayload,
  SessionStepPayload,
} from "./session-backend.js";
import { ensureDir } from "../utils/paths.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function toUnixMs(isoOrDate: string): number {
  const parsed = Date.parse(isoOrDate);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return Date.now();
}

type SessionHeaderEntry = {
  type: "session";
  id?: string;
  version?: number;
  cwd?: string;
};

type InternalSessionManagerShape = {
  sessionId: string;
  fileEntries: Array<SessionHeaderEntry | { type: string }>;
};

function ensureSessionManagerHeader(manager: SessionManager, sessionId: string): void {
  const internal = manager as unknown as InternalSessionManagerShape;
  const header = internal.fileEntries.find(
    (entry): entry is SessionHeaderEntry => entry.type === "session",
  );
  if (!header) {
    return;
  }
  header.id = sessionId;
  header.version = CURRENT_SESSION_VERSION;
  header.cwd = process.cwd();
  internal.sessionId = sessionId;
}

function appendCustomLogMessage(params: {
  manager: SessionManager;
  customType: string;
  content: string;
  timestamp: number;
  details?: Record<string, unknown>;
}): void {
  params.manager.appendMessage({
    role: "custom",
    customType: params.customType,
    content: [{ type: "text", text: params.content }],
    display: false,
    details: params.details,
    timestamp: params.timestamp,
  });
}

export class SessionPiTreeJsonlBackend implements SessionBackend {
  create(payload: SessionCreatePayload): void {
    ensureDir(path.dirname(payload.sessionPath));
    const startedAtMs = toUnixMs(payload.startedAt);
    const manager = SessionManager.open(payload.sessionPath);
    ensureSessionManagerHeader(manager, payload.sessionId);

    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: payload.task }],
      timestamp: startedAtMs,
    });

    appendCustomLogMessage({
      manager,
      customType: "openpocket_session_meta",
      content: [
        `model_profile: ${payload.modelProfile}`,
        `model_name: ${payload.modelName}`,
        payload.sessionKey ? `session_key: ${payload.sessionKey}` : null,
      ].filter(Boolean).join("\n"),
      timestamp: startedAtMs,
      details: {
        sessionId: payload.sessionId,
        sessionKey: payload.sessionKey,
        modelProfile: payload.modelProfile,
        modelName: payload.modelName,
      },
    });

    // SessionManager persists early entries once an assistant message appears.
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "session_started" }],
      api: "openai-responses",
      provider: "openpocket",
      model: "session-bootstrap",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: startedAtMs,
    });
  }

  appendStep(payload: SessionStepPayload): void {
    const manager = SessionManager.open(payload.sessionPath);
    const text = [
      `step: ${payload.stepNo}`,
      `at: ${payload.at}`,
      "thought:",
      payload.thought || "(empty)",
      "action_json:",
      payload.actionJson,
      "execution_result:",
      payload.result,
    ].join("\n");
    appendCustomLogMessage({
      manager,
      customType: "openpocket_step",
      content: text,
      timestamp: toUnixMs(payload.at),
      details: {
        sessionId: payload.sessionId,
        sessionKey: payload.sessionKey,
        stepNo: payload.stepNo,
      },
    });
  }

  finalize(payload: SessionFinalizePayload): void {
    const manager = SessionManager.open(payload.sessionPath);
    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            `status: ${payload.status}`,
            `ended_at: ${payload.endedAt}`,
            "",
            payload.message,
          ].join("\n"),
        },
      ],
      api: "openai-responses",
      provider: "openpocket",
      model: "session-finalizer",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: toUnixMs(payload.endedAt),
    });
  }
}
