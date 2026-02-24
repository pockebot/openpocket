export type SessionFinalStatus = "SUCCESS" | "FAILED";

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
}

export interface SessionFinalizePayload {
  sessionId: string;
  sessionPath: string;
  sessionKey?: string;
  status: SessionFinalStatus;
  endedAt: string;
  message: string;
}

export interface SessionBackend {
  create(payload: SessionCreatePayload): void;
  appendStep(payload: SessionStepPayload): void;
  finalize(payload: SessionFinalizePayload): void;
}
