export type SessionFinalStatus = "SUCCESS" | "FAILED";

export interface SessionStepTraceDetails {
  actionType: string;
  currentApp: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  screenshotMs?: number;
  modelInferenceMs?: number;
  loopDelayMs?: number;
}

export interface SessionCreatePayload {
  sessionId: string;
  sessionPath: string;
  sessionKey?: string;
  task: string;
  modelProfile: string;
  modelName: string;
  startedAt: string;
}

export interface SessionStepPayload {
  sessionId: string;
  sessionPath: string;
  sessionKey?: string;
  stepNo: number;
  at: string;
  thought: string;
  actionJson: string;
  result: string;
  trace?: SessionStepTraceDetails;
}

export interface SessionFinalizePayload {
  sessionId: string;
  sessionPath: string;
  sessionKey?: string;
  status: SessionFinalStatus;
  endedAt: string;
  message: string;
}

export interface SessionEventPayload {
  sessionId: string;
  sessionPath: string;
  sessionKey?: string;
  at: string;
  eventType: string;
  details?: Record<string, unknown>;
  text?: string;
}

export interface SessionBackend {
  create(payload: SessionCreatePayload): void;
  appendStep(payload: SessionStepPayload): void;
  appendEvent(payload: SessionEventPayload): void;
  finalize(payload: SessionFinalizePayload): void;
}
