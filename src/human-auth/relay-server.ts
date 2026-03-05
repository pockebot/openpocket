import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { ensureDir, nowIso } from "../utils/paths.js";
import type { HumanAuthUiField, HumanAuthUiTemplate } from "../types.js";
import type {
  HumanAuthTakeoverAction,
  HumanAuthTakeoverFrame,
  HumanAuthTakeoverRuntime,
} from "./takeover-runtime.js";

type RelayStatus = "pending" | "approved" | "rejected" | "timeout";

export type RelayRecord = {
  requestId: string;
  chatId: number | null;
  task: string;
  sessionId: string;
  step: number;
  capability: string;
  instruction: string;
  reason: string;
  currentApp: string;
  screenshotPath: string | null;
  createdAt: string;
  expiresAt: string;
  status: RelayStatus;
  note: string;
  decidedAt: string | null;
  artifact: { mimeType: string; base64: string } | null;
  uiTemplate: HumanAuthUiTemplate | null;
  openTokenHash: string;
  pollTokenHash: string;
};

type RelayPortalArtifactKind = "auto" | "credentials" | "payment_card" | "form";

export type RelayPortalResolvedTemplate = {
  templateId: string;
  title: string;
  summary: string;
  capabilityHint: string;
  artifactKind: RelayPortalArtifactKind;
  requireArtifactOnApprove: boolean;
  allowTextAttachment: boolean;
  allowLocationAttachment: boolean;
  allowPhotoAttachment: boolean;
  allowAudioAttachment: boolean;
  allowFileAttachment: boolean;
  fileAccept: string;
  fields: HumanAuthUiField[];
  middleHtml: string;
  middleCss: string;
  middleScript: string;
  approveScript: string;
  approveLabel: string;
  rejectLabel: string;
  noteLabel: string;
  notePlaceholder: string;
  style: {
    brandColor: string;
    backgroundCss: string;
    fontFamily: string;
  };
};

const DEFAULT_PORTAL_FONT_FAMILY = "\"Avenir Next\", \"Segoe UI\", sans-serif";

const RELAY_ALLOWED_FIELD_TYPES = new Set([
  "text",
  "textarea",
  "password",
  "email",
  "number",
  "date",
  "select",
  "otp",
  "card-number",
  "expiry",
  "cvc",
]);

function sanitizeString(value: unknown, fallback: string, maxLen = 240): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.slice(0, maxLen);
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true" || value === "1" || value === 1) {
    return true;
  }
  if (value === "false" || value === "0" || value === 0) {
    return false;
  }
  return fallback;
}

function sanitizeCssColor(input: unknown, fallback: string): string {
  if (typeof input !== "string") {
    return fallback;
  }
  const value = input.trim();
  if (!value) {
    return fallback;
  }
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) {
    return value;
  }
  return fallback;
}

