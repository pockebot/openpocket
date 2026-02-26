import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  HumanAuthDecision,
  HumanAuthRequest,
  OpenPocketConfig,
} from "../types.js";
import { ensureDir, nowIso } from "../utils/paths.js";
import { sleep } from "../utils/time.js";

type PendingEntry = {
  id: string;
  chatId: number;
  task: string;
  request: HumanAuthRequest;
  openUrl: string | null;
  pollToken: string | null;
  expiresAtMs: number;
  createdAtIso: string;
  closed: boolean;
  timeoutHandle: NodeJS.Timeout | null;
  resolveDecision: (decision: HumanAuthDecision) => void;
  decisionPromise: Promise<HumanAuthDecision>;
};

type RelayCreateResponse = {
  requestId: string;
  openUrl: string;
  pollToken: string;
  expiresAt: string;
};

type RelayPollResponse = {
  requestId: string;
  status: "pending" | "approved" | "rejected" | "timeout";
  note?: string;
  decidedAt?: string;
  artifact?: {
    mimeType: string;
    base64: string;
  } | null;
};

function randomId(prefix: string): string {
  const entropy = crypto.randomBytes(8).toString("hex");
  return `${prefix}-${Date.now()}-${entropy}`;
}

function mimeToExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) {
    return "png";
  }
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  if (normalized.includes("json")) {
    return "json";
  }
  return "bin";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HumanAuthOpenContext {
  requestId: string;
  openUrl: string | null;
  expiresAt: string;
  relayEnabled: boolean;
  manualApproveCommand: string;
  manualRejectCommand: string;
}

export interface HumanAuthBridgeRequest {
  chatId: number;
  task: string;
  request: HumanAuthRequest;
}

export interface HumanAuthPendingSummary {
  requestId: string;
  chatId: number;
  task: string;
  capability: string;
  currentApp: string;
  createdAt: string;
  expiresAt: string;
  relayEnabled: boolean;
}

export class HumanAuthBridge {
  private readonly config: OpenPocketConfig;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(config: OpenPocketConfig) {
    this.config = config;
  }

