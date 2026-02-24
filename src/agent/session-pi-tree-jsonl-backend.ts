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

function hasAssistantMessage(manager: SessionManager): boolean {
  return manager.getEntries().some((entry) => (
    entry.type === "message" && entry.message.role === "assistant"
  ));
}

export class SessionPiTreeJsonlBackend implements SessionBackend {
  create(payload: SessionCreatePayload): void {
    ensureDir(path.dirname(payload.sessionPath));
    const startedAtMs = toUnixMs(payload.startedAt);
    const manager = SessionManager.open(payload.sessionPath);
    ensureSessionManagerHeader(manager, payload.sessionId);
    const hadAssistantBeforeAppend = hasAssistantMessage(manager);

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

    // SessionManager only flushes once an assistant message exists in the file.
    // Keep a single bootstrap marker for brand-new sessions, but avoid writing
    // one for every task in a reused session.
    if (!hadAssistantBeforeAppend) {
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
          text: payload.message,
        },
      ],
      api: "openai-responses",
      provider: "openpocket",
      model: "session-task-outcome",
      usage: ZERO_USAGE,
      stopReason: payload.status === "SUCCESS" ? "stop" : "error",
      timestamp: toUnixMs(payload.endedAt),
    });
  }
}