function sanitizeCssBackground(input: unknown, fallback: string): string {
  if (typeof input !== "string") {
    return fallback;
  }
  const value = input.trim();
  if (!value) {
    return fallback;
  }
  if (value.length > 220) {
    return fallback;
  }
  if (!/^[a-z0-9#(),.%\s\-:]+$/i.test(value)) {
    return fallback;
  }
  return value;
}

function sanitizeCssFontFamily(input: unknown, fallback: string): string {
  if (typeof input !== "string") {
    return fallback;
  }
  const parts = input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (parts.length === 0) {
    return fallback;
  }

  const normalized: string[] = [];
  for (const part of parts) {
    const unquoted = part.replace(/^["']+|["']+$/g, "").trim();
    if (!unquoted) {
      continue;
    }
    if (unquoted.length > 48) {
      continue;
    }
    if (!/^[a-z0-9 ._-]+$/i.test(unquoted)) {
      continue;
    }
    normalized.push(unquoted.includes(" ") ? `"${unquoted}"` : unquoted);
  }
  if (normalized.length === 0) {
    return fallback;
  }
  return normalized.join(", ");
}

function sanitizeAccept(input: unknown, fallback: string): string {
  if (typeof input !== "string") {
    return fallback;
  }
  const value = input.trim();
  if (!value) {
    return fallback;
  }
  if (value.length > 120) {
    return fallback;
  }
  if (!/^[a-z0-9*.,_+\-\/\s]+$/i.test(value)) {
    return fallback;
  }
  return value;
}

function sanitizeTemplateMarkup(input: unknown, fallback = "", maxLen = 18_000): string {
  if (typeof input !== "string") {
    return fallback;
  }
  const raw = input.trim();
  if (!raw) {
    return fallback;
  }
  const clipped = raw.slice(0, maxLen);
  // Keep markup channel strictly HTML-only. Script goes through middleScript.
  return clipped
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
}

function sanitizeScriptSnippet(input: unknown, fallback = "", maxLen = 24_000): string {
  if (typeof input !== "string") {
    return fallback;
  }
  const raw = input.trim();
  if (!raw) {
    return fallback;
  }
  // Prevent breaking out of inline <script> tag.
  if (/<\/script/i.test(raw)) {
    return fallback;
  }
  return raw.slice(0, maxLen);
}

function sanitizeInlineStyleBlock(input: string): string {
  return String(input || "")
    .replace(/<\/style/gi, "<\\/style")
    .replace(/<!--/g, "")
    .replace(/-->/g, "");
}

function sanitizeButtonLabel(input: unknown, fallback: string): string {
  return sanitizeString(input, fallback, 40);
}

function sanitizeUiField(input: unknown, index: number): HumanAuthUiField | null {
  if (!isObject(input)) {
    return null;
  }
  const id = sanitizeString(input.id, `field_${index + 1}`, 48).replace(/[^a-zA-Z0-9_-]/g, "_");
  const label = sanitizeString(input.label, `Field ${index + 1}`, 120);
  const typeRaw = sanitizeString(input.type, "text", 32).toLowerCase();
  const type = RELAY_ALLOWED_FIELD_TYPES.has(typeRaw)
    ? typeRaw as HumanAuthUiField["type"]
    : "text";

  let options: HumanAuthUiField["options"] = undefined;
  if (Array.isArray(input.options) && type === "select") {
    const normalized = input.options
      .map((item) => {
        if (!isObject(item)) {
          return null;
        }
        const value = sanitizeString(item.value, "", 120);
        if (!value) {
          return null;
        }
        const optionLabel = sanitizeString(item.label, value, 120);
        return { label: optionLabel, value };
      })
      .filter((item): item is { label: string; value: string } => Boolean(item))
      .slice(0, 20);
    options = normalized.length > 0 ? normalized : undefined;
  }

  return {
    id,
    label,
    type,
    placeholder: sanitizeString(input.placeholder, "", 180) || undefined,
    required: sanitizeBoolean(input.required, false),
    helperText: sanitizeString(input.helperText, "", 220) || undefined,
    autocomplete: sanitizeString(input.autocomplete, "", 80) || undefined,
    artifactKey: sanitizeString(input.artifactKey, "", 64) || undefined,
    options,
  };
}

function normalizeCapabilityToken(capabilityRaw: unknown): string {
  return String(capabilityRaw ?? "").trim().toLowerCase();
}

function defaultPortalTemplate(capabilityRaw?: unknown): RelayPortalResolvedTemplate {
  const capability = normalizeCapabilityToken(capabilityRaw);

  const base: RelayPortalResolvedTemplate = {
    templateId: "human-auth-generic",
    title: "Authorization Required",
    summary: "Review the request and approve or reject.",
    capabilityHint: "",
    artifactKind: "auto",
    requireArtifactOnApprove: false,
    allowTextAttachment: true,
    allowLocationAttachment: false,
    allowPhotoAttachment: false,
    allowAudioAttachment: false,
    allowFileAttachment: false,
    fileAccept: "*/*",
    fields: [],
    middleHtml: "",
    middleCss: "",
    middleScript: "",
    approveScript: "",
    approveLabel: "Approve",
    rejectLabel: "Reject",
    noteLabel: "Decision Note (Optional)",
    notePlaceholder: "Optional message to agent",
    style: {
      brandColor: "#ff8a00",
      backgroundCss: "linear-gradient(155deg, #fffefb 0%, #fff9f2 56%, #f4f8ff 100%)",
      fontFamily: DEFAULT_PORTAL_FONT_FAMILY,
    },
  };

  if (capability === "camera" || capability === "photos") {
    return {
      ...base,
      title: capability === "camera" ? "Human Auth Required: Camera" : "Human Auth Required: Photos",
      summary: "Attach photo data from your Human Phone to continue.",
      requireArtifactOnApprove: true,
      allowTextAttachment: false,
      allowPhotoAttachment: true,
      allowFileAttachment: true,
      fileAccept: "image/*",
      approveLabel: "Approve and Continue",
    };
  }

  if (capability === "microphone" || capability === "voice") {
    return {
      ...base,
      title: "Human Auth Required: Microphone",
      summary: "Attach audio data from your Human Phone to continue.",
      requireArtifactOnApprove: true,
      allowTextAttachment: false,
      allowAudioAttachment: true,
      allowFileAttachment: true,
      fileAccept: "audio/*",
      approveLabel: "Approve and Continue",
    };
  }

  if (capability === "location") {
    return {
      ...base,
      title: "Human Auth Required: Location",
      summary: "Attach your location from Human Phone to continue.",
      requireArtifactOnApprove: true,
      allowTextAttachment: false,
      allowLocationAttachment: true,
      approveLabel: "Approve and Continue",
    };
  }

  if (capability === "payment") {
    return {
      ...base,
      title: "Human Auth Required: Payment",
      summary: "Attach secure payment fields from Human Phone to continue.",
      requireArtifactOnApprove: true,
      allowTextAttachment: false,
      approveLabel: "Approve and Continue",
      notePlaceholder: "Optional context (never paste card data here)",
    };
  }

  if (capability === "2fa" || capability === "sms" || capability === "qr") {
    return {
      ...base,
      title: capability === "qr" ? "Human Auth Required: QR Result" : "Human Auth Required: Verification Code",
      summary: "Attach the required code from your Human Phone to continue.",
      requireArtifactOnApprove: true,
      allowTextAttachment: true,
      allowPhotoAttachment: capability === "qr",
      allowFileAttachment: capability === "qr",
      fileAccept: capability === "qr" ? "image/*" : base.fileAccept,
      approveLabel: "Approve and Continue",
    };
  }

  return base;
}

function mergeTemplateOverride(
  overrideRaw: unknown,
  capabilityRaw?: unknown,
): RelayPortalResolvedTemplate {
  const base = defaultPortalTemplate(capabilityRaw);
  if (!isObject(overrideRaw)) {
    return base;
  }
  const override = overrideRaw as HumanAuthUiTemplate;
  let mergedFields = base.fields;
  if (Array.isArray(override.fields)) {
    const nextFields = override.fields
      .map((field, index) => sanitizeUiField(field, index))
      .filter((field): field is HumanAuthUiField => Boolean(field))
      .slice(0, 20);
    mergedFields = nextFields;
  }
  const artifactKindRaw = sanitizeString(override.artifactKind, base.artifactKind, 30).toLowerCase();
  const artifactKind: RelayPortalArtifactKind = (
    artifactKindRaw === "credentials"
    || artifactKindRaw === "payment_card"
    || artifactKindRaw === "form"
    || artifactKindRaw === "auto"
  )
    ? artifactKindRaw
    : base.artifactKind;

  return {
    ...base,
    templateId: sanitizeString(override.templateId, base.templateId, 60),
    title: sanitizeString(override.title, base.title, 120),
    summary: sanitizeString(override.summary, base.summary, 300),
    capabilityHint: sanitizeString(override.capabilityHint, base.capabilityHint, 240),
    artifactKind,
    requireArtifactOnApprove: sanitizeBoolean(override.requireArtifactOnApprove, base.requireArtifactOnApprove),
    allowTextAttachment: sanitizeBoolean(override.allowTextAttachment, base.allowTextAttachment),
    allowLocationAttachment: sanitizeBoolean(override.allowLocationAttachment, base.allowLocationAttachment),
    allowPhotoAttachment: sanitizeBoolean(override.allowPhotoAttachment, base.allowPhotoAttachment),
    allowAudioAttachment: sanitizeBoolean(override.allowAudioAttachment, base.allowAudioAttachment),
    allowFileAttachment: sanitizeBoolean(override.allowFileAttachment, base.allowFileAttachment),
    fileAccept: sanitizeAccept(override.fileAccept, base.fileAccept),
    fields: mergedFields,
    middleHtml: sanitizeTemplateMarkup((override as Record<string, unknown>).middleHtml, base.middleHtml),
    middleCss: sanitizeTemplateMarkup((override as Record<string, unknown>).middleCss, base.middleCss, 8000),
    middleScript: sanitizeScriptSnippet((override as Record<string, unknown>).middleScript, base.middleScript),
    approveScript: sanitizeScriptSnippet((override as Record<string, unknown>).approveScript, base.approveScript),
    approveLabel: sanitizeButtonLabel((override as Record<string, unknown>).approveLabel, base.approveLabel),
    rejectLabel: sanitizeButtonLabel((override as Record<string, unknown>).rejectLabel, base.rejectLabel),
    noteLabel: sanitizeString((override as Record<string, unknown>).noteLabel, base.noteLabel, 80),
    notePlaceholder: sanitizeString((override as Record<string, unknown>).notePlaceholder, base.notePlaceholder, 180),
    style: {
      brandColor: sanitizeCssColor(override.style?.brandColor, base.style.brandColor),
      backgroundCss: sanitizeCssBackground(override.style?.backgroundCss, base.style.backgroundCss),
      // Keep Human Auth page typography aligned with OpenPocket dashboard brand.
      fontFamily: base.style.fontFamily,
    },
  };
}

function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function nowMs(): number {
  return Date.now();
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTruthyBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("Payload too large.");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}

export interface HumanAuthRelayServerOptions {
  host: string;
  port: number;
  publicBaseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  stateFile: string;
  takeoverRuntime?: HumanAuthTakeoverRuntime;
  takeoverFps?: number;
  logger?: (line: string) => void;
}

export class HumanAuthRelayServer {
  private readonly options: HumanAuthRelayServerOptions;
  private readonly log: (line: string) => void;
  private readonly records = new Map<string, RelayRecord>();
  private server: http.Server | null = null;
  /** Per-request rate limiting: track last takeover action timestamp. */
  private readonly takeoverActionTimestamps = new Map<string, number>();
  /** Maximum concurrent takeover streams per request. */
  private readonly takeoverStreamCounts = new Map<string, number>();
  private static readonly TAKEOVER_ACTION_COOLDOWN_MS = 200;
  private static readonly TAKEOVER_MAX_CONCURRENT_STREAMS = 2;
  /** SSE connections waiting for decision notifications per requestId. */
  private readonly sseClients = new Map<string, Set<http.ServerResponse>>();

  constructor(options: HumanAuthRelayServerOptions) {
    this.options = options;
    this.log =
      options.logger ??
      ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      });
    this.loadState();
  }

  private resolvePortalTemplate(record: Pick<RelayRecord, "capability" | "uiTemplate">): RelayPortalResolvedTemplate {
    return mergeTemplateOverride(record.uiTemplate, record.capability);
  }

  private describePortalTemplateSource(
    record: Pick<RelayRecord, "uiTemplate">,
    template: RelayPortalResolvedTemplate,
  ): string {
    if (!record.uiTemplate) {
      return "default-shell";
    }
    if ((template.templateId || "").startsWith("capability-probe-")) {
      return "runtime-capability-probe";
    }
    const hasDynamicMarkup = Boolean((template.middleHtml || "").trim() || (template.middleCss || "").trim());
    const hasDynamicLogic = Boolean((template.middleScript || "").trim() || (template.approveScript || "").trim());
    if (hasDynamicMarkup || hasDynamicLogic) {
      return "agent-generated-ui-template";
    }
    return "agent-ui-template";
  }

  get address(): string {
    if (!this.server) {
      return "";
    }
    const addr = this.server.address();
    if (!addr || typeof addr === "string") {
      return "";
    }
    return `http://${addr.address === "::" ? "127.0.0.1" : addr.address}:${addr.port}`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, this.options.host, () => {
        this.server?.removeListener("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const current = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });
  }

  private loadState(): void {
    if (!this.options.stateFile) {
      return;
    }
    if (!fs.existsSync(this.options.stateFile)) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.stateFile, "utf-8")) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const item of parsed) {
        if (!isObject(item) || typeof item.requestId !== "string") {
          continue;
        }
        const record: RelayRecord = {
          requestId: String(item.requestId),
          chatId:
            item.chatId === null || item.chatId === undefined
              ? null
              : Number.isFinite(Number(item.chatId))
                ? Number(item.chatId)
                : null,
          task: String(item.task ?? ""),
          sessionId: String(item.sessionId ?? ""),
          step: Number(item.step ?? 0),
          capability: String(item.capability ?? "unknown"),
          instruction: String(item.instruction ?? ""),
          reason: String(item.reason ?? ""),
          currentApp: String(item.currentApp ?? "unknown"),
          screenshotPath: item.screenshotPath ? String(item.screenshotPath) : null,
          createdAt: String(item.createdAt ?? nowIso()),
          expiresAt: String(item.expiresAt ?? nowIso()),
          status:
            item.status === "approved" ||
            item.status === "rejected" ||
            item.status === "timeout"
              ? item.status
              : "pending",
          note: String(item.note ?? ""),
          decidedAt: item.decidedAt ? String(item.decidedAt) : null,
          artifact:
            isObject(item.artifact) &&
            typeof item.artifact.mimeType === "string" &&
            typeof item.artifact.base64 === "string"
              ? { mimeType: item.artifact.mimeType, base64: item.artifact.base64 }
              : null,
          uiTemplate: isObject(item.uiTemplate) ? item.uiTemplate as HumanAuthUiTemplate : null,
          openTokenHash: String(item.openTokenHash ?? ""),
          pollTokenHash: String(item.pollTokenHash ?? ""),
        };
        this.records.set(record.requestId, record);
      }
    } catch {
      // Ignore malformed state files.
    }
  }

  private persistState(): void {
    if (!this.options.stateFile) {
      return;
    }
    ensureDir(path.dirname(this.options.stateFile));
    const serialized = [...this.records.values()].map((record) => {
      if (record.capability !== "payment") {
        return record;
      }
      // Never persist sensitive payment notes/artifacts to local relay state.
      return {
        ...record,
        note: "",
        artifact: null,
      };
    });
    fs.writeFileSync(
      this.options.stateFile,
      `${JSON.stringify(serialized, null, 2)}\n`,
      "utf-8",
    );
  }

  private relayApiKey(): string {
    if (this.options.apiKey.trim()) {
      return this.options.apiKey.trim();
    }
    if (this.options.apiKeyEnv.trim()) {
      return process.env[this.options.apiKeyEnv]?.trim() ?? "";
    }
    return "";
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const apiKey = this.relayApiKey();
    if (!apiKey) {
      return true;
    }
    const authHeader = String(req.headers.authorization ?? "");
    if (!authHeader.startsWith("Bearer ")) {
      return false;
    }
    return authHeader.slice("Bearer ".length).trim() === apiKey;
  }

  private makePublicBaseUrl(req: http.IncomingMessage, bodyPublicBaseUrl: string): string {
    if (bodyPublicBaseUrl.trim()) {
      return bodyPublicBaseUrl.trim().replace(/\/+$/, "");
    }
    if (this.options.publicBaseUrl.trim()) {
      return this.options.publicBaseUrl.trim().replace(/\/+$/, "");
    }
    const host = String(req.headers.host ?? `${this.options.host}:${this.options.port}`);
    const proto = String(req.headers["x-forwarded-proto"] ?? "http");
    return `${proto}://${host}`.replace(/\/+$/, "");
  }

  private updateTimeoutStatus(record: RelayRecord): void {
    if (record.status !== "pending") {
      return;
    }
    const expireMs = new Date(record.expiresAt).getTime();
    if (Number.isFinite(expireMs) && nowMs() > expireMs) {
      record.status = "timeout";
      record.note = record.note || "Request timed out.";
      record.decidedAt = nowIso();
      this.persistState();
      this.notifySseClients(record.requestId, record);
    }
  }

  private notifySseClients(requestId: string, record: RelayRecord): void {
    const clients = this.sseClients.get(requestId);
    if (!clients || clients.size === 0) {
      return;
    }
    const payload = JSON.stringify({
      requestId: record.requestId,
      status: record.status,
      note: record.note || undefined,
      decidedAt: record.decidedAt || undefined,
      artifact: record.artifact,
    });
    for (const client of clients) {
      try {
        client.write(`event: decision\ndata: ${payload}\n\n`);
        client.end();
      } catch {
        // Client may have disconnected.
      }
    }
    this.sseClients.delete(requestId);
  }

  private verifyOpenToken(record: RelayRecord, tokenRaw: unknown): { ok: true } | { ok: false; error: string; status: number } {
    const token = String(tokenRaw ?? "");
    if (!token || hashToken(token) !== record.openTokenHash) {
      return { ok: false, error: "Invalid or expired token.", status: 403 };
    }
    return { ok: true };
  }

  private ensureTakeoverRuntime(): HumanAuthTakeoverRuntime | null {
    return this.options.takeoverRuntime ?? null;
  }

  private sanitizeHeaderValue(input: string): string {
    return String(input || "").replace(/[\r\n]+/g, " ").slice(0, 200);
  }

  private parseTakeoverAction(input: unknown): HumanAuthTakeoverAction | null {
    if (!isObject(input)) {
      return null;
    }
    const type = String(input.type ?? "").trim().toLowerCase();
    if (type === "tap") {
      const x = Number(input.x);
      const y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      return {
        type: "tap",
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
      };
    }
    if (type === "swipe") {
      const x1 = Number(input.x1);
      const y1 = Number(input.y1);
      const x2 = Number(input.x2);
      const y2 = Number(input.y2);
      const durationMs = Number(input.durationMs ?? 260);
      if (![x1, y1, x2, y2, durationMs].every((value) => Number.isFinite(value))) {
        return null;
      }
      return {
        type: "swipe",
        x1: Math.max(0, Math.round(x1)),
        y1: Math.max(0, Math.round(y1)),
        x2: Math.max(0, Math.round(x2)),
        y2: Math.max(0, Math.round(y2)),
        durationMs: Math.max(80, Math.min(3000, Math.round(durationMs))),
      };
    }
    if (type === "type") {
      const text = String(input.text ?? "");
      if (!text.trim()) {
        return null;
      }
      if (text.length > 2000) {
        return null;
      }
      return { type: "type", text };
    }
    if (type === "keyevent") {
      const keycode = String(input.keycode ?? "").trim().toUpperCase();
      if (!keycode) {
        return null;
      }
      if (!/^KEYCODE_[A-Z0-9_]+$/.test(keycode)) {
        return null;
      }
      return { type: "keyevent", keycode };
    }
    return null;
  }

  private async writeMjpegFrame(
    res: http.ServerResponse,
    frame: HumanAuthTakeoverFrame,
  ): Promise<void> {
    const imageBuffer = Buffer.from(frame.screenshotBase64, "base64");
    const appHeader = this.sanitizeHeaderValue(frame.currentApp || "unknown");
    const capturedAt = this.sanitizeHeaderValue(frame.capturedAt || nowIso());
    const resolution = this.sanitizeHeaderValue(`${frame.width || 0}x${frame.height || 0}`);
    res.write(`--frame\r\n`);
    res.write("Content-Type: image/png\r\n");
    res.write(`Content-Length: ${imageBuffer.length}\r\n`);
    res.write(`X-OpenPocket-App: ${appHeader}\r\n`);
    res.write(`X-OpenPocket-Captured-At: ${capturedAt}\r\n`);
    res.write(`X-OpenPocket-Resolution: ${resolution}\r\n`);
    res.write("\r\n");
    res.write(imageBuffer);
    res.write("\r\n");
  }

  // =========================================================================
  // Portal Page Renderer (~1700 lines)
  // This section generates the complete Human Auth portal page HTML.
  // Future extraction: move to a dedicated portal-renderer.ts module.
  // =========================================================================

  private renderPortalPage(record: RelayRecord, token: string): string {
    const portalTemplate = this.resolvePortalTemplate(record);
    const requestId = escapeHtml(record.requestId);
    const capability = escapeHtml(record.capability);
    const instruction = escapeHtml(record.instruction || "(no instruction)");
    const localHostNameRaw = (os.hostname() || "this-device").trim();
    const localHostName = escapeHtml(localHostNameRaw.replace(/\.local$/i, "") || "this-device");
    const reason = escapeHtml(record.reason || "(no reason)");
    const task = escapeHtml(record.task || "(no task)");
    const currentApp = escapeHtml(record.currentApp || "unknown");
    const tokenEscaped = escapeHtml(token);
    const portalTemplateJson = JSON.stringify(portalTemplate);
    const templateIdEscaped = escapeHtml(portalTemplate.templateId || "human-auth-generic");
    const templateSourceEscaped = escapeHtml(this.describePortalTemplateSource(record, portalTemplate));
    const brandColorCss = portalTemplate.style.brandColor;
    const backgroundCss = portalTemplate.style.backgroundCss;
    const fontFamilyCss = portalTemplate.style.fontFamily;
    const middleCssEscaped = sanitizeInlineStyleBlock(portalTemplate.middleCss || "");
    const middleHtmlEscaped = portalTemplate.middleHtml || "";
    const approveLabelEscaped = escapeHtml(portalTemplate.approveLabel || "Approve");
    const rejectLabelEscaped = escapeHtml(portalTemplate.rejectLabel || "Reject");
    const noteLabelEscaped = escapeHtml(portalTemplate.noteLabel || "Decision Note (Optional)");
    const notePlaceholderEscaped = escapeHtml(portalTemplate.notePlaceholder || "Optional message to agent");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none';" />
  <title>OpenPocket Human Auth</title>
  <style>
    :root {
      color-scheme: light;
      --op-brand: ${brandColorCss};
      --op-brand-dark: #d85700;
      --op-bg: #fff9f2;
      --op-ink: #131313;
      --op-ink-soft: #5f6368;
      --op-line: #e5ddd1;
      --op-chip: rgba(255, 138, 0, 0.12);
    }
    body {
      margin: 0;
      font-family: ${fontFamilyCss};
      color: var(--op-ink);
      background:
        radial-gradient(circle at 85% -12%, rgba(255, 138, 0, 0.2), transparent 34%),
        ${backgroundCss};
      min-height: 100vh;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      padding: 16px 14px 24px;
      box-sizing: border-box;
    }
    .card {
      background: transparent;
      border: 0;
      border-radius: 0;
      padding: 0;
      box-shadow: none;
    }
    .brandRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .lockBadge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid rgba(255, 138, 0, 0.35);
      border-radius: 999px;
      background: rgba(255, 138, 0, 0.12);
      color: #78470f;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      max-width: 100%;
      min-width: 0;
    }
    .lockIcon {
      font-size: 14px;
      line-height: 1;
    }
    .lockBadgeText {
      min-width: 0;
      display: flex;
      flex-direction: column;
      line-height: 1.25;
      white-space: normal;
      gap: 1px;
    }
    .lockBadgeLine {
      display: block;
    }
    .hostName {
      display: block;
      font-weight: 700;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .requestId {
      color: var(--op-ink-soft);
      font-size: 12px;
      font-weight: 500;
      text-align: right;
      overflow-wrap: anywhere;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.25;
      font-weight: 600;
    }
    .brief {
      margin: 6px 0 0;
      color: var(--op-ink-soft);
      font-size: 14px;
      line-height: 1.42;
    }
    .capabilityLine {
      margin: 12px 0 0;
      font-size: 13px;
      color: #8b4a07;
      background: rgba(255, 138, 0, 0.08);
      border-left: 3px solid rgba(255, 138, 0, 0.45);
      border-radius: 8px;
      padding: 7px 10px;
    }
    .section {
      margin-top: 12px;
      border-top: 1px solid var(--op-line);
      padding-top: 12px;
      background: transparent;
    }
    .section h2 {
      margin: 0 0 8px;
      font-size: 15px;
      font-weight: 600;
    }
    label {
      display: block;
      font-size: 13px;
      color: #2a3138;
      font-weight: 600;
      margin-bottom: 6px;
    }
    input, textarea {
      width: 100%;
      border-radius: 9px;
      border: 1px solid #d7dce3;
      padding: 10px;
      box-sizing: border-box;
      font: inherit;
      font-size: 14px;
      background: #fff;
      color: #202124;
    }
    textarea {
      min-height: 64px;
      resize: vertical;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    button {
      border: 1px solid transparent;
      border-radius: 999px;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: all .12s ease;
    }
    button:active { transform: translateY(1px); }
    #approve {
      background: var(--op-brand);
      color: #121212;
      border-color: rgba(255, 138, 0, 0.6);
    }
    #reject {
      background: #fff;
      color: #a63a1a;
      border-color: #e7b7aa;
    }
    #attachText, #useGeo, #attachGeo, #startCam, #snapCam, #pickPhoto {
      background: #f7f8fb;
      color: #2d3136;
      border-color: #d9dfe8;
    }
    .cameraPrimarySection {
      margin-top: 12px;
      border: 1px solid #f2c792;
      border-radius: 14px;
      padding: 12px;
      background: linear-gradient(160deg, rgba(255, 138, 0, 0.08), rgba(255, 255, 255, 0.92));
    }
    .cameraPrimarySection h2 {
      margin-bottom: 4px;
    }
    .cameraPrimaryHint {
      margin: 0;
      font-size: 13px;
      color: #6a5132;
      line-height: 1.45;
    }
    #cameraDelegation.cameraPrimaryMode .actions {
      margin-top: 12px;
    }
    #cameraDelegation.cameraPrimaryMode #snapCam {
      background: var(--op-brand);
      color: #121212;
      border-color: rgba(255, 138, 0, 0.6);
    }
    #cameraDelegation.cameraPrimaryMode #pickPhoto {
      background: #fff;
      color: #1f2937;
      border-color: #cdd5df;
    }
    #cameraDelegation.cameraPrimaryMode #startCam {
      background: #f3f4f6;
      color: #374151;
      border-color: #d1d5db;
    }
    .status {
      margin-top: 10px;
      font-size: 14px;
      font-weight: 600;
      color: #202124;
      min-height: 20px;
      border: 1px solid transparent;
      border-radius: 10px;
      transition: color .12s ease, border-color .12s ease, background-color .12s ease;
    }
    .status:not(:empty) { padding: 8px 10px; }
    .status[data-tone="info"] {
      color: #2d3136;
      background: #f5f8fc;
      border-color: #d9dfe8;
    }
    .status[data-tone="success"] {
      color: #1f6f3d;
      background: #effaf3;
      border-color: #bfe7cd;
    }
    .status[data-tone="error"] {
      color: #a63a1a;
      background: #fff3ef;
      border-color: #f0c2b5;
    }
    .muted {
      color: var(--op-ink-soft);
      font-size: 12px;
      line-height: 1.5;
      margin-top: 8px;
    }
    .securityHint {
      margin-top: 6px;
      margin-bottom: 8px;
      color: #5a4a38;
    }
    .passwordRow {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .passwordRow .inputWrap {
      flex: 1;
    }
    .inputWrap {
      position: relative;
    }
    .inputWrap input {
      padding-right: 36px;
    }
    .clearInputBtn {
      position: absolute;
      top: 50%;
      right: 8px;
      transform: translateY(-50%);
      width: 22px;
      height: 22px;
      border-radius: 999px;
      border: 1px solid #d9dfe8;
      background: #fff;
      color: #5f6368;
      font-size: 14px;
      font-weight: 600;
      padding: 0;
      line-height: 1;
    }
    #togglePassword {
      border-radius: 10px;
      padding: 10px 14px;
      background: #f7f8fb;
      color: #2d3136;
      border-color: #d9dfe8;
      white-space: nowrap;
    }
    .decisionActions {
      margin-top: 12px;
      margin-bottom: 10px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .decisionActions button {
      width: 100%;
      min-width: 0;
    }
    .securityTrust {
      margin-top: 2px;
      margin-bottom: 10px;
      color: #5a4a38;
      line-height: 1.5;
    }
    .hidden { display: none !important; }
    .grid2 { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .takeover-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .takeover-meta {
      font-size: 12px;
      color: #5f6368;
      overflow-wrap: anywhere;
    }
    .stream-wrap {
      position: relative;
      margin-top: 8px;
      border-radius: 12px;
      border: 1px solid #d9dfe8;
      background: #050912;
      min-height: 280px;
      overflow: hidden;
    }
    .stream-wrap img {
      width: 100%;
      height: auto;
      display: block;
      object-fit: contain;
      touch-action: manipulation;
      user-select: none;
      -webkit-user-select: none;
    }
    .stream-empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #b2bfd3;
      font-size: 13px;
      padding: 18px;
      text-align: center;
    }
    .quick-keys {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .quick-keys button {
      border-radius: 12px;
      padding: 8px 10px;
      font-size: 13px;
      background: #0f1725;
      border-color: #202b40;
      color: #f4f8ff;
    }
    .takeover-input {
      margin-top: 10px;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .takeover-input input {
      flex: 1;
    }
    .takeover-status {
      margin-top: 8px;
      font-size: 12px;
      color: #5f6368;
    }
    .takeover-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    video, canvas, #photoPreview {
      width: 100%;
      border-radius: 12px;
      margin-top: 10px;
      background: #0d1117;
    }
    #video {
      min-height: 220px;
      object-fit: cover;
    }
    .cameraPlaceholder {
      margin-top: 10px;
      border: 1px dashed #d8dee7;
      border-radius: 12px;
      padding: 12px;
      font-size: 13px;
      color: #5f6368;
      background: #fafbfc;
      text-align: center;
    }
    details.context {
      margin-top: 14px;
      border-top: 1px solid var(--op-line);
      border-bottom: 1px solid var(--op-line);
      background: transparent;
      overflow: hidden;
    }
    details.context summary {
      cursor: pointer;
      list-style: none;
      padding: 12px 2px;
      font-size: 14px;
      font-weight: 600;
      color: #272e35;
      border-bottom: 1px solid transparent;
    }
    details.context[open] summary {
      border-bottom-color: var(--op-line);
    }
    .meta {
      display: grid;
      gap: 8px;
      padding: 10px 0 12px;
    }
    .metaItem {
      background: #fff;
      border: 1px solid var(--op-line);
      border-radius: 10px;
      padding: 8px 10px;
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .metaItem b {
      display: block;
      font-size: 11px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: #6e7781;
      margin-bottom: 2px;
      font-weight: 600;
    }
    @media (max-width: 480px) {
      h1 { font-size: 21px; }
      .grid2 { grid-template-columns: 1fr; }
      .brandRow { align-items: flex-start; }
      .requestId { text-align: left; }
      .quick-keys {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .takeover-input {
        flex-direction: column;
        align-items: stretch;
      }
    }
    ${middleCssEscaped ? `
    /* Agent-generated middle section styles */
    ${middleCssEscaped}
    ` : ""}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="brandRow">
        <div class="lockBadge">
          <span class="lockIcon">🔒</span>
          <span class="lockBadgeText">
            <span class="lockBadgeLine">Encrypted Local Relay running on</span>
            <span class="hostName">${localHostName}</span>
          </span>
        </div>
        <div class="requestId">Request: ${requestId}</div>
      </div>
      <h1 id="pageTitle">Authorization Required</h1>
      <p class="brief" id="pageSummary"></p>

      <div class="section hidden" id="dynamicFormSection">
        <h2 id="dynamicFormTitle">Requested Information</h2>
        <div id="dynamicForm"></div>
      </div>

      <div class="section hidden" id="agentMiddleSection">
        <h2>Agent-Generated Authorization Form</h2>
        <div id="agentMiddleMount">${middleHtmlEscaped}</div>
      </div>

      <div class="cameraPrimarySection hidden" id="cameraPrimarySection">
        <h2>Camera Preview (Human Phone)</h2>
        <p class="cameraPrimaryHint" id="cameraPrimaryHint">
          Allow camera access in this browser. After taking a photo, OpenPocket will continue automatically.
        </p>
        <div id="cameraPrimaryMount"></div>
      </div>

      <div class="capabilityLine" id="capabilityHint"></div>

      <div class="section" id="delegatedDataSection">
        <h2>Optional Delegated Data</h2>
        <div id="paymentDelegation" class="hidden">
          <label for="payCardNumber">Card Number</label>
          <input id="payCardNumber" type="text" inputmode="numeric" autocomplete="cc-number" placeholder="e.g., 4111111111111111" />
          <label for="payExpiry">Expiration (MM/YY)</label>
          <input id="payExpiry" type="text" inputmode="numeric" autocomplete="cc-exp" placeholder="e.g., 02/32" />
          <label for="payCvc">Security Code (CVV/CVC)</label>
          <input id="payCvc" type="text" inputmode="numeric" autocomplete="cc-csc" placeholder="e.g., 182" />
          <label for="payZip">ZIP / Postal (Optional)</label>
          <input id="payZip" type="text" autocomplete="postal-code" placeholder="e.g., 94105" />
          <div class="actions">
            <button id="attachPayment" type="button">Attach Payment Fields</button>
          </div>
          <div class="muted">For payment capability, data is sent as one-time structured delegation and not stored in relay state file.</div>
        </div>
        <div id="textDelegation">
          <label for="resultText">OTP / Code / Short Text</label>
          <input id="resultText" type="text" placeholder="e.g., OTP, SMS code, QR result text" />
          <div class="actions">
            <button id="attachText" type="button">Attach Text</button>
          </div>
        </div>

        <div id="geoDelegation" class="hidden">
          <label>Location (lat/lon)</label>
          <div class="grid2">
            <input id="geoLat" type="number" step="0.000001" placeholder="Latitude" />
            <input id="geoLon" type="number" step="0.000001" placeholder="Longitude" />
          </div>
          <div class="actions">
            <button id="useGeo" type="button">Use Current Location</button>
            <button id="attachGeo" type="button">Attach Location</button>
          </div>
        </div>

        <div id="cameraDelegationSlot">
          <div id="cameraDelegation">
            <video id="video" autoplay playsinline hidden></video>
            <canvas id="canvas" hidden></canvas>
            <img id="photoPreview" alt="Captured preview" hidden />
            <div class="cameraPlaceholder" id="cameraPlaceholder">
              Camera preview will appear here after permission is granted.
            </div>
            <div class="actions">
              <button id="snapCam" type="button">Take Photo & Continue</button>
              <button id="pickPhoto" type="button">Upload From Album</button>
              <button id="startCam" type="button">Retry Camera</button>
            </div>
            <div class="muted" id="cameraHelpText">
              Use your Human Phone camera for this step. After photo attachment, authorization can continue.
            </div>
            <input id="photoInput" type="file" accept="image/*" hidden />
          </div>
        </div>

        <div id="audioDelegation" class="hidden">
          <div class="actions">
            <button id="startRec" type="button">Start Recording</button>
            <button id="stopRec" type="button" disabled>Stop Recording</button>
            <button id="pickAudio" type="button">Upload Audio File</button>
          </div>
          <div class="muted" id="audioPreview">No audio attached yet.</div>
          <audio id="audioPlayback" controls hidden style="width:100%;margin-top:8px;border-radius:10px;"></audio>
          <input id="audioInput" type="file" accept="audio/*" hidden />
        </div>

        <div id="fileDelegation" class="hidden">
          <div class="actions">
            <button id="pickFile" type="button">Choose File</button>
          </div>
          <div class="muted" id="filePreview">No file attached yet.</div>
          <input id="fileInput" type="file" accept="*/*" hidden />
        </div>
      </div>

      <div class="section" id="decisionSection">
        <div id="decisionMountDefault">
          <div id="decisionBlock">
            <div class="actions decisionActions">
              <button id="approve" type="button">${approveLabelEscaped}</button>
              <button id="reject" type="button">${rejectLabelEscaped}</button>
            </div>
            <div class="muted securityTrust">
              Security: this is a one-time authorization link. All transmissions are encrypted. Relay and credential handling run only on your own computer.
            </div>
            <label for="note">${noteLabelEscaped}</label>
            <textarea id="note" placeholder="${notePlaceholderEscaped}"></textarea>
            <div class="status" id="status"></div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="takeover-head">
          <h2>Optional Remote Takeover (Live)</h2>
          <div class="takeover-meta" id="takeoverMeta">Preparing stream...</div>
        </div>
        <div class="takeover-actions">
          <button id="takeoverStart" type="button">Open Live Stream</button>
          <button id="takeoverStop" type="button">Stop Stream</button>
          <button id="takeoverRefresh" type="button">Refresh Snapshot</button>
        </div>
        <div class="stream-wrap">
          <img id="takeoverStream" alt="Emulator live stream" hidden />
          <div class="stream-empty" id="takeoverEmpty">Connecting to emulator live stream...</div>
        </div>
        <div class="quick-keys">
          <button id="keyBack" type="button">Back</button>
          <button id="keyHome" type="button">Home</button>
          <button id="keyRecents" type="button">Recents</button>
          <button id="keyEnter" type="button">Enter</button>
        </div>
        <div class="takeover-input">
          <input id="takeoverText" type="text" placeholder="Type text to emulator input field" />
          <button id="takeoverSendText" type="button">Send Text</button>
        </div>
        <div class="takeover-status" id="takeoverStatus">Tip: tap inside live view to control emulator directly.</div>
      </div>

      <details class="context">
        <summary>Show Full Context</summary>
        <div class="meta">
          <div class="metaItem"><b>Task</b>${task}</div>
          <div class="metaItem"><b>Capability</b>${capability}</div>
          <div class="metaItem"><b>Template</b>${templateIdEscaped} (${templateSourceEscaped})</div>
          <div class="metaItem"><b>Instruction</b>${instruction}</div>
          <div class="metaItem"><b>Reason</b>${reason}</div>
          <div class="metaItem"><b>Current App</b>${currentApp}</div>
        </div>
      </details>
    </div>
  </div>

  <script>
    const requestId = ${JSON.stringify(record.requestId)};
    const token = ${JSON.stringify(tokenEscaped)};
    const capability = ${JSON.stringify(record.capability)};
    const uiTemplate = ${portalTemplateJson};
    const decisionBlockEl = document.getElementById("decisionBlock");
    const decisionMountDefaultEl = document.getElementById("decisionMountDefault");
    const decisionSectionEl = document.getElementById("decisionSection");
    const pageTitleEl = document.getElementById("pageTitle");
    const pageSummaryEl = document.getElementById("pageSummary");
    const statusEl = document.getElementById("status");
    const noteEl = document.getElementById("note");
    const capabilityHintEl = document.getElementById("capabilityHint");
    const dynamicFormSectionEl = document.getElementById("dynamicFormSection");
    const dynamicFormTitleEl = document.getElementById("dynamicFormTitle");
    const dynamicFormEl = document.getElementById("dynamicForm");
    const agentMiddleSectionEl = document.getElementById("agentMiddleSection");
    const agentMiddleMountEl = document.getElementById("agentMiddleMount");
    const cameraPrimarySectionEl = document.getElementById("cameraPrimarySection");
    const cameraPrimaryHintEl = document.getElementById("cameraPrimaryHint");
    const cameraPrimaryMountEl = document.getElementById("cameraPrimaryMount");
    const cameraDelegationSlotEl = document.getElementById("cameraDelegationSlot");
    const cameraDelegationEl = document.getElementById("cameraDelegation");
    const cameraPlaceholderEl = document.getElementById("cameraPlaceholder");
    const cameraHelpTextEl = document.getElementById("cameraHelpText");
    const startCamBtn = document.getElementById("startCam");
    const snapCamBtn = document.getElementById("snapCam");
    const pickPhotoBtn = document.getElementById("pickPhoto");
    const videoEl = document.getElementById("video");
    const canvasEl = document.getElementById("canvas");
    const photoInputEl = document.getElementById("photoInput");
    const photoPreviewEl = document.getElementById("photoPreview");
    const audioInputEl = document.getElementById("audioInput");
    const audioPreviewEl = document.getElementById("audioPreview");
    const audioPlaybackEl = document.getElementById("audioPlayback");
    const startRecBtn = document.getElementById("startRec");
    const stopRecBtn = document.getElementById("stopRec");
    const fileInputEl = document.getElementById("fileInput");
    const filePreviewEl = document.getElementById("filePreview");
    const resultTextEl = document.getElementById("resultText");
    const geoLatEl = document.getElementById("geoLat");
    const geoLonEl = document.getElementById("geoLon");
    const delegatedDataSectionEl = document.getElementById("delegatedDataSection");
    const payCardNumberEl = document.getElementById("payCardNumber");
    const payExpiryEl = document.getElementById("payExpiry");
    const payCvcEl = document.getElementById("payCvc");
    const payZipEl = document.getElementById("payZip");
    const takeoverStreamEl = document.getElementById("takeoverStream");
    const takeoverEmptyEl = document.getElementById("takeoverEmpty");
    const takeoverMetaEl = document.getElementById("takeoverMeta");
    const takeoverStatusEl = document.getElementById("takeoverStatus");
    const takeoverTextEl = document.getElementById("takeoverText");
    let stream = null;
    let artifact = null;
    let takeoverPollingTimer = null;
    let takeoverRunning = false;
    let decisionInFlight = false;
    let cameraAutoBootstrapTriggered = false;
    const dynamicFieldRegistry = new Map();
    const takeoverControlIds = [
      "takeoverStop",
      "takeoverRefresh",
      "takeoverSendText",
      "keyBack",
      "keyHome",
      "keyRecents",
      "keyEnter",
      "takeoverText",
    ];

    function setStatus(text, tone) {
      const message = String(text || "");
      statusEl.textContent = message;
      if (!message) {
        statusEl.removeAttribute("data-tone");
        return;
      }
      statusEl.setAttribute("data-tone", tone || "info");
    }

    function withTimeout(promise, timeoutMs, timeoutMessage) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
        Promise.resolve(promise)
          .then((value) => {
            clearTimeout(timer);
            resolve(value);
          })
          .catch((error) => {
            clearTimeout(timer);
            reject(error);
          });
      });
    }

    function focusDelegatedDataSection() {
      if (!delegatedDataSectionEl || typeof delegatedDataSectionEl.scrollIntoView !== "function") {
        return;
      }
      delegatedDataSectionEl.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }

    function isCameraPrimaryFlowEnabled() {
      return capability === "camera" && Boolean(uiTemplate.allowPhotoAttachment);
    }

    function isAlbumPrimaryFlow() {
      var cap = String(capability || "").trim().toLowerCase();
      return (cap === "files" || cap === "photos") && Boolean(uiTemplate.allowPhotoAttachment);
    }

    function focusCameraPrimarySection() {
      if (!cameraPrimarySectionEl || typeof cameraPrimarySectionEl.scrollIntoView !== "function") {
        return;
      }
      cameraPrimarySectionEl.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }

    function mountCameraDelegation(primaryMode) {
      if (!cameraDelegationEl) {
        return;
      }
      const target = primaryMode ? cameraPrimaryMountEl : cameraDelegationSlotEl;
      if (target && cameraDelegationEl.parentElement !== target) {
        target.appendChild(cameraDelegationEl);
      }
      cameraDelegationEl.classList.toggle("cameraPrimaryMode", Boolean(primaryMode));
    }

    function setCameraPlaceholder(message) {
      if (!cameraPlaceholderEl) {
        return;
      }
      cameraPlaceholderEl.textContent = String(message || "");
      cameraPlaceholderEl.classList.toggle("hidden", !message);
    }

    function setCameraCaptureReady(ready) {
      if (snapCamBtn && "disabled" in snapCamBtn) {
        snapCamBtn.disabled = !ready;
      }
    }

    function show(id, visible) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle("hidden", !visible);
    }

    function capabilityHintText(cap) {
      if (cap === "location") return "Recommended: attach location and approve.";
      if (cap === "camera") return "Recommended: capture/upload photo and approve.";
      if (cap === "payment") return "Recommended: fill payment fields below and approve.";
      if (cap === "2fa" || cap === "sms") return "Recommended: attach OTP/code and approve.";
      if (cap === "qr") return "Recommended: attach QR text or photo and approve.";
      return "Recommended: attach needed data, then approve.";
    }

    function placeDecisionBlock() {
      if (!decisionBlockEl || !decisionMountDefaultEl || !decisionSectionEl) {
        return;
      }
      if (decisionBlockEl.parentElement !== decisionMountDefaultEl) {
        decisionMountDefaultEl.appendChild(decisionBlockEl);
      }
      decisionSectionEl.classList.remove("hidden");
    }

    function clearElementChildren(el) {
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
    }

    function inputTypeForField(fieldType) {
      if (fieldType === "password" || fieldType === "cvc") return "password";
      if (fieldType === "email") return "email";
      if (fieldType === "number") return "number";
      if (fieldType === "date") return "date";
      return "text";
    }

    function renderDynamicFields(fields) {
      dynamicFieldRegistry.clear();
      clearElementChildren(dynamicFormEl);
      if (!Array.isArray(fields) || fields.length === 0) {
        show("dynamicFormSection", false);
        return;
      }

      show("dynamicFormSection", true);
      for (const field of fields) {
        const wrap = document.createElement("div");
        wrap.style.marginBottom = "10px";

        const label = document.createElement("label");
        label.textContent = field.label || field.id;
        label.htmlFor = "dynamic_" + field.id;
        wrap.appendChild(label);

        let control = null;
        if (field.type === "textarea") {
          const textarea = document.createElement("textarea");
          textarea.id = "dynamic_" + field.id;
          textarea.placeholder = field.placeholder || "";
          textarea.required = Boolean(field.required);
          if (field.autocomplete) textarea.autocomplete = field.autocomplete;
          control = textarea;
        } else if (field.type === "select") {
          const select = document.createElement("select");
          select.id = "dynamic_" + field.id;
          if (Array.isArray(field.options)) {
            for (const option of field.options) {
              const opt = document.createElement("option");
              opt.value = String(option.value || "");
              opt.textContent = String(option.label || option.value || "");
              select.appendChild(opt);
            }
          }
          control = select;
        } else {
          const input = document.createElement("input");
          input.id = "dynamic_" + field.id;
          input.type = inputTypeForField(field.type);
          input.placeholder = field.placeholder || "";
          input.required = Boolean(field.required);
          if (field.autocomplete) input.autocomplete = field.autocomplete;
          if (field.type === "otp") {
            input.inputMode = "numeric";
            input.pattern = "[0-9]{4,10}";
          }
          if (field.type === "card-number") {
            input.inputMode = "numeric";
            input.autocomplete = field.autocomplete || "cc-number";
          }
          if (field.type === "expiry") {
            input.autocomplete = field.autocomplete || "cc-exp";
            input.placeholder = field.placeholder || "MM/YY";
          }
          if (field.type === "cvc") {
            input.inputMode = "numeric";
            input.autocomplete = field.autocomplete || "cc-csc";
          }
          control = input;
        }

        if (control) {
          wrap.appendChild(control);
          dynamicFieldRegistry.set(field.id, { field, control });
        }

        if (field.helperText) {
          const helper = document.createElement("div");
          helper.className = "muted";
          helper.textContent = field.helperText;
          wrap.appendChild(helper);
        }

        dynamicFormEl.appendChild(wrap);
      }
    }

    function collectDynamicFieldValues() {
      const values = {};
      for (const [fieldId, item] of dynamicFieldRegistry.entries()) {
        const field = item.field;
        const control = item.control;
        const value = String(control.value || "").trim();
        if (field.required && !value) {
          return {
            ok: false,
            error: "Required field is missing: " + (field.label || field.id),
          };
        }
        if (value) {
          values[field.artifactKey || fieldId] = value;
        }
      }
      return {
        ok: true,
        values,
      };
    }

    function buildAgentPortalApi(extra = {}) {
      return Object.assign(
        {
          requestId,
          capability,
          uiTemplate,
          setStatus: (text) => {
            setStatus(String(text || ""), "info");
          },
          getElement: (id) => document.getElementById(String(id || "")),
          getValue: (id) => {
            const el = document.getElementById(String(id || ""));
            if (!el || !("value" in el)) {
              return "";
            }
            return String(el.value || "");
          },
          setValue: (id, value) => {
            const el = document.getElementById(String(id || ""));
            if (!el || !("value" in el)) {
              return;
            }
            el.value = String(value ?? "");
          },
          setArtifactJson: (payload) => {
            setJsonArtifact(payload);
          },
          setArtifactRaw: (mimeType, base64) => {
            artifact = {
              mimeType: String(mimeType || "application/octet-stream"),
              base64: String(base64 || ""),
            };
          },
          clearArtifact: () => {
            artifact = null;
          },
          toBase64Utf8,
        },
        extra,
      );
    }

    async function invokeAgentScript(scriptText, api, scriptName) {
      const code = String(scriptText || "").trim();
      if (!code) {
        return undefined;
      }
      try {
        const fn = new Function("api", "'use strict';\\n" + code);
        const output = fn(api);
        if (output && typeof output.then === "function") {
          return await output;
        }
        return output;
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        setStatus(scriptName + " failed: " + message, "error");
        return { ok: false, error: scriptName + " failed: " + message };
      }
    }

    function configurePortalTemplate() {
      pageTitleEl.textContent = uiTemplate.title || "Authorization Required";
      pageSummaryEl.textContent = uiTemplate.summary || "";
      const fallbackHint = capabilityHintText(String(capability || "").trim().toLowerCase());
      const templateHint = String(uiTemplate.capabilityHint || "").trim();
      capabilityHintEl.textContent = templateHint || fallbackHint;
      dynamicFormTitleEl.textContent = "Requested Information";
      renderDynamicFields(uiTemplate.fields || []);
      placeDecisionBlock();
      show("capabilityHint", Boolean(capabilityHintEl.textContent));
      show("agentMiddleSection", Boolean((uiTemplate.middleHtml || "").trim() || (uiTemplate.middleScript || "").trim()));

      if (agentMiddleMountEl) {
        agentMiddleMountEl.innerHTML = String(uiTemplate.middleHtml || "");
      }

      const normalizedCapability = String(capability || "").trim().toLowerCase();
      const isPaymentCapability = normalizedCapability === "payment";
      const useCameraPrimaryFlow = isCameraPrimaryFlowEnabled();
      const allowStandaloneFileDelegation = Boolean(uiTemplate.allowFileAttachment) && !useCameraPrimaryFlow;
      const showPaymentDelegation = isPaymentCapability;
      const allowTextDelegation = Boolean(uiTemplate.allowTextAttachment) && !isPaymentCapability;
      mountCameraDelegation(useCameraPrimaryFlow);
      show("cameraPrimarySection", useCameraPrimaryFlow);
      const showDelegatedData = Boolean(
        showPaymentDelegation
        || allowTextDelegation
        || uiTemplate.allowLocationAttachment
        || uiTemplate.allowAudioAttachment
        || allowStandaloneFileDelegation
        || (uiTemplate.allowPhotoAttachment && !useCameraPrimaryFlow),
      );
      show("delegatedDataSection", showDelegatedData);
      show("paymentDelegation", showPaymentDelegation);
      show("textDelegation", allowTextDelegation);
      show("geoDelegation", Boolean(uiTemplate.allowLocationAttachment));
      show("cameraDelegation", Boolean(uiTemplate.allowPhotoAttachment));
      show("audioDelegation", Boolean(uiTemplate.allowAudioAttachment));
      show("fileDelegation", allowStandaloneFileDelegation);

      if (isPaymentCapability) {
        noteEl.placeholder = "Do not enter card data in note. Use payment fields above.";
      } else {
        noteEl.placeholder = uiTemplate.notePlaceholder || "Optional message to agent";
      }
      resultTextEl.placeholder = allowTextDelegation
        ? (uiTemplate.allowTextAttachment ? "Attach short text payload" : "Not required for this authorization")
        : "Not required for this authorization";
      audioInputEl.accept = uiTemplate.fileAccept || "audio/*";
      fileInputEl.accept = uiTemplate.fileAccept || "*/*";
      photoInputEl.multiple = !useCameraPrimaryFlow;
      if (snapCamBtn && "disabled" in snapCamBtn) {
        snapCamBtn.disabled = true;
      }

      if (isAlbumPrimaryFlow() && !useCameraPrimaryFlow) {
        if (pickPhotoBtn) {
          pickPhotoBtn.textContent = "Choose From Album";
          pickPhotoBtn.style.background = "var(--op-brand)";
          pickPhotoBtn.style.color = "#121212";
          pickPhotoBtn.style.borderColor = "rgba(255, 138, 0, 0.6)";
        }
        if (snapCamBtn) {
          snapCamBtn.textContent = "Use Camera Instead";
          snapCamBtn.style.background = "#f7f8fb";
          snapCamBtn.style.color = "#2d3136";
        }
        if (cameraHelpTextEl) {
          cameraHelpTextEl.textContent =
            "Select photos from your phone album. You can also use the camera if needed.";
        }
        if (cameraPlaceholderEl) {
          cameraPlaceholderEl.textContent = "Choose photos from your album, or use camera above.";
        }
      }

      if (useCameraPrimaryFlow) {
        if (cameraPrimaryHintEl) {
          cameraPrimaryHintEl.textContent =
            "Allow camera access in this browser. Tap Take Photo & Continue, or upload from album.";
        }
        if (cameraHelpTextEl) {
          cameraHelpTextEl.textContent =
            "After a photo is attached, approval will auto-submit and this page will close.";
        }
        if (startCamBtn) {
          startCamBtn.textContent = "Retry Camera";
        }
        if (snapCamBtn) {
          snapCamBtn.textContent = "Take Photo & Continue";
        }
        if (pickPhotoBtn) {
          pickPhotoBtn.textContent = "Upload From Album";
        }
        if (!cameraAutoBootstrapTriggered) {
          cameraAutoBootstrapTriggered = true;
          setCameraPlaceholder("Requesting camera permission...");
          setStatus("Requesting camera access on your Human Phone...", "info");
          void startCamera();
        }
      } else {
        if (cameraHelpTextEl) {
          cameraHelpTextEl.textContent =
            "Use your Human Phone camera for this step. After photo attachment, authorization can continue.";
        }
        if (startCamBtn) {
          startCamBtn.textContent = "Enable Camera";
        }
        if (snapCamBtn) {
          snapCamBtn.textContent = "Capture Snapshot";
        }
        if (pickPhotoBtn) {
          pickPhotoBtn.textContent = "Capture / Upload Photo";
        }
        setCameraPlaceholder("Camera preview will appear here after permission is granted.");
      }

      if ((uiTemplate.middleScript || "").trim()) {
        void invokeAgentScript(
          uiTemplate.middleScript,
          buildAgentPortalApi({
            mode: "mount",
            mountId: "agentMiddleMount",
          }),
          "middleScript",
        );
      }
    }

    /** Build takeover URL. For stream (img src), token stays in query string.
     *  For fetch-based calls (snapshot/action), we send via header instead. */
    function takeoverBasePath(path) {
      return "/v1/human-auth/requests/" + encodeURIComponent(requestId) + path;
    }
    function takeoverStreamUrl(path) {
      return (
        takeoverBasePath(path) +
        (path.includes("?") ? "&" : "?") +
        "token=" +
        encodeURIComponent(token)
      );
    }
    var authHeaders = { "X-OpenPocket-Auth": token };

    function setTakeoverStatus(text) {
      takeoverStatusEl.textContent = text;
    }

    function setTakeoverControlsEnabled(enabled) {
      for (const id of takeoverControlIds) {
        const el = document.getElementById(id);
        if (!el) {
          continue;
        }
        if ("disabled" in el) {
          el.disabled = !enabled;
        }
      }
    }

    function setTakeoverMeta(frame) {
      if (!frame) {
        takeoverMetaEl.textContent = "No frame metadata.";
        return;
      }
      takeoverMetaEl.textContent =
        "App: " +
        (frame.currentApp || "unknown") +
        " | " +
        (frame.width || "?") +
        "x" +
        (frame.height || "?") +
        " | " +
        new Date(frame.capturedAt || Date.now()).toLocaleTimeString();
      takeoverStreamEl.dataset.pixelWidth = String(frame.width || 0);
      takeoverStreamEl.dataset.pixelHeight = String(frame.height || 0);
    }

    async function loadTakeoverSnapshot(silent) {
      const response = await fetch(takeoverBasePath("/takeover/snapshot"), {
        method: "GET",
        headers: authHeaders,
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.error || response.statusText || "unknown error";
        if (response.status === 403 || response.status === 409) {
          stopTakeoverForTerminalState(message);
          return;
        }
        if (!silent) {
          setTakeoverStatus("Snapshot failed: " + message);
        }
        return;
      }
      const frame = body.frame || null;
      if (!frame || !frame.screenshotBase64) {
        if (!silent) {
          setTakeoverStatus("Snapshot unavailable.");
        }
        return;
      }
      takeoverStreamEl.src = "data:image/png;base64," + frame.screenshotBase64;
      takeoverStreamEl.hidden = false;
      takeoverEmptyEl.style.display = "none";
      setTakeoverMeta(frame);
      if (!silent) {
        setTakeoverStatus("Snapshot refreshed.");
      }
    }

    async function sendTakeoverAction(action, silent) {
      const response = await fetch(
        takeoverBasePath("/takeover/action"),
        {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders),
          body: JSON.stringify({ action }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.error || response.statusText || "unknown error";
        if (response.status === 403 || response.status === 409) {
          stopTakeoverForTerminalState(message);
          throw new Error(message);
        }
        if (!silent) {
          setTakeoverStatus("Action failed: " + message);
        }
        throw new Error(message);
      }
      if (!silent) {
        setTakeoverStatus(body.message || "Action sent.");
      }
    }

    function startTakeoverPolling() {
      if (takeoverPollingTimer) {
        clearInterval(takeoverPollingTimer);
        takeoverPollingTimer = null;
      }
      takeoverPollingTimer = setInterval(() => {
        if (!takeoverRunning) {
          return;
        }
        loadTakeoverSnapshot(true).catch(() => {});
      }, 1200);
    }

    function stopTakeoverPolling() {
      if (!takeoverPollingTimer) {
        return;
      }
      clearInterval(takeoverPollingTimer);
      takeoverPollingTimer = null;
    }

    function stopTakeoverForTerminalState(message) {
      takeoverRunning = false;
      stopTakeoverPolling();
      takeoverStreamEl.removeAttribute("src");
      takeoverStreamEl.hidden = true;
      takeoverEmptyEl.style.display = "flex";
      takeoverEmptyEl.textContent = "Takeover ended: " + message;
      setTakeoverStatus(message);
      setTakeoverControlsEnabled(false);
    }

    function startTakeoverStream() {
      takeoverRunning = true;
      stopTakeoverPolling();
      setTakeoverControlsEnabled(true);
      takeoverStreamEl.hidden = false;
      takeoverEmptyEl.style.display = "none";
      const url = takeoverStreamUrl("/takeover/stream") + "&ts=" + Date.now();
      takeoverStreamEl.src = url;
      setTakeoverStatus("Live stream connected. Tap image to control emulator.");
      loadTakeoverSnapshot(true).catch(() => {});
    }

    function stopTakeoverStream() {
      takeoverRunning = false;
      stopTakeoverPolling();
      takeoverStreamEl.removeAttribute("src");
      takeoverStreamEl.hidden = true;
      takeoverEmptyEl.style.display = "flex";
      takeoverEmptyEl.textContent = "Remote takeover not started.";
      setTakeoverControlsEnabled(false);
      setTakeoverStatus("Live stream stopped.");
    }

    function streamToDeviceCoordinates(clientX, clientY) {
      const rect = takeoverStreamEl.getBoundingClientRect();
      const pixelWidth = Number(takeoverStreamEl.dataset.pixelWidth || takeoverStreamEl.naturalWidth || "0");
      const pixelHeight = Number(takeoverStreamEl.dataset.pixelHeight || takeoverStreamEl.naturalHeight || "0");
      if (!pixelWidth || !pixelHeight || !rect.width || !rect.height) {
        return null;
      }
      const localX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const localY = Math.max(0, Math.min(rect.height, clientY - rect.top));
      return {
        x: Math.max(0, Math.min(pixelWidth - 1, Math.round((localX / rect.width) * pixelWidth))),
        y: Math.max(0, Math.min(pixelHeight - 1, Math.round((localY / rect.height) * pixelHeight))),
      };
    }

    function toBase64Utf8(text) {
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
    }

    function setJsonArtifact(payload) {
      artifact = {
        mimeType: "application/json",
        base64: toBase64Utf8(JSON.stringify(payload)),
      };
    }

    function buildDynamicFormArtifactPayload() {
      const collected = collectDynamicFieldValues();
      if (!collected.ok) {
        return collected;
      }
      const values = collected.values || {};
      if (Object.keys(values).length === 0) {
        return {
          ok: true,
          payload: null,
        };
      }
      const artifactKind = uiTemplate.artifactKind && uiTemplate.artifactKind !== "auto"
        ? uiTemplate.artifactKind
        : "form";
      return {
        ok: true,
        payload: {
          kind: artifactKind,
          fields: values,
          form_data: values,
          capability,
          templateId: uiTemplate.templateId || "",
          capturedAt: new Date().toISOString(),
        },
      };
    }

    function buildPaymentArtifactPayload() {
      const cardNumber = String(payCardNumberEl.value || "").replace(/\s+/g, "");
      const expiry = String(payExpiryEl.value || "").trim();
      const cvc = String(payCvcEl.value || "").trim();
      const zip = String(payZipEl.value || "").trim();
      if (!cardNumber && !expiry && !cvc && !zip) {
        return null;
      }
      return {
        kind: "payment_card_v1",
        cardNumber,
        expiry,
        cvc,
        zip,
        capability,
        capturedAt: new Date().toISOString(),
      };
    }

    function humanErrorMessage(err) {
      const name = err && err.name ? String(err.name) : "";
      const message = err && err.message ? String(err.message) : String(err || "unknown error");
      const lowered = (name + " " + message).toLowerCase();
      if (lowered.includes("notallowed") || lowered.includes("permission denied")) {
        return "Camera permission denied in this browser context. In Telegram in-app browser this can happen even after Allow. Use Upload From Album instead.";
      }
      if (lowered.includes("notfound") || lowered.includes("device not found")) {
        return "No camera device available. Use Upload From Album instead.";
      }
      if (lowered.includes("notreadable") || lowered.includes("track start failed")) {
        return "Camera is busy or blocked by another app. Close other camera apps and retry, or use Upload From Album.";
      }
      return "Failed to open camera: " + message;
    }

    function attachTextArtifact() {
      const text = String(resultTextEl.value || "").trim();
      if (!text) {
        setStatus("Text is empty.", "error");
        return;
      }
      setJsonArtifact({
        kind: "text",
        value: text,
        capability,
        capturedAt: new Date().toISOString(),
      });
      setStatus("Text attached.", "success");
    }

    function attachGeoArtifact() {
      const lat = Number(geoLatEl.value);
      const lon = Number(geoLonEl.value);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        setStatus("Latitude/Longitude is invalid.", "error");
        return;
      }
      setJsonArtifact({
        kind: "geo",
        lat,
        lon,
        capability,
        capturedAt: new Date().toISOString(),
      });
      setStatus("Location attached.", "success");
    }

    function attachPaymentArtifact() {
      const payload = buildPaymentArtifactPayload();
      if (!payload) {
        statusEl.textContent = "Payment fields are empty.";
        return;
      }
      setJsonArtifact(payload);
      statusEl.textContent = "Payment fields attached.";
    }

    function useCurrentLocation() {
      if (!navigator.geolocation) {
        setStatus("Geolocation is not supported in this browser.", "error");
        return;
      }
      setStatus("Fetching location...", "info");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          geoLatEl.value = String(pos.coords.latitude);
          geoLonEl.value = String(pos.coords.longitude);
          attachGeoArtifact();
        },
        (err) => {
          setStatus("Failed to read location: " + (err && err.message ? err.message : String(err)), "error");
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
      );
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });
    }

    function shouldAutoSubmitAfterPhotoAttachment() {
      return isCameraPrimaryFlowEnabled() && Boolean(uiTemplate.requireArtifactOnApprove);
    }

    function stopCameraStream() {
      if (!stream) {
        return;
      }
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
      videoEl.srcObject = null;
    }

    function queueAutoSubmitAfterPhoto() {
      if (!shouldAutoSubmitAfterPhotoAttachment()) {
        return;
      }
      setStatus("Photo attached. Continuing authorization...", "info");
      postClientEvent("camera_auto_submit", {
        capability,
      });
      setTimeout(() => {
        void submitDecision(true);
      }, 60);
    }

    async function startCamera() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        setCameraCaptureReady(false);
        setCameraPlaceholder("Camera is not available in this browser. Use Upload From Album.");
        setStatus("Camera is not available in this browser. Use Upload From Album.", "error");
        return false;
      }
      try {
        stopCameraStream();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        videoEl.srcObject = stream;
        canvasEl.hidden = true;
        videoEl.hidden = false;
        photoPreviewEl.hidden = true;
        setCameraPlaceholder("");
        setCameraCaptureReady(true);
        setStatus("Camera is ready. Tap Take Photo & Continue.", "info");
        return true;
      } catch (err) {
        const message = humanErrorMessage(err);
        setCameraCaptureReady(false);
        setCameraPlaceholder(message);
        setStatus(message, "error");
        return false;
      }
    }

    function captureSnapshot() {
      if (!videoEl.videoWidth || !videoEl.videoHeight) {
        setStatus("Camera is not ready yet.", "error");
        return;
      }
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
      const ctx = canvasEl.getContext("2d");
      ctx.drawImage(videoEl, 0, 0);
      const dataUrl = canvasEl.toDataURL("image/jpeg", 0.88);
      const base64 = dataUrl.split(",")[1] || "";
      artifact = { mimeType: "image/jpeg", base64 };
      photoPreviewEl.src = dataUrl;
      photoPreviewEl.hidden = false;
      canvasEl.hidden = true;
      videoEl.hidden = true;
      setCameraPlaceholder("Captured preview ready.");
      setCameraCaptureReady(false);
      stopCameraStream();
      setStatus("Snapshot captured and attached.", "success");
      queueAutoSubmitAfterPhoto();
    }

    async function pickPhoto() {
      photoInputEl.value = "";
      photoInputEl.click();
    }

    async function onPhotoChange() {
      const files = photoInputEl.files;
      if (!files || files.length === 0) {
        return;
      }
      try {
        if (files.length === 1) {
          const dataUrl = await fileToDataUrl(files[0]);
          const base64 = dataUrl.split(",")[1] || "";
          const mimeType = files[0].type || "image/jpeg";
          artifact = { mimeType, base64 };
          canvasEl.hidden = true;
          videoEl.hidden = true;
          photoPreviewEl.src = dataUrl;
          photoPreviewEl.hidden = false;
          setCameraPlaceholder("Selected photo ready.");
          setCameraCaptureReady(false);
          stopCameraStream();
          setStatus("Photo attached.", "success");
          queueAutoSubmitAfterPhoto();
        } else {
          var photoPayloads = [];
          for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var du = await fileToDataUrl(f);
            photoPayloads.push({
              name: f.name || ("photo_" + i + ".jpg"),
              mimeType: f.type || "image/jpeg",
              base64: du.split(",")[1] || "",
            });
          }
          setJsonArtifact({
            kind: "photos_multi",
            count: photoPayloads.length,
            photos: photoPayloads,
            capability: capability,
            capturedAt: new Date().toISOString(),
          });
          canvasEl.hidden = true;
          videoEl.hidden = true;
          photoPreviewEl.hidden = true;
          setCameraPlaceholder(photoPayloads.length + " photos attached.");
          setCameraCaptureReady(false);
          stopCameraStream();
          setStatus(photoPayloads.length + " photos attached.", "success");
          queueAutoSubmitAfterPhoto();
        }
      } catch (err) {
        setStatus("Failed to attach photo: " + (err && err.message ? err.message : String(err)), "error");
      }
    }

    var mediaRecorder = null;
    var audioChunks = [];
    var recordingStream = null;

    async function startRecording() {
      try {
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mimeOptions = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4", ""];
        var selectedMime = "";
        for (var mi = 0; mi < mimeOptions.length; mi++) {
          if (!mimeOptions[mi] || MediaRecorder.isTypeSupported(mimeOptions[mi])) {
            selectedMime = mimeOptions[mi];
            break;
          }
        }
        var recorderOptions = selectedMime ? { mimeType: selectedMime } : {};
        mediaRecorder = new MediaRecorder(recordingStream, recorderOptions);
        audioChunks = [];
        mediaRecorder.ondataavailable = function(e) {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.onstop = function() {
          var mimeType = mediaRecorder.mimeType || selectedMime || "audio/webm";
          var blob = new Blob(audioChunks, { type: mimeType });
          var reader = new FileReader();
          reader.onload = function() {
            var base64 = String(reader.result || "").split(",")[1] || "";
            artifact = { mimeType: mimeType, base64: base64 };
            audioPreviewEl.textContent = "Recording attached (" + (blob.size / 1024).toFixed(1) + " KB)";
            var blobUrl = URL.createObjectURL(blob);
            audioPlaybackEl.src = blobUrl;
            audioPlaybackEl.hidden = false;
            setStatus("Recording attached.", "success");
          };
          reader.onerror = function() {
            setStatus("Failed to process recording.", "error");
          };
          reader.readAsDataURL(blob);
          if (recordingStream) {
            recordingStream.getTracks().forEach(function(t) { t.stop(); });
            recordingStream = null;
          }
        };
        mediaRecorder.start(250);
        startRecBtn.disabled = true;
        stopRecBtn.disabled = false;
        setStatus("Recording... tap Stop when done.", "info");
      } catch (err) {
        var msg = err && err.message ? err.message : String(err);
        var lowered = msg.toLowerCase();
        if (lowered.includes("notallowed") || lowered.includes("permission")) {
          setStatus("Microphone permission denied. Use Upload Audio File instead.", "error");
        } else {
          setStatus("Failed to start recording: " + msg, "error");
        }
      }
    }

    function stopRecording() {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
      startRecBtn.disabled = false;
      stopRecBtn.disabled = true;
    }

    function pickAudio() {
      audioInputEl.value = "";
      audioInputEl.click();
    }

    async function onAudioChange() {
      const file = audioInputEl.files && audioInputEl.files[0];
      if (!file) {
        return;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        const base64 = dataUrl.split(",")[1] || "";
        const mimeType = file.type || "audio/webm";
        artifact = { mimeType, base64 };
        audioPreviewEl.textContent = "Audio attached: " + (file.name || "audio");
        audioPlaybackEl.src = URL.createObjectURL(file);
        audioPlaybackEl.hidden = false;
        setStatus("Audio attached.", "success");
      } catch (err) {
        setStatus("Failed to attach audio: " + (err && err.message ? err.message : String(err)), "error");
      }
    }

    function pickFile() {
      fileInputEl.value = "";
      fileInputEl.click();
    }

    async function onFileChange() {
      const file = fileInputEl.files && fileInputEl.files[0];
      if (!file) {
        return;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        const base64 = dataUrl.split(",")[1] || "";
        const mimeType = file.type || "application/octet-stream";
        artifact = { mimeType, base64 };
        filePreviewEl.textContent = "File attached: " + (file.name || "file");
        setStatus("File attached.", "success");
      } catch (err) {
        setStatus("Failed to attach file: " + (err && err.message ? err.message : String(err)), "error");
      }
    }

    function setDecisionButtonsDisabled(disabled) {
      const approveBtn = document.getElementById("approve");
      const rejectBtn = document.getElementById("reject");
      if (approveBtn && "disabled" in approveBtn) {
        approveBtn.disabled = disabled;
      }
      if (rejectBtn && "disabled" in rejectBtn) {
        rejectBtn.disabled = disabled;
      }
    }

    function postClientEvent(eventName, detail) {
      try {
        void fetch("/v1/human-auth/requests/" + encodeURIComponent(requestId) + "/client-event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            event: String(eventName || ""),
            detail: detail || null,
          }),
        });
      } catch {
        // best-effort debug signal only
      }
    }

    function promptRequiredArtifactCollection() {
      if (uiTemplate.allowPhotoAttachment) {
        if (isCameraPrimaryFlowEnabled()) {
          focusCameraPrimarySection();
          setStatus(
            "This request requires a photo from your Human Phone. Take a photo or upload from album to continue.",
            "info",
          );
          void startCamera();
          return true;
        }
        focusDelegatedDataSection();
        setStatus(
          "This request requires a photo from your Human Phone. Opening camera now; if unavailable, use Capture / Upload Photo and then tap Approve and Continue again.",
          "info",
        );
        void startCamera().then((opened) => {
          if (!opened) {
            void pickPhoto();
          }
        });
        return true;
      }
      focusDelegatedDataSection();
      if (uiTemplate.allowAudioAttachment) {
        setStatus(
          "This request requires audio from your Human Phone. Upload an audio file (or record), then tap Approve and Continue again.",
          "info",
        );
        void pickAudio();
        return true;
      }
      if (uiTemplate.allowLocationAttachment) {
        setStatus(
          "This request requires location from your Human Phone. Approve location access and attach coordinates, then tap Approve and Continue again.",
          "info",
        );
        useCurrentLocation();
        return true;
      }
      if (uiTemplate.allowFileAttachment) {
        setStatus(
          "This request requires a delegated file. Choose a file, then tap Approve and Continue again.",
          "info",
        );
        pickFile();
        return true;
      }
      if (uiTemplate.allowTextAttachment) {
        setStatus(
          "This request requires delegated text. Fill the text field below, attach it, then tap Approve and Continue again.",
          "info",
        );
        if (resultTextEl && typeof resultTextEl.focus === "function") {
          resultTextEl.focus();
        }
        return true;
      }
      return false;
    }

    function autoCloseResolvedPage() {
      const tgWebApp =
        window.Telegram &&
        window.Telegram.WebApp &&
        typeof window.Telegram.WebApp.close === "function"
          ? window.Telegram.WebApp
          : null;
      if (tgWebApp) {
        try {
          tgWebApp.close();
          return;
        } catch {}
      }

      try {
        window.open("", "_self");
        window.close();
      } catch {}

      setTimeout(() => {
        const ua = String(navigator.userAgent || "");
        if (/Telegram/i.test(ua)) {
          try {
            window.location.href = "tg://resolve";
            return;
          } catch {}
        }
        try {
          if (window.history.length > 1) {
            window.history.back();
          } else {
            window.location.replace("about:blank");
          }
        } catch {}
      }, 220);
    }

    async function submitDecision(approved) {
      if (decisionInFlight) {
        return;
      }
      decisionInFlight = true;
      setStatus("Submitting...", "info");
      setDecisionButtonsDisabled(true);
      postClientEvent("decision_click", {
        approved: Boolean(approved),
        hasArtifact: Boolean(artifact),
        requireArtifactOnApprove: Boolean(uiTemplate && uiTemplate.requireArtifactOnApprove),
      });

      const unlockDecisionControls = () => {
        decisionInFlight = false;
        setDecisionButtonsDisabled(false);
      };

      try {
        let noteValue = String(noteEl.value || "");
        const normalizedCapability = String(capability || "").trim().toLowerCase();
        if (approved) {
          const hasApproveScript = Boolean(String(uiTemplate.approveScript || "").trim());
          const hasDynamicFields = Array.isArray(uiTemplate.fields) && uiTemplate.fields.length > 0;
          if (uiTemplate.requireArtifactOnApprove && !artifact && !hasApproveScript && !hasDynamicFields) {
            if (promptRequiredArtifactCollection()) {
              postClientEvent("decision_blocked_missing_artifact", { stage: "pre_dynamic" });
              unlockDecisionControls();
              return;
            }
          }

          const dynamicPayload = buildDynamicFormArtifactPayload();
          if (!dynamicPayload.ok) {
            setStatus(dynamicPayload.error || "Invalid dynamic form values.", "error");
            unlockDecisionControls();
            return;
          }
          if (dynamicPayload.payload) {
            setJsonArtifact(dynamicPayload.payload);
          }

          const approveScriptOutput = await withTimeout(
            invokeAgentScript(
              uiTemplate.approveScript,
              buildAgentPortalApi({
                mode: "approve",
                approved: true,
                note: noteValue,
                currentArtifact: artifact,
              }),
              "approveScript",
            ),
            15_000,
            "Approval script timed out. Please retry.",
          );
          if (approveScriptOutput && typeof approveScriptOutput === "object") {
            const maybeOutput = approveScriptOutput;
            if (maybeOutput.ok === false) {
              setStatus(String(maybeOutput.error || "Approval script rejected this submission."), "error");
              unlockDecisionControls();
              return;
            }
            if (typeof maybeOutput.note === "string") {
              noteValue = maybeOutput.note.slice(0, 2000);
            }
            if (maybeOutput.artifactJson && typeof maybeOutput.artifactJson === "object") {
              setJsonArtifact(maybeOutput.artifactJson);
            }
            if (
              maybeOutput.artifact &&
              typeof maybeOutput.artifact === "object" &&
              typeof maybeOutput.artifact.mimeType === "string" &&
              typeof maybeOutput.artifact.base64 === "string"
            ) {
              artifact = {
                mimeType: maybeOutput.artifact.mimeType,
                base64: maybeOutput.artifact.base64,
              };
            }
          }

          if (normalizedCapability === "payment" && !artifact) {
            const paymentPayload = buildPaymentArtifactPayload();
            if (paymentPayload) {
              setJsonArtifact(paymentPayload);
            }
          }

          if (uiTemplate.requireArtifactOnApprove && !artifact) {
            promptRequiredArtifactCollection();
            setStatus(
              "This request requires delegated data before approval. Attach data below, then tap Approve and Continue again.",
              "error",
            );
            postClientEvent("decision_blocked_missing_artifact", { stage: "pre_resolve" });
            unlockDecisionControls();
            return;
          }
        } else {
          artifact = null;
        }
        const decisionNote = normalizedCapability === "payment" ? "" : noteValue;
        postClientEvent("resolve_submit", {
          approved: Boolean(approved),
          hasArtifact: Boolean(artifact),
        });
        const response = await withTimeout(
          fetch("/v1/human-auth/requests/" + encodeURIComponent(requestId) + "/resolve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token,
              approved,
              note: decisionNote,
              artifact
            })
          }),
          20_000,
          "Relay resolve request timed out. Please check network and retry.",
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          postClientEvent("resolve_error", {
            status: Number(response.status || 0),
            error: String(body.error || response.statusText || "unknown"),
          });
          setStatus("Failed: " + (body.error || response.statusText), "error");
          unlockDecisionControls();
          return;
        }
        postClientEvent("resolve_ok", { status: String(body.status || "") });
        setStatus(approved ? "Approved. Closing..." : "Rejected. Closing...", "success");
        stopCameraStream();
        stopTakeoverPolling();
        takeoverRunning = false;
        takeoverStreamEl.removeAttribute("src");
        setTakeoverControlsEnabled(false);
        setTimeout(autoCloseResolvedPage, 120);
      } catch (err) {
        postClientEvent("resolve_exception", {
          error: String(err && err.message ? err.message : err || "unknown"),
        });
        setStatus("Request failed: " + (err && err.message ? err.message : String(err)), "error");
        unlockDecisionControls();
      }
    }

    document.getElementById("startCam").addEventListener("click", startCamera);
    document.getElementById("snapCam").addEventListener("click", captureSnapshot);
    document.getElementById("pickPhoto").addEventListener("click", pickPhoto);
    document.getElementById("startRec").addEventListener("click", startRecording);
    document.getElementById("stopRec").addEventListener("click", stopRecording);
    document.getElementById("pickAudio").addEventListener("click", pickAudio);
    document.getElementById("pickFile").addEventListener("click", pickFile);
    document.getElementById("attachText").addEventListener("click", attachTextArtifact);
    const attachPaymentBtn = document.getElementById("attachPayment");
    if (attachPaymentBtn) {
      attachPaymentBtn.addEventListener("click", attachPaymentArtifact);
    }
    document.getElementById("useGeo").addEventListener("click", useCurrentLocation);
    document.getElementById("attachGeo").addEventListener("click", attachGeoArtifact);
    photoInputEl.addEventListener("change", onPhotoChange);
    audioInputEl.addEventListener("change", onAudioChange);
    fileInputEl.addEventListener("change", onFileChange);
    document.getElementById("approve").addEventListener("click", () => submitDecision(true));
    document.getElementById("reject").addEventListener("click", () => submitDecision(false));
    document.getElementById("takeoverStart").addEventListener("click", startTakeoverStream);
    document.getElementById("takeoverStop").addEventListener("click", stopTakeoverStream);
    document.getElementById("takeoverRefresh").addEventListener("click", () => {
      loadTakeoverSnapshot(false).catch((err) => {
        setTakeoverStatus("Snapshot refresh failed: " + (err && err.message ? err.message : String(err)));
      });
    });
    document.getElementById("takeoverSendText").addEventListener("click", () => {
      const text = String(takeoverTextEl.value || "").trim();
      if (!text) {
        setTakeoverStatus("Text is empty.");
        return;
      }
      sendTakeoverAction({ type: "type", text }, false)
        .then(() => {
          loadTakeoverSnapshot(true).catch(() => {});
        })
        .catch(() => {});
    });
    document.getElementById("keyBack").addEventListener("click", () => {
      sendTakeoverAction({ type: "keyevent", keycode: "KEYCODE_BACK" }, false).catch(() => {});
    });
    document.getElementById("keyHome").addEventListener("click", () => {
      sendTakeoverAction({ type: "keyevent", keycode: "KEYCODE_HOME" }, false).catch(() => {});
    });
    document.getElementById("keyRecents").addEventListener("click", () => {
      sendTakeoverAction({ type: "keyevent", keycode: "KEYCODE_APP_SWITCH" }, false).catch(() => {});
    });
    document.getElementById("keyEnter").addEventListener("click", () => {
      sendTakeoverAction({ type: "keyevent", keycode: "KEYCODE_ENTER" }, false).catch(() => {});
    });
    takeoverStreamEl.addEventListener("click", (event) => {
      const p = streamToDeviceCoordinates(event.clientX, event.clientY);
      if (!p) {
        setTakeoverStatus("Tap mapping failed. Refresh snapshot first.");
        return;
      }
      sendTakeoverAction({ type: "tap", x: p.x, y: p.y }, false)
        .then(() => {
          loadTakeoverSnapshot(true).catch(() => {});
        })
        .catch(() => {});
    });
    takeoverStreamEl.addEventListener("error", () => {
      if (!takeoverRunning) {
        return;
      }
      setTakeoverStatus("Live stream interrupted. Falling back to snapshot polling.");
      startTakeoverPolling();
      loadTakeoverSnapshot(true).catch(() => {});
    });
    configurePortalTemplate();
    setTakeoverControlsEnabled(false);
    takeoverEmptyEl.textContent = "Remote takeover not started.";
    setTakeoverStatus("Remote takeover is optional. Open live stream only if you need direct control.");
  </script>
