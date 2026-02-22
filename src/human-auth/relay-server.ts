import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { ensureDir, nowIso } from "../utils/paths";
import type {
  HumanAuthTakeoverAction,
  HumanAuthTakeoverFrame,
  HumanAuthTakeoverRuntime,
} from "./takeover-runtime";

type RelayStatus = "pending" | "approved" | "rejected" | "timeout";

type RelayRecord = {
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
  openTokenHash: string;
  pollTokenHash: string;
};

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
}

export class HumanAuthRelayServer {
  private readonly options: HumanAuthRelayServerOptions;
  private readonly records = new Map<string, RelayRecord>();
  private server: http.Server | null = null;

  constructor(options: HumanAuthRelayServerOptions) {
    this.options = options;
    this.loadState();
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
    fs.writeFileSync(
      this.options.stateFile,
      `${JSON.stringify([...this.records.values()], null, 2)}\n`,
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
    }
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

  private renderPortalPage(record: RelayRecord, token: string): string {
    const requestId = escapeHtml(record.requestId);
    const capability = escapeHtml(record.capability);
    const instruction = escapeHtml(record.instruction || "(no instruction)");
    const instructionBrief = escapeHtml(
      (record.instruction || "No instruction provided.")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180),
    );
    const reason = escapeHtml(record.reason || "(no reason)");
    const task = escapeHtml(record.task || "(no task)");
    const currentApp = escapeHtml(record.currentApp || "unknown");
    const tokenEscaped = escapeHtml(token);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenPocket Human Auth</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap");
    :root {
      color-scheme: light;
      --op-brand: #ff8a00;
      --op-brand-dark: #d85700;
      --op-bg: #fff9f2;
      --op-card: #ffffff;
      --op-ink: #131313;
      --op-ink-soft: #5f6368;
      --op-line: #ece7de;
      --op-chip: rgba(255, 138, 0, 0.12);
      --op-shadow: 0 20px 44px rgba(20, 20, 20, 0.08);
    }
    body {
      margin: 0;
      font-family: "Poppins", "Avenir Next", "Segoe UI", Arial, sans-serif;
      color: var(--op-ink);
      background:
        radial-gradient(circle at 85% -10%, rgba(255, 138, 0, 0.22), transparent 36%),
        linear-gradient(155deg, #fffefb 0%, var(--op-bg) 56%, #f4f8ff 100%);
      min-height: 100vh;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      padding: 20px 16px 32px;
      box-sizing: border-box;
    }
    .card {
      background: var(--op-card);
      border: 1px solid var(--op-line);
      border-radius: 22px;
      padding: 16px;
      box-shadow: var(--op-shadow);
    }
    .brandRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .brandPill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--op-chip);
      color: var(--op-brand-dark);
      border: 1px solid rgba(255, 138, 0, 0.3);
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
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
      font-size: 24px;
      line-height: 1.25;
      font-weight: 600;
    }
    .brief {
      margin: 8px 0 0;
      color: var(--op-ink-soft);
      font-size: 14px;
      line-height: 1.5;
    }
    .capabilityLine {
      margin: 10px 0 0;
      font-size: 13px;
      color: #8b4a07;
      background: rgba(255, 138, 0, 0.1);
      border: 1px solid rgba(255, 138, 0, 0.24);
      border-radius: 10px;
      padding: 8px 10px;
    }
    .section {
      margin-top: 14px;
      border: 1px solid var(--op-line);
      border-radius: 16px;
      padding: 12px;
      background: #fff;
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
      border-radius: 10px;
      border: 1px solid #d7dce3;
      padding: 10px;
      box-sizing: border-box;
      font: inherit;
      font-size: 14px;
      background: #fff;
      color: #202124;
    }
    textarea {
      min-height: 68px;
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
    .status {
      margin-top: 10px;
      font-size: 14px;
      font-weight: 600;
      color: #202124;
    }
    .muted {
      color: var(--op-ink-soft);
      font-size: 12px;
      line-height: 1.5;
      margin-top: 8px;
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
      border-radius: 14px;
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
    details.context {
      margin-top: 14px;
      border: 1px solid var(--op-line);
      border-radius: 14px;
      background: #fbfbfd;
      overflow: hidden;
    }
    details.context summary {
      cursor: pointer;
      list-style: none;
      padding: 12px 12px;
      font-size: 14px;
      font-weight: 600;
      color: #272e35;
      border-bottom: 1px solid transparent;
    }
    details.context[open] summary {
      border-bottom-color: var(--op-line);
      background: #f8f9fc;
    }
    .meta {
      display: grid;
      gap: 8px;
      padding: 10px 12px 12px;
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
      .card { padding: 12px; border-radius: 16px; }
      h1 { font-size: 21px; }
      .grid2 { grid-template-columns: 1fr; }
      .brandRow { flex-direction: column; align-items: flex-start; }
      .requestId { text-align: left; }
      .quick-keys {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .takeover-input {
        flex-direction: column;
        align-items: stretch;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="brandRow">
        <div class="brandPill">OpenPocket Human Auth</div>
        <div class="requestId">Request: ${requestId}</div>
      </div>
      <h1>Approve Or Reject To Continue</h1>
      <p class="brief"><b>${capability}</b> requested. ${instructionBrief}</p>
      <div class="capabilityLine" id="capabilityHint"></div>

      <div class="section">
        <label for="note">Optional note</label>
        <textarea id="note" placeholder="e.g., approved with Face ID, verification done"></textarea>
        <div class="actions">
          <button id="approve" type="button">Approve</button>
          <button id="reject" type="button">Reject</button>
        </div>
        <div class="status" id="status"></div>
      </div>

      <div class="section">
        <div class="takeover-head">
          <h2>Remote Takeover (Live)</h2>
          <div class="takeover-meta" id="takeoverMeta">Preparing stream...</div>
        </div>
        <div class="takeover-actions">
          <button id="takeoverStart" type="button">Start Live Stream</button>
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

      <div class="section">
        <h2>Optional Delegated Data</h2>
        <div id="textDelegation">
          <label for="resultText">Text / Code</label>
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

        <div class="actions">
          <button id="startCam" type="button">Enable Camera</button>
          <button id="snapCam" type="button">Capture Snapshot</button>
          <button id="pickPhoto" type="button">Capture / Upload Photo</button>
        </div>
        <div class="muted">Camera attachment is optional. You can approve/reject without photo.</div>
        <video id="video" autoplay playsinline hidden></video>
        <canvas id="canvas" hidden></canvas>
        <img id="photoPreview" alt="Captured preview" hidden />
        <input id="photoInput" type="file" accept="image/*" capture="environment" hidden />
      </div>

      <details class="context">
        <summary>Show Full Context</summary>
        <div class="meta">
          <div class="metaItem"><b>Task</b>${task}</div>
          <div class="metaItem"><b>Capability</b>${capability}</div>
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
    const statusEl = document.getElementById("status");
    const noteEl = document.getElementById("note");
    const capabilityHintEl = document.getElementById("capabilityHint");
    const videoEl = document.getElementById("video");
    const canvasEl = document.getElementById("canvas");
    const photoInputEl = document.getElementById("photoInput");
    const photoPreviewEl = document.getElementById("photoPreview");
    const resultTextEl = document.getElementById("resultText");
    const geoLatEl = document.getElementById("geoLat");
    const geoLonEl = document.getElementById("geoLon");
    const takeoverStreamEl = document.getElementById("takeoverStream");
    const takeoverEmptyEl = document.getElementById("takeoverEmpty");
    const takeoverMetaEl = document.getElementById("takeoverMeta");
    const takeoverStatusEl = document.getElementById("takeoverStatus");
    const takeoverTextEl = document.getElementById("takeoverText");
    let stream = null;
    let artifact = null;
    let takeoverPollingTimer = null;
    let takeoverRunning = false;

    function show(id, visible) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle("hidden", !visible);
    }

    function capabilityHintText(cap) {
      if (cap === "location") return "Recommended: attach location. VM will receive geo coordinates.";
      if (cap === "camera") return "Recommended: attach a photo if app flow needs image input.";
      if (cap === "2fa" || cap === "sms") return "Recommended: attach OTP/code text.";
      if (cap === "qr") return "Recommended: attach decoded QR text or photo.";
      return "Attach optional evidence/data to help the agent continue in VM.";
    }

    function configureByCapability() {
      capabilityHintEl.textContent = capabilityHintText(capability);
      show("geoDelegation", capability === "location");
      show("textDelegation", capability !== "location");
      if (capability === "location") {
        resultTextEl.placeholder = "Optional location note";
      } else if (capability === "sms" || capability === "2fa") {
        resultTextEl.placeholder = "e.g., 6-digit OTP";
      } else if (capability === "qr") {
        resultTextEl.placeholder = "Paste QR decoded content";
      }
    }

    function takeoverUrl(path) {
      return (
        "/v1/human-auth/requests/" +
        encodeURIComponent(requestId) +
        path +
        (path.includes("?") ? "&" : "?") +
        "token=" +
        encodeURIComponent(token)
      );
    }

    function setTakeoverStatus(text) {
      takeoverStatusEl.textContent = text;
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
      const response = await fetch(takeoverUrl("/takeover/snapshot"), {
        method: "GET",
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (!silent) {
          setTakeoverStatus("Snapshot failed: " + (body.error || response.statusText));
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
        "/v1/human-auth/requests/" + encodeURIComponent(requestId) + "/takeover/action",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, action }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (!silent) {
          setTakeoverStatus("Action failed: " + (body.error || response.statusText));
        }
        throw new Error(body.error || response.statusText);
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

    function startTakeoverStream() {
      takeoverRunning = true;
      stopTakeoverPolling();
      takeoverStreamEl.hidden = false;
      takeoverEmptyEl.style.display = "none";
      const url = takeoverUrl("/takeover/stream") + "&ts=" + Date.now();
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

    function humanErrorMessage(err) {
      const name = err && err.name ? String(err.name) : "";
      const message = err && err.message ? String(err.message) : String(err || "unknown error");
      const lowered = (name + " " + message).toLowerCase();
      if (lowered.includes("notallowed") || lowered.includes("permission denied")) {
        return "Camera permission denied by this browser context. In Telegram in-app browser this can happen even after Allow. Use Capture/Upload Photo or approve directly.";
      }
      if (lowered.includes("notfound") || lowered.includes("device not found")) {
        return "No camera device available. Use Capture/Upload Photo or approve directly.";
      }
      if (lowered.includes("notreadable") || lowered.includes("track start failed")) {
        return "Camera is busy or blocked by another app. Close other camera apps and retry, or use Capture/Upload Photo.";
      }
      return "Failed to open camera: " + message;
    }

    function attachTextArtifact() {
      const text = String(resultTextEl.value || "").trim();
      if (!text) {
        statusEl.textContent = "Text is empty.";
        return;
      }
      setJsonArtifact({
        kind: capability === "qr" ? "qr_text" : "text",
        value: text,
        capability,
        capturedAt: new Date().toISOString(),
      });
      statusEl.textContent = "Text attached.";
    }

    function attachGeoArtifact() {
      const lat = Number(geoLatEl.value);
      const lon = Number(geoLonEl.value);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        statusEl.textContent = "Latitude/Longitude is invalid.";
        return;
      }
      setJsonArtifact({
        kind: "geo",
        lat,
        lon,
        capability,
        capturedAt: new Date().toISOString(),
      });
      statusEl.textContent = "Location attached.";
    }

    function useCurrentLocation() {
      if (!navigator.geolocation) {
        statusEl.textContent = "Geolocation is not supported in this browser.";
        return;
      }
      statusEl.textContent = "Fetching location...";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          geoLatEl.value = String(pos.coords.latitude);
          geoLonEl.value = String(pos.coords.longitude);
          attachGeoArtifact();
        },
        (err) => {
          statusEl.textContent = "Failed to read location: " + (err && err.message ? err.message : String(err));
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

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        videoEl.srcObject = stream;
        videoEl.hidden = false;
        photoPreviewEl.hidden = true;
        statusEl.textContent = "Camera enabled. Capture if needed, then approve.";
      } catch (err) {
        statusEl.textContent = humanErrorMessage(err);
      }
    }

    function captureSnapshot() {
      if (!videoEl.videoWidth || !videoEl.videoHeight) {
        statusEl.textContent = "Camera is not ready yet.";
        return;
      }
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
      const ctx = canvasEl.getContext("2d");
      ctx.drawImage(videoEl, 0, 0);
      const dataUrl = canvasEl.toDataURL("image/jpeg", 0.88);
      const base64 = dataUrl.split(",")[1] || "";
      artifact = { mimeType: "image/jpeg", base64 };
      canvasEl.hidden = false;
      photoPreviewEl.hidden = true;
      statusEl.textContent = "Snapshot captured and attached.";
    }

    async function pickPhoto() {
      photoInputEl.value = "";
      photoInputEl.click();
    }

    async function onPhotoChange() {
      const file = photoInputEl.files && photoInputEl.files[0];
      if (!file) {
        return;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        const base64 = dataUrl.split(",")[1] || "";
        const mimeType = file.type || "image/jpeg";
        artifact = { mimeType, base64 };
        canvasEl.hidden = true;
        videoEl.hidden = true;
        photoPreviewEl.src = dataUrl;
        photoPreviewEl.hidden = false;
        statusEl.textContent = "Photo attached.";
      } catch (err) {
        statusEl.textContent = "Failed to attach photo: " + (err && err.message ? err.message : String(err));
      }
    }

    async function submitDecision(approved) {
      statusEl.textContent = "Submitting...";
      try {
        const response = await fetch("/v1/human-auth/requests/" + encodeURIComponent(requestId) + "/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            approved,
            note: noteEl.value || "",
            artifact
          })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          statusEl.textContent = "Failed: " + (body.error || response.statusText);
          return;
        }
        statusEl.textContent = approved ? "Approved. You can close this page." : "Rejected. You can close this page.";
        if (stream) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
        }
        stopTakeoverPolling();
        takeoverRunning = false;
        takeoverStreamEl.removeAttribute("src");
      } catch (err) {
        statusEl.textContent = "Request failed: " + (err && err.message ? err.message : String(err));
      }
    }

    document.getElementById("startCam").addEventListener("click", startCamera);
    document.getElementById("snapCam").addEventListener("click", captureSnapshot);
    document.getElementById("pickPhoto").addEventListener("click", pickPhoto);
    document.getElementById("attachText").addEventListener("click", attachTextArtifact);
    document.getElementById("useGeo").addEventListener("click", useCurrentLocation);
    document.getElementById("attachGeo").addEventListener("click", attachGeoArtifact);
    photoInputEl.addEventListener("change", onPhotoChange);
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
    configureByCapability();
    startTakeoverStream();
  </script>
</body>
</html>`;
  }

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
          snapshotUrl: `${publicBaseUrl}/v1/human-auth/requests/${encodeURIComponent(requestId)}/takeover/snapshot?token=${encodeURIComponent(openToken)}`,
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

    const resolveMatch = pathname.match(/^\/v1\/human-auth\/requests\/([^/]+)\/resolve$/);
    if (method === "POST" && resolveMatch) {
      const requestId = decodeURIComponent(resolveMatch[1]);
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

      let body: unknown;
      try {
        body = await readJsonBody(req, 7_000_000);
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

      const approved = isTruthyBoolean(body.approved);
      record.status = approved ? "approved" : "rejected";
      record.note = String(body.note ?? "").slice(0, 2000);
      record.decidedAt = nowIso();
      record.openTokenHash = "";

      if (
        isObject(body.artifact) &&
        typeof body.artifact.mimeType === "string" &&
        typeof body.artifact.base64 === "string" &&
        body.artifact.base64.length <= 6_000_000
      ) {
        record.artifact = {
          mimeType: body.artifact.mimeType,
          base64: body.artifact.base64,
        };
      } else {
        record.artifact = null;
      }

      this.persistState();
      sendJson(res, 200, {
        requestId: record.requestId,
        status: record.status,
        decidedAt: record.decidedAt,
      });
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
      const auth = this.verifyOpenToken(record, requestUrl.searchParams.get("token"));
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
      const auth = this.verifyOpenToken(record, body.token);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }
      const action = this.parseTakeoverAction(body.action);
      if (!action) {
        sendJson(res, 400, { error: "Invalid takeover action." });
        return;
      }
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
        } catch {
          stop();
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
