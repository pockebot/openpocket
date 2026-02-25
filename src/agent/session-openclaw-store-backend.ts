import fs from "node:fs";
import path from "node:path";

import type {
  SessionBackend,
  SessionCreatePayload,
  SessionEventPayload,
  SessionFinalizePayload,
  SessionStepPayload,
} from "./session-backend.js";
import { ensureDir } from "../utils/paths.js";

type OpenclawSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionKey?: string;
  sessionFile?: string;
  displayName?: string;
  model?: string;
  modelProvider?: string;
  abortedLastRun?: boolean;
};

type OpenclawSessionStore = Record<string, OpenclawSessionEntry>;

function isSessionStore(value: unknown): value is OpenclawSessionStore {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSessionStore(storePath: string): OpenclawSessionStore {
  if (!fs.existsSync(storePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isSessionStore(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSessionStore(storePath: string, store: OpenclawSessionStore): void {
  ensureDir(path.dirname(storePath));
  const tmpPath = `${storePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpPath, storePath);
}

function summarizeTask(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) {
    return compact;
  }
  return `${compact.slice(0, 117)}...`;
}

export class SessionOpenclawStoreBackend implements SessionBackend {
  private readonly storePath: string;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  static resolveExistingSession(
    storePath: string,
    sessionKey: string,
  ): { sessionId: string; sessionPath: string } | null {
    const key = sessionKey.trim();
    if (!key) {
      return null;
    }
    const store = readSessionStore(storePath);
    const entry = store[key];
    if (!entry) {
      return null;
    }
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
    const sessionPath = typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
    if (!sessionId || !sessionPath) {
      return null;
    }
    return { sessionId, sessionPath };
  }

  static resetSession(
    storePath: string,
    sessionKey: string,
    next: { sessionId: string; sessionPath: string },
  ): {
    sessionId: string;
    sessionPath: string;
    previousSessionId?: string;
    previousSessionPath?: string;
  } | null {
    const key = sessionKey.trim();
    if (!key) {
      return null;
    }

    const store = readSessionStore(storePath);
    const existing = store[key];
    const previousSessionId = typeof existing?.sessionId === "string" ? existing.sessionId.trim() : "";
    const previousSessionPath = typeof existing?.sessionFile === "string" ? existing.sessionFile.trim() : "";

    store[key] = {
      ...(existing ?? {
        updatedAt: Date.now(),
      }),
      sessionId: next.sessionId,
      sessionKey: key,
      sessionFile: next.sessionPath,
      updatedAt: Date.now(),
      abortedLastRun: false,
    };
    writeSessionStore(storePath, store);

    return {
      sessionId: next.sessionId,
      sessionPath: next.sessionPath,
      ...(previousSessionId ? { previousSessionId } : {}),
      ...(previousSessionPath ? { previousSessionPath } : {}),
    };
  }

  private resolveStoreKey(sessionId: string, sessionKey?: string): string {
    const normalized = typeof sessionKey === "string" ? sessionKey.trim() : "";
    return normalized || sessionId;
  }

  private upsert(
    sessionId: string,
    sessionKey: string | undefined,
    patch: Partial<OpenclawSessionEntry>,
  ): void {
    const key = this.resolveStoreKey(sessionId, sessionKey);
    const store = readSessionStore(this.storePath);
    const existing = store[key];
    store[key] = {
      ...(existing ?? {
        sessionId,
        updatedAt: Date.now(),
      }),
      ...patch,
      sessionId,
      sessionKey: key,
      updatedAt: Date.now(),
    };
    writeSessionStore(this.storePath, store);
  }

  create(payload: SessionCreatePayload): void {
    this.upsert(payload.sessionId, payload.sessionKey, {
      sessionFile: payload.sessionPath,
      displayName: summarizeTask(payload.task),
      model: payload.modelName,
      modelProvider: payload.modelProfile,
      abortedLastRun: false,
    });
  }

  appendStep(payload: SessionStepPayload): void {
    this.upsert(payload.sessionId, payload.sessionKey, {
      sessionFile: payload.sessionPath,
    });
  }

  appendEvent(payload: SessionEventPayload): void {
    this.upsert(payload.sessionId, payload.sessionKey, {
      sessionFile: payload.sessionPath,
    });
  }

  finalize(payload: SessionFinalizePayload): void {
    this.upsert(payload.sessionId, payload.sessionKey, {
      sessionFile: payload.sessionPath,
      abortedLastRun: payload.status !== "SUCCESS",
    });
  }
}