</body>
</html>`;
  }

  // =========================================================================
  // HTTP Request Router
  // =========================================================================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = String(req.method ?? "GET").toUpperCase();
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { ok: true, now: nowIso(), requests: this.records.size });
      return;
    }

    if (method === "POST" && pathname === "/v1/human-auth/requests") {
      if (!this.isAuthorized(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }

      if (!isObject(body)) {
        sendJson(res, 400, { error: "Invalid body." });
        return;
      }

      const requestId = String(body.requestId ?? `auth-${nowMs()}-${crypto.randomBytes(4).toString("hex")}`);
      const timeoutSecRaw = Number(body.timeoutSec ?? 300);
      const timeoutSec = Math.max(30, Math.min(1800, Number.isFinite(timeoutSecRaw) ? timeoutSecRaw : 300));
      const openToken = randomToken();
      const pollToken = randomToken();
      const createdAt = nowIso();
      const expiresAt = new Date(nowMs() + timeoutSec * 1000).toISOString();

      const record: RelayRecord = {
        requestId,
        chatId:
          body.chatId === null || body.chatId === undefined
            ? null
            : Number.isFinite(Number(body.chatId))
              ? Number(body.chatId)
              : null,
        task: String(body.task ?? ""),
        sessionId: String(body.sessionId ?? ""),
        step: Number(body.step ?? 0),
        capability: String(body.capability ?? "unknown"),
        instruction: String(body.instruction ?? ""),
        reason: String(body.reason ?? ""),
        currentApp: String(body.currentApp ?? "unknown"),
        screenshotPath: body.screenshotPath ? String(body.screenshotPath) : null,
        createdAt,
        expiresAt,
        status: "pending",
        note: "",
        decidedAt: null,
        artifact: null,
        uiTemplate: isObject(body.uiTemplate) ? body.uiTemplate as HumanAuthUiTemplate : null,
        openTokenHash: hashToken(openToken),
        pollTokenHash: hashToken(pollToken),
      };

      this.records.set(requestId, record);
      this.persistState();

      const publicBaseUrl = this.makePublicBaseUrl(
        req,
        body.publicBaseUrl ? String(body.publicBaseUrl) : "",
      );
      const openUrl =
        `${publicBaseUrl}/human-auth/${encodeURIComponent(requestId)}` +
        `?token=${encodeURIComponent(openToken)}`;

      sendJson(res, 200, {
        requestId,
        openUrl,
        pollToken,
        expiresAt,
        takeover: {
          enabled: Boolean(this.options.takeoverRuntime),
          snapshotPath: `/v1/human-auth/requests/${encodeURIComponent(requestId)}/takeover/snapshot`,
          streamUrl: `${publicBaseUrl}/v1/human-auth/requests/${encodeURIComponent(requestId)}/takeover/stream?token=${encodeURIComponent(openToken)}`,
          actionPath: `/v1/human-auth/requests/${encodeURIComponent(requestId)}/takeover/action`,
        },
      });
      return;
    }

    const pollMatch = pathname.match(/^\/v1\/human-auth\/requests\/([^/]+)$/);
    if (method === "GET" && pollMatch) {
      const requestId = decodeURIComponent(pollMatch[1]);
      const record = this.records.get(requestId);
      if (!record) {
        sendJson(res, 404, { error: "Request not found." });
        return;
      }
      this.updateTimeoutStatus(record);
      const pollToken = String(requestUrl.searchParams.get("pollToken") ?? "");
      if (!pollToken || hashToken(pollToken) !== record.pollTokenHash) {
        sendJson(res, 403, { error: "Invalid poll token." });
        return;
      }

      sendJson(res, 200, {
        requestId: record.requestId,
        status: record.status,
        note: record.note || undefined,
        decidedAt: record.decidedAt || undefined,
        artifact: record.artifact,
      });
      return;
    }

    const sseMatch = pathname.match(/^\/v1\/human-auth\/requests\/([^/]+)\/events$/);
    if (method === "GET" && sseMatch) {
      const requestId = decodeURIComponent(sseMatch[1]);
      const record = this.records.get(requestId);
      if (!record) {
        sendJson(res, 404, { error: "Request not found." });
        return;
      }
      this.updateTimeoutStatus(record);
      const pollToken = String(requestUrl.searchParams.get("pollToken") ?? "");
      if (!pollToken || hashToken(pollToken) !== record.pollTokenHash) {
        sendJson(res, 403, { error: "Invalid poll token." });
        return;
      }
      if (record.status !== "pending") {
        // Already resolved — send the decision immediately and close.
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        const payload = JSON.stringify({
          requestId: record.requestId,
          status: record.status,
          note: record.note || undefined,
          decidedAt: record.decidedAt || undefined,
          artifact: record.artifact,
        });
        res.write(`event: decision\ndata: ${payload}\n\n`);
        res.end();
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders?.();
      res.write(`: connected\n\n`);

      let clientSet = this.sseClients.get(requestId);
      if (!clientSet) {
        clientSet = new Set();
        this.sseClients.set(requestId, clientSet);
      }
      clientSet.add(res);

      const keepAliveTimer = setInterval(() => {
        try {
          // Proactively check timeout on each keepalive tick.
          this.updateTimeoutStatus(record);
          if (record.status !== "pending") {
            this.notifySseClients(requestId, record);
            return;
          }
          res.write(`: keepalive\n\n`);
        } catch {
          clearInterval(keepAliveTimer);
        }
      }, 15_000);

      const cleanup = (): void => {
        clearInterval(keepAliveTimer);
        const set = this.sseClients.get(requestId);
        if (set) {
          set.delete(res);
          if (set.size === 0) {
            this.sseClients.delete(requestId);
          }
        }
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
      return;
    }

    const resolveMatch = pathname.match(/^\/v1\/human-auth\/requests\/([^/]+)\/resolve$/);
    if (method === "POST" && resolveMatch) {
      const requestId = decodeURIComponent(resolveMatch[1]);
      this.log(`[OpenPocket][human-auth][debug] resolve incoming requestId=${requestId}`);
      const record = this.records.get(requestId);
      if (!record) {
        this.log(`[OpenPocket][human-auth][warn] resolve rejected requestId=${requestId} reason=request_not_found`);
        sendJson(res, 404, { error: "Request not found." });
        return;
      }
      this.updateTimeoutStatus(record);
      if (record.status !== "pending") {
        this.log(`[OpenPocket][human-auth][warn] resolve rejected requestId=${requestId} reason=already_${record.status}`);
        sendJson(res, 409, { error: `Request already ${record.status}.` });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req, 22_000_000);
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }
      if (!isObject(body)) {
        sendJson(res, 400, { error: "Invalid body." });
        return;
      }

      const token = String(body.token ?? "");
      if (!token || hashToken(token) !== record.openTokenHash) {
        this.log(`[OpenPocket][human-auth][warn] resolve rejected requestId=${requestId} reason=invalid_token`);
        sendJson(res, 403, { error: "Invalid token." });
        return;
      }

      const approved = isTruthyBoolean(body.approved);
      const portalTemplate = this.resolvePortalTemplate(record);
      let artifact: { mimeType: string; base64: string } | null = null;
      const isPayment = String(record.capability).trim().toLowerCase() === "payment";

      if (
        isObject(body.artifact) &&
        typeof body.artifact.mimeType === "string" &&
        typeof body.artifact.base64 === "string" &&
        body.artifact.base64.length <= 20_000_000
      ) {
        artifact = {
          mimeType: body.artifact.mimeType,
          base64: body.artifact.base64,
        };
      }

      if (approved && portalTemplate.requireArtifactOnApprove && !artifact) {
        this.log(`[OpenPocket][human-auth][warn] resolve rejected requestId=${requestId} reason=missing_artifact capability=${record.capability}`);
        sendJson(res, 400, {
          error: "This authorization requires delegated data artifact before approval.",
        });
        return;
      }

      record.status = approved ? "approved" : "rejected";
      record.note = isPayment ? "" : String(body.note ?? "").slice(0, 2000);
      record.decidedAt = nowIso();
      record.openTokenHash = "";
      record.artifact = approved ? artifact : null;

      this.persistState();
      this.notifySseClients(record.requestId, record);
      this.log(
        `[OpenPocket][human-auth][info] resolve accepted requestId=${record.requestId} status=${record.status} capability=${record.capability} artifact=${record.artifact ? "yes" : "no"}`,
      );
      sendJson(res, 200, {
        requestId: record.requestId,
        status: record.status,
        decidedAt: record.decidedAt,
      });
      return;
    }

    const clientEventMatch = pathname.match(/^\/v1\/human-auth\/requests\/([^/]+)\/client-event$/);
    if (method === "POST" && clientEventMatch) {
      const requestId = decodeURIComponent(clientEventMatch[1]);
      const record = this.records.get(requestId);
      if (!record) {
        sendJson(res, 404, { error: "Request not found." });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, 256_000);
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }
      if (!isObject(body)) {
        sendJson(res, 400, { error: "Invalid body." });
        return;
      }
      const token = String(body.token ?? "");
      if (!token || hashToken(token) !== record.openTokenHash) {
        sendJson(res, 403, { error: "Invalid token." });
        return;
      }
      const eventName = sanitizeString(body.event, "unknown", 80);
      const detail = isObject(body.detail) ? JSON.stringify(body.detail).slice(0, 400) : "";
      this.log(
        `[OpenPocket][human-auth][debug] client_event requestId=${requestId} event=${eventName}${detail ? ` detail=${detail}` : ""}`,
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    const takeoverSnapshotMatch = pathname.match(/^\/v1\/human-auth\/requests\/([^/]+)\/takeover\/snapshot$/);
    if (method === "GET" && takeoverSnapshotMatch) {
      const requestId = decodeURIComponent(takeoverSnapshotMatch[1]);
      const record = this.records.get(requestId);
      if (!record) {
        sendJson(res, 404, { error: "Request not found." });
        return;
      }
      this.updateTimeoutStatus(record);
      if (record.status !== "pending") {
        sendJson(res, 409, { error: `Request already ${record.status}.` });
        return;
      }
      // Accept token from header (preferred) or query string (fallback).
      const headerToken = req.headers["x-openpocket-auth"];
      const tokenRaw = typeof headerToken === "string" ? headerToken : requestUrl.searchParams.get("token");
      const auth = this.verifyOpenToken(record, tokenRaw);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }
      const runtime = this.ensureTakeoverRuntime();
      if (!runtime) {
        sendJson(res, 501, { error: "Remote takeover runtime is not configured." });
        return;
      }
      try {
        const frame = await runtime.captureFrame();
        sendJson(res, 200, {
          requestId: record.requestId,
          status: record.status,
          frame,
        });
      } catch (error) {
        sendJson(res, 500, { error: `Failed to capture takeover snapshot: ${(error as Error).message}` });
      }
      return;
    }

    const takeoverActionMatch = pathname.match(/^\/v1\/human-auth\/requests\/([^/]+)\/takeover\/action$/);
    if (method === "POST" && takeoverActionMatch) {
      const requestId = decodeURIComponent(takeoverActionMatch[1]);
      const record = this.records.get(requestId);
      if (!record) {
        sendJson(res, 404, { error: "Request not found." });
        return;
      }
      this.updateTimeoutStatus(record);
      if (record.status !== "pending") {
        sendJson(res, 409, { error: `Request already ${record.status}.` });
        return;
      }
      const runtime = this.ensureTakeoverRuntime();
      if (!runtime) {
        sendJson(res, 501, { error: "Remote takeover runtime is not configured." });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req, 500_000);
      } catch (error) {
        sendJson(res, 400, { error: (error as Error).message });
        return;
      }
      if (!isObject(body)) {
        sendJson(res, 400, { error: "Invalid body." });
        return;
      }
      // Accept token from header (preferred) or body (legacy fallback).
      const headerToken = req.headers["x-openpocket-auth"];
      const tokenRaw = typeof headerToken === "string" ? headerToken : body.token;
      const auth = this.verifyOpenToken(record, tokenRaw);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }
      const action = this.parseTakeoverAction(body.action);
      if (!action) {
        sendJson(res, 400, { error: "Invalid takeover action." });
        return;
      }
      // Rate-limit takeover actions to prevent ADB overload.
      const now = Date.now();
      const lastActionAt = this.takeoverActionTimestamps.get(requestId) ?? 0;
      if (now - lastActionAt < HumanAuthRelayServer.TAKEOVER_ACTION_COOLDOWN_MS) {
        sendJson(res, 429, { error: "Too many takeover actions. Please slow down." });
        return;
      }
      this.takeoverActionTimestamps.set(requestId, now);
      try {
        const message = await runtime.execute(action);
        sendJson(res, 200, {
          requestId: record.requestId,
          status: record.status,
          message,
        });
      } catch (error) {
        sendJson(res, 500, { error: `Failed to execute takeover action: ${(error as Error).message}` });
      }
      return;
    }

    const takeoverStreamMatch = pathname.match(/^\/v1\/human-auth\/requests\/([^/]+)\/takeover\/stream$/);
    if (method === "GET" && takeoverStreamMatch) {
      const requestId = decodeURIComponent(takeoverStreamMatch[1]);
      const record = this.records.get(requestId);
      if (!record) {
        sendText(res, 404, "Request not found.");
        return;
      }
      this.updateTimeoutStatus(record);
      if (record.status !== "pending") {
        sendText(res, 409, `Request already ${record.status}.`);
        return;
      }
      const auth = this.verifyOpenToken(record, requestUrl.searchParams.get("token"));
      if (!auth.ok) {
        sendText(res, auth.status, auth.error);
        return;
      }
      const runtime = this.ensureTakeoverRuntime();
      if (!runtime) {
        sendText(res, 501, "Remote takeover runtime is not configured.");
        return;
      }

      // Limit concurrent streams per request to prevent ADB overload.
      const currentStreams = this.takeoverStreamCounts.get(requestId) ?? 0;
      if (currentStreams >= HumanAuthRelayServer.TAKEOVER_MAX_CONCURRENT_STREAMS) {
        sendText(res, 429, "Too many concurrent takeover streams. Close an existing one first.");
        return;
      }
      this.takeoverStreamCounts.set(requestId, currentStreams + 1);

      res.statusCode = 200;
      res.setHeader("content-type", "multipart/x-mixed-replace; boundary=frame");
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("pragma", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders?.();

      const frameIntervalMs = Math.max(180, Math.round(1000 / Math.max(1, Number(this.options.takeoverFps ?? 2))));
      let closed = false;
      let running = false;
      let timer: NodeJS.Timeout | null = null;

      const stop = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        // Decrement the concurrent stream counter for this request.
        const count = this.takeoverStreamCounts.get(requestId) ?? 1;
        if (count <= 1) {
          this.takeoverStreamCounts.delete(requestId);
        } else {
          this.takeoverStreamCounts.set(requestId, count - 1);
        }
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        try {
          res.write("--frame--\r\n");
        } catch {
          // Ignore write errors during close.
        }
        try {
          res.end();
        } catch {
          // Ignore close errors.
        }
      };

      req.on("close", stop);
      res.on("close", stop);
      res.on("error", stop);

      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 5;

      const pushFrame = async (): Promise<void> => {
        if (closed || running) {
          return;
        }
        running = true;
        try {
          this.updateTimeoutStatus(record);
          if (record.status !== "pending") {
            stop();
            return;
          }
          const frame = await runtime.captureFrame();
          if (closed) {
            return;
          }
          await this.writeMjpegFrame(res, frame);
          consecutiveErrors = 0;
        } catch {
          consecutiveErrors += 1;
          // Tolerate transient ADB timeouts; only stop stream after repeated failures.
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            stop();
          }
        } finally {
          running = false;
        }
      };

      timer = setInterval(() => {
        void pushFrame();
      }, frameIntervalMs);
      void pushFrame();
      return;
    }

    const pageMatch = pathname.match(/^\/human-auth\/([^/]+)$/);
    if (method === "GET" && pageMatch) {
      const requestId = decodeURIComponent(pageMatch[1]);
      const record = this.records.get(requestId);
      if (!record) {
        sendText(res, 404, "Request not found.");
        return;
      }
      this.updateTimeoutStatus(record);
      if (record.status !== "pending") {
        sendText(res, 409, `Request already ${record.status}.`);
        return;
      }
      const token = String(requestUrl.searchParams.get("token") ?? "");
      if (!token || hashToken(token) !== record.openTokenHash) {
        sendText(res, 403, "Invalid or expired token.");
        return;
      }
      sendHtml(res, 200, this.renderPortalPage(record, token));
      return;
    }

    sendText(res, 404, "Not found.");
  }
}