  listPending(): HumanAuthPendingSummary[] {
    return [...this.pending.values()]
      .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso))
      .map((entry) => ({
        requestId: entry.id,
        chatId: entry.chatId,
        task: entry.task,
        capability: entry.request.capability,
        currentApp: entry.request.currentApp,
        createdAt: entry.createdAtIso,
        expiresAt: new Date(entry.expiresAtMs).toISOString(),
        relayEnabled: Boolean(entry.pollToken),
      }));
  }

  cancelPendingForChat(chatId: number, reason = "Task stopped by user."): number {
    if (!Number.isFinite(chatId)) {
      return 0;
    }
    let cancelled = 0;
    for (const entry of [...this.pending.values()]) {
      if (entry.chatId !== chatId) {
        continue;
      }
      const ok = this.settleEntry(entry, {
        requestId: entry.id,
        approved: false,
        status: "rejected",
        message: reason,
        decidedAt: nowIso(),
        artifactPath: null,
      });
      if (ok) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  cancelAllPending(reason = "Task stopped by gateway shutdown."): number {
    let cancelled = 0;
    for (const entry of [...this.pending.values()]) {
      const ok = this.settleEntry(entry, {
        requestId: entry.id,
        approved: false,
        status: "rejected",
        message: reason,
        decidedAt: nowIso(),
        artifactPath: null,
      });
      if (ok) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  resolvePending(requestId: string, approved: boolean, note?: string, actor = "manual"): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    const message = note?.trim() || (approved ? `Approved by ${actor}.` : `Rejected by ${actor}.`);
    return this.settleEntry(entry, {
      requestId: entry.id,
      approved,
      status: approved ? "approved" : "rejected",
      message,
      decidedAt: nowIso(),
      artifactPath: null,
    });
  }

  async requestAndWait(
    input: HumanAuthBridgeRequest,
    onOpened?: (context: HumanAuthOpenContext) => Promise<void> | void,
  ): Promise<HumanAuthDecision> {
    const requestId = randomId("auth");
    const timeoutSec = Math.max(1, Math.round(input.request.timeoutSec));
    const createdAtIso = nowIso();
    const expiresAtMs = Date.now() + timeoutSec * 1000;

    let resolveDecision: (decision: HumanAuthDecision) => void = () => {};
    const decisionPromise = new Promise<HumanAuthDecision>((resolve) => {
      resolveDecision = resolve;
    });

    const entry: PendingEntry = {
      id: requestId,
      chatId: input.chatId,
      task: input.task,
      request: input.request,
      openUrl: null,
      pollToken: null,
      expiresAtMs,
      createdAtIso,
      closed: false,
      timeoutHandle: null,
      resolveDecision,
      decisionPromise,
    };

    this.pending.set(entry.id, entry);
    entry.timeoutHandle = setTimeout(() => {
      void this.settleEntry(entry, {
        requestId: entry.id,
        approved: false,
        status: "timeout",
        message: "Human authorization timed out.",
        decidedAt: nowIso(),
        artifactPath: null,
      });
    }, Math.max(500, timeoutSec * 1000));

    if (this.isRelayConfigured()) {
      try {
        const created = await this.createRemoteRequest(entry);
        entry.openUrl = created.openUrl;
        entry.pollToken = created.pollToken;
        const remoteExpireMs = new Date(created.expiresAt).getTime();
        if (Number.isFinite(remoteExpireMs) && remoteExpireMs > Date.now()) {
          entry.expiresAtMs = remoteExpireMs;
        }
        void this.pollRemoteDecision(entry);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][human-auth] relay create request failed: ${(error as Error).message}`);
      }
    }

    if (onOpened) {
      await onOpened({
        requestId: entry.id,
        openUrl: entry.openUrl,
        expiresAt: new Date(entry.expiresAtMs).toISOString(),
        relayEnabled: Boolean(entry.pollToken),
        manualApproveCommand: `/auth approve ${entry.id}`,
        manualRejectCommand: `/auth reject ${entry.id}`,
      });
    }

    return entry.decisionPromise;
  }

  private settleEntry(entry: PendingEntry, decision: HumanAuthDecision): boolean {
    if (entry.closed) {
      return false;
    }
    entry.closed = true;
    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = null;
    }
    this.pending.delete(entry.id);
    entry.resolveDecision(decision);
    return true;
  }

  private isRelayConfigured(): boolean {
    return Boolean(
      this.config.humanAuth.enabled && this.config.humanAuth.relayBaseUrl.trim(),
    );
  }

  private resolveRelayApiKey(): string {
    if (this.config.humanAuth.apiKey.trim()) {
      return this.config.humanAuth.apiKey.trim();
    }
    if (this.config.humanAuth.apiKeyEnv.trim()) {
      return process.env[this.config.humanAuth.apiKeyEnv]?.trim() ?? "";
    }
    return "";
  }

  private async createRemoteRequest(entry: PendingEntry): Promise<RelayCreateResponse> {
    const url = `${this.config.humanAuth.relayBaseUrl}/v1/human-auth/requests`;
    const apiKey = this.resolveRelayApiKey();
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: entry.id,
        chatId: entry.chatId,
        task: entry.task,
        sessionId: entry.request.sessionId,
        step: entry.request.step,
        capability: entry.request.capability,
        instruction: entry.request.instruction,
        reason: entry.request.reason,
        timeoutSec: entry.request.timeoutSec,
        currentApp: entry.request.currentApp,
        screenshotPath: entry.request.screenshotPath,
        publicBaseUrl: this.config.humanAuth.publicBaseUrl || undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Relay create failed ${response.status}: ${body.slice(0, 300)}`);
    }

    const parsed = (await response.json()) as unknown;
    if (!isObject(parsed)) {
      throw new Error("Relay create response is not an object.");
    }

    const requestId = String(parsed.requestId ?? "");
    const openUrl = String(parsed.openUrl ?? "");
    const pollToken = String(parsed.pollToken ?? "");
    const expiresAt = String(parsed.expiresAt ?? "");

    if (!requestId || !openUrl || !pollToken || !expiresAt) {
      throw new Error("Relay create response missing required fields.");
    }
    if (requestId !== entry.id) {
      throw new Error(`Relay returned mismatched request id '${requestId}' (expected '${entry.id}').`);
    }
    return { requestId, openUrl, pollToken, expiresAt };
  }

  private async pollRemoteDecision(entry: PendingEntry): Promise<void> {
    if (!entry.pollToken) {
      return;
    }

    const apiKey = this.resolveRelayApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    while (!entry.closed) {
      if (Date.now() > entry.expiresAtMs) {
        void this.settleEntry(entry, {
          requestId: entry.id,
          approved: false,
          status: "timeout",
          message: "Human authorization timed out.",
          decidedAt: nowIso(),
          artifactPath: null,
        });
        return;
      }

      const pollUrl =
        `${this.config.humanAuth.relayBaseUrl}/v1/human-auth/requests/${encodeURIComponent(entry.id)}` +
        `?pollToken=${encodeURIComponent(entry.pollToken)}`;

      try {
        const response = await fetch(pollUrl, {
          method: "GET",
          headers,
        });

        if (response.ok) {
          const parsed = (await response.json()) as RelayPollResponse;
          if (parsed.status === "approved" || parsed.status === "rejected" || parsed.status === "timeout") {
            const artifactPath = parsed.artifact ? this.saveArtifact(entry.id, parsed.artifact) : null;
            void this.settleEntry(entry, {
              requestId: entry.id,
              approved: parsed.status === "approved",
              status: parsed.status,
              message:
                parsed.note?.trim() ||
                (parsed.status === "approved"
                  ? "Approved from web link."
                  : parsed.status === "rejected"
                    ? "Rejected from web link."
                    : "Human authorization timed out."),
              decidedAt: parsed.decidedAt || nowIso(),
              artifactPath,
            });
            return;
          }
        }
      } catch {
        // Ignore transient relay fetch errors. Manual /auth fallback still works.
      }

      await sleep(this.config.humanAuth.pollIntervalMs);
    }
  }

  private saveArtifact(
    requestId: string,
    artifact: { mimeType: string; base64: string },
  ): string | null {
    try {
      const dir = ensureDir(path.join(this.config.stateDir, "human-auth-artifacts"));
      const ext = mimeToExtension(artifact.mimeType);
      const outPath = path.join(dir, `${requestId}.${ext}`);
      fs.writeFileSync(outPath, Buffer.from(artifact.base64, "base64"));
      return outPath;
    } catch {
      return null;
    }
  }
}
