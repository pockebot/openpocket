import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { loadConfig, saveConfig } from "../config/index.js";
import { FilePairingStore } from "../channel/pairing.js";
import type { ChannelType } from "../channel/types.js";
import { AdbRuntime } from "../device/adb-runtime.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import { isWorkspaceOnboardingCompleted, markWorkspaceOnboardingCompleted } from "../memory/workspace.js";
import type { OpenPocketConfig } from "../types.js";
import { nowIso, resolvePath } from "../utils/paths.js";
import {
  defaultControlSettings,
  loadControlSettings,
  loadOnboardingState,
  providerLabel,
  saveControlSettings,
  saveOnboardingState,
  type MenuBarControlSettings,
  type OnboardingStateFile,
} from "./control-store.js";

export interface DashboardGatewayStatus {
  running: boolean;
  managed: boolean;
  note: string;
}

export interface DashboardServerOptions {
  config: OpenPocketConfig;
  mode: "standalone" | "integrated";
  host?: string;
  port?: number;
  getGatewayStatus?: () => DashboardGatewayStatus;
  onLogLine?: (line: string) => void;
}

interface PreviewSnapshot {
  deviceId: string;
  currentApp: string;
  width: number;
  height: number;
  screenshotBase64: string;
  capturedAt: string;
}

interface DashboardTraceAction {
  batchDebugItems: Array<{
    index: number;
    actionType: string;
    summary: string;
    imagePath: string;
  }>;
  stepNo: number;
  actionType: string;
  currentApp: string;
  status: "ok" | "error";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  screenshotMs: number;
  modelInferenceMs: number;
  loopDelayMs: number;
  reasoning: string;
  decisionJson: string;
  result: string;
  inputScreenshotPath: string | null;
  debugScreenshotPath: string | null;
  somScreenshotPath: string | null;
  recentScreenshotPaths: string[];
}

interface DashboardTraceRun {
  sessionId: string;
  sessionPath: string;
  task: string;
  modelProfile: string;
  modelName: string;
  status: "running" | "success" | "failed";
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  finalMessage: string;
  actions: DashboardTraceAction[];
}

const TRACE_PARSE_MAX_BYTES = 10 * 1024 * 1024;
const TRACE_PARSE_TAIL_BYTES = 2 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
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

function sendBinary(res: http.ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.end(body);
}

function safeBoolean(value: unknown, fallback = false): boolean {
  if (value === true || value === false) {
    return value;
  }
  return fallback;
}

function sanitizeLogLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function nowHmss(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pathWithin(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  if (!relative) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class DashboardServer {
  private config: OpenPocketConfig;
  private readonly mode: "standalone" | "integrated";
  private readonly host: string;
  private readonly port: number;
  private readonly getGatewayStatusFn: (() => DashboardGatewayStatus) | null;
  private readonly onLogLine: ((line: string) => void) | null;

  private emulator: EmulatorManager;
  private adb: AdbRuntime;
  private server: http.Server | null = null;
  private previewCache: PreviewSnapshot | null = null;
  private readonly logs: string[] = [];
  private emulatorLifecycleQueue: Promise<void> = Promise.resolve();

  constructor(options: DashboardServerOptions) {
    this.config = options.config;
    this.mode = options.mode;
    this.host = options.host?.trim() || options.config.dashboard.host;
    this.port = options.port ?? options.config.dashboard.port;
    this.getGatewayStatusFn = options.getGatewayStatus ?? null;
    this.onLogLine = options.onLogLine ?? null;

    this.emulator = new EmulatorManager(this.config);
    this.adb = new AdbRuntime(this.config, this.emulator);
  }

  get address(): string {
    if (!this.server) {
      return "";
    }
    const addr = this.server.address();
    if (!addr || typeof addr === "string") {
      return "";
    }
    const host = addr.address === "::" ? "127.0.0.1" : addr.address;
    return `http://${host}:${addr.port}`;
  }

  private checkProfileReadiness(): {
    ready: boolean;
    missing: string[];
    values: { assistantName: string; assistantPersona: string; userAddress: string };
  } {
    const missing: string[] = [];
    const placeholders = new Set(["unknown", "tbd", "todo", "null", "n/a", "none", "placeholder", "openpocket"]);
    const extractBullet = (content: string, label: string): string => {
      const re = new RegExp(`^\\s*[-*]\\s*${label}\\s*[:：]\\s*(.+)`, "im");
      const m = content.match(re);
      return (m?.[1] ?? "").trim();
    };
    const isPlaceholder = (v: string) => !v || placeholders.has(v.toLowerCase());

    const idPath = path.join(this.config.workspaceDir, "IDENTITY.md");
    const idContent = fs.existsSync(idPath) ? fs.readFileSync(idPath, "utf-8") : "";
    const assistantName = extractBullet(idContent, "Name");
    const assistantPersona = extractBullet(idContent, "Persona");
    if (isPlaceholder(assistantName)) missing.push("Assistant name (IDENTITY.md → Name)");
    if (isPlaceholder(assistantPersona)) missing.push("Assistant persona (IDENTITY.md → Persona)");

    const userPath = path.join(this.config.workspaceDir, "USER.md");
    const userContent = fs.existsSync(userPath) ? fs.readFileSync(userPath, "utf-8") : "";
    const userAddress = extractBullet(userContent, "Preferred form of address");
    if (isPlaceholder(userAddress))
      missing.push("Your preferred name (USER.md → Preferred form of address)");

    if (!isWorkspaceOnboardingCompleted(this.config.workspaceDir))
      missing.push("Workspace onboarding not yet completed");

    return {
      ready: missing.length === 0,
      missing,
      values: {
        assistantName: isPlaceholder(assistantName) ? "" : assistantName,
        assistantPersona: isPlaceholder(assistantPersona) ? "" : assistantPersona,
        userAddress: isPlaceholder(userAddress) ? "" : userAddress,
      },
    };
  }

  private log(line: string): void {
    this.ingestExternalLogLine(`[dashboard] ${nowHmss()} ${line}`);
  }

  ingestExternalLogLine(line: string): void {
    const text = sanitizeLogLine(line);
    if (!text) {
      return;
    }
    this.logs.push(text);
    if (this.logs.length > 2000) {
      this.logs.splice(0, this.logs.length - 2000);
    }
    this.onLogLine?.(text);
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
      this.server?.listen(this.port, this.host, () => {
        this.server?.removeListener("error", reject);
        resolve();
      });
    });

    this.log(`server started mode=${this.mode} addr=${this.address}`);
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
    this.log("server stopped");
  }

  listLogs(limit = 500): string[] {
    const n = Math.max(1, Math.min(5000, Math.round(limit)));
    if (this.logs.length <= n) {
      return [...this.logs];
    }
    return this.logs.slice(this.logs.length - n);
  }

  clearLogs(): void {
    this.logs.splice(0, this.logs.length);
  }

  private extractTextBlocks(content: unknown): string {
    if (!Array.isArray(content)) {
      return "";
    }
    const chunks: string[] = [];
    for (const part of content) {
      if (!isObject(part)) {
        continue;
      }
      if (part.type !== "text") {
        continue;
      }
      if (typeof part.text !== "string") {
        continue;
      }
      const text = part.text.trim();
      if (text) {
        chunks.push(text);
      }
    }
    return chunks.join("\n").trim();
  }

  private parseIsoOrEmpty(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    return Number.isFinite(Date.parse(trimmed)) ? trimmed : "";
  }

  private parseTraceStatus(value: unknown, fallbackText: string): "ok" | "error" {
    if (value === "ok" || value === "error") {
      return value;
    }
    if (/(error|failed|rejected|denied|timeout|interrupted)/i.test(fallbackText)) {
      return "error";
    }
    return "ok";
  }

  private extractLocalScreenshotPath(text: string): string | null {
    const matched = String(text || "").match(/(?:^|\n)local_screenshot=(.+?)(?:\n|$)/);
    if (!matched?.[1]) {
      return null;
    }
    const resolved = resolvePath(matched[1].trim());
    return resolved || null;
  }

  private extractLocalDebugScreenshotPath(text: string): string | null {
    const matched = String(text || "").match(/(?:^|\n)local_debug_screenshot=(.+?)(?:\n|$)/);
    if (!matched?.[1]) {
      return null;
    }
    const resolved = resolvePath(matched[1].trim());
    return resolved || null;
  }

  private extractLocalSomScreenshotPath(text: string): string | null {
    const matched = String(text || "").match(/(?:^|\n)local_som_screenshot=(.+?)(?:\n|$)/);
    if (!matched?.[1]) {
      return null;
    }
    const resolved = resolvePath(matched[1].trim());
    return resolved || null;
  }

  private extractLocalRecentScreenshotPaths(text: string): string[] {
    const paths: string[] = [];
    const regex = /(?:^|\n)local_recent_screenshot_\d+=(.+?)(?=\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(String(text || ""))) !== null) {
      const resolved = resolvePath(match[1].trim());
      if (resolved) paths.push(resolved);
    }
    return paths;
  }

  private extractBatchDebugItems(text: string): Array<{
    index: number;
    actionType: string;
    summary: string;
    imagePath: string;
  }> {
    const lines = String(text || "").split("\n");
    const items: Array<{
      index: number;
      actionType: string;
      summary: string;
      imagePath: string;
    }> = [];
    let currentIndex = 0;
    let currentActionType = "unknown";
    let currentSummary = "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const batchMatch = line.match(/^\[(\d+)\/\d+\]\s+([a-z_]+):\s*(.+)$/i);
      if (batchMatch) {
        currentIndex = Math.max(1, Math.round(Number(batchMatch[1] || "0")));
        currentActionType = String(batchMatch[2] || "unknown").trim() || "unknown";
        currentSummary = String(batchMatch[3] || "").trim();
        continue;
      }
      const debugMatch = line.match(/^local_debug_screenshot=(.+)$/);
      if (debugMatch?.[1]) {
        if (currentIndex <= 0) {
          continue;
        }
        const resolved = resolvePath(debugMatch[1].trim());
        if (resolved) {
          items.push({
            index: currentIndex > 0 ? currentIndex : items.length + 1,
            actionType: currentActionType,
            summary: currentSummary,
            imagePath: resolved,
          });
        }
      }
    }

    return items;
  }

  private stripLocalScreenshotLine(text: string): string {
    return String(text || "")
      .replace(/(?:^|\n)local_screenshot=.+?(?=\n|$)/g, "")
      .replace(/(?:^|\n)local_debug_screenshot=.+?(?=\n|$)/g, "")
      .replace(/(?:^|\n)local_som_screenshot=.+?(?=\n|$)/g, "")
      .replace(/(?:^|\n)local_recent_screenshot_\d+=.+?(?=\n|$)/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private parseFallbackStepContent(raw: string): DashboardTraceAction | null {
    const text = String(raw || "");
    if (!text.trim()) {
      return null;
    }
    const stepNoRaw = Number((text.match(/^step:\s*(\d+)/m)?.[1] ?? "0"));
    if (!Number.isFinite(stepNoRaw) || stepNoRaw <= 0) {
      return null;
    }
    const stepNo = Math.round(stepNoRaw);
    const at = this.parseIsoOrEmpty(text.match(/^at:\s*(.+)$/m)?.[1] ?? "");

    const thoughtStart = text.indexOf("thought:\n");
    const actionStart = text.indexOf("\naction_json:\n");
    const resultStart = text.indexOf("\nexecution_result:\n");

    let reasoning = "";
    if (thoughtStart >= 0 && actionStart > thoughtStart) {
      reasoning = text.slice(thoughtStart + "thought:\n".length, actionStart).trim();
    }

    let actionType = "unknown";
    let decisionJson = "";
    if (actionStart >= 0 && resultStart > actionStart) {
      const actionJson = text.slice(actionStart + "\naction_json:\n".length, resultStart).trim();
      decisionJson = actionJson;
      try {
        const parsed = JSON.parse(actionJson) as { type?: unknown };
        if (typeof parsed.type === "string" && parsed.type.trim()) {
          actionType = parsed.type.trim();
        }
      } catch {
        actionType = "unknown";
      }
    }

    const rawResult = resultStart >= 0
      ? text.slice(resultStart + "\nexecution_result:\n".length).trim()
      : "";
    const inputScreenshotPath = this.extractLocalScreenshotPath(rawResult);
    const debugScreenshotPath = this.extractLocalDebugScreenshotPath(rawResult);
    const somScreenshotPath = this.extractLocalSomScreenshotPath(rawResult);
    const recentScreenshotPaths = this.extractLocalRecentScreenshotPaths(rawResult);
    const batchDebugItems = this.extractBatchDebugItems(rawResult);
    const result = this.stripLocalScreenshotLine(rawResult);

    return {
      stepNo,
      batchDebugItems,
      actionType,
      currentApp: "unknown",
      status: this.parseTraceStatus(undefined, result),
      startedAt: at || nowIso(),
      endedAt: at || nowIso(),
      durationMs: 0,
      screenshotMs: 0,
      modelInferenceMs: 0,
      loopDelayMs: 0,
      reasoning,
      decisionJson,
      result,
      inputScreenshotPath,
      debugScreenshotPath,
      somScreenshotPath,
      recentScreenshotPaths,
    };
  }

  private readTraceFileContent(filePath: string): { raw: string; truncated: boolean } | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
    if (stat.size <= 0) {
      return { raw: "", truncated: false };
    }

    if (stat.size <= TRACE_PARSE_MAX_BYTES) {
      try {
        return { raw: fs.readFileSync(filePath, "utf-8"), truncated: false };
      } catch {
        return null;
      }
    }

    const tailBytes = Math.max(1, Math.min(TRACE_PARSE_TAIL_BYTES, stat.size));
    const offset = Math.max(0, stat.size - tailBytes);
    let fd: number | null = null;
    try {
      fd = fs.openSync(filePath, "r");
      const buffer = Buffer.allocUnsafe(tailBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, tailBytes, offset);
      let raw = buffer.subarray(0, bytesRead).toString("utf-8");
      // Drop the potentially partial first line when reading a tail chunk.
      if (offset > 0) {
        const firstLineBreak = raw.indexOf("\n");
        raw = firstLineBreak >= 0 ? raw.slice(firstLineBreak + 1) : "";
      }
      return { raw, truncated: true };
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close failures
        }
      }
    }
  }

  private parseSessionTraceFile(filePath: string): { runs: DashboardTraceRun[]; truncated: boolean } {
    const content = this.readTraceFileContent(filePath);
    if (!content) {
      return { runs: [], truncated: false };
    }
    const raw = content.raw;
    if (!raw.trim()) {
      return { runs: [], truncated: content.truncated };
    }

    type RunAccumulator = {
      task: string;
      modelProfile: string;
      modelName: string;
      startedAt: string;
      endedAt: string | null;
      finalMessage: string;
      finalStopReason: string;
      actionTraceByStep: Map<number, DashboardTraceAction>;
      fallbackStepByStep: Map<number, DashboardTraceAction>;
    };

    let sessionId = path.basename(filePath, ".jsonl");
    const accumulators: RunAccumulator[] = [];
    let current: RunAccumulator | null = null;

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(entry)) {
        continue;
      }

      if (entry.type === "session") {
        if (typeof entry.id === "string" && entry.id.trim()) {
          sessionId = entry.id.trim();
        }
        continue;
      }

      if (entry.type !== "message" || !isObject(entry.message)) {
        continue;
      }
      const message = entry.message as Record<string, unknown>;
      const role = String(message.role ?? "").trim();
      const entryTimestamp = this.parseIsoOrEmpty(entry.timestamp);

      if (role === "user") {
        const taskText = this.extractTextBlocks(message.content);
        if (taskText) {
          current = {
            task: taskText,
            modelProfile: "",
            modelName: "",
            startedAt: entryTimestamp || "",
            endedAt: null,
            finalMessage: "",
            finalStopReason: "",
            actionTraceByStep: new Map(),
            fallbackStepByStep: new Map(),
          };
          accumulators.push(current);
        }
        continue;
      }

      if (!current) {
        continue;
      }

      if (role === "assistant" && String(message.model ?? "") === "session-task-outcome") {
        current.endedAt = entryTimestamp || current.endedAt;
        current.finalMessage = this.extractTextBlocks(message.content);
        current.finalStopReason = String(message.stopReason ?? "").trim().toLowerCase();
        current = null;
        continue;
      }

      if (role !== "custom") {
        continue;
      }

      const customType = String(message.customType ?? "").trim();
      const details = isObject(message.details) ? message.details : {};

      if (customType === "openpocket_session_meta") {
        if (typeof details.modelProfile === "string" && details.modelProfile.trim()) {
          current.modelProfile = details.modelProfile.trim();
        }
        if (typeof details.modelName === "string" && details.modelName.trim()) {
          current.modelName = details.modelName.trim();
        }
        continue;
      }

      if (customType === "openpocket_action_trace") {
        const stepNoRaw = Number(details.stepNo ?? 0);
        if (!Number.isFinite(stepNoRaw) || stepNoRaw <= 0) {
          continue;
        }
        const stepNo = Math.round(stepNoRaw);
        const actionType = typeof details.actionType === "string" && details.actionType.trim()
          ? details.actionType.trim()
          : "unknown";
        const currentApp = typeof details.currentApp === "string" && details.currentApp.trim()
          ? details.currentApp.trim()
          : "unknown";
        const startedAtTrace = this.parseIsoOrEmpty(details.startedAt) || entryTimestamp || nowIso();
        const endedAtTrace = this.parseIsoOrEmpty(details.endedAt) || entryTimestamp || startedAtTrace;
        const durationMsRaw = Number(details.durationMs ?? 0);
        const durationMs = Number.isFinite(durationMsRaw)
          ? Math.max(0, Math.round(durationMsRaw))
          : Math.max(0, Date.parse(endedAtTrace) - Date.parse(startedAtTrace));
        const reasoning = typeof details.reasoning === "string"
          ? details.reasoning
          : this.extractTextBlocks(message.content);
        const rawResult = typeof details.result === "string"
          ? details.result
          : "";
        const result = this.stripLocalScreenshotLine(rawResult);
        const inputScreenshotPath = this.extractLocalScreenshotPath(rawResult);
        const debugScreenshotPath = this.extractLocalDebugScreenshotPath(rawResult);
        const somScreenshotPath = this.extractLocalSomScreenshotPath(rawResult);
        const recentScreenshotPaths = this.extractLocalRecentScreenshotPaths(rawResult);
        const batchDebugItems = this.extractBatchDebugItems(rawResult);
        const screenshotMsRaw = Number(details.screenshotMs ?? 0);
        const modelInferenceMsRaw = Number(details.modelInferenceMs ?? 0);
        const loopDelayMsRaw = Number(details.loopDelayMs ?? 0);
        current.actionTraceByStep.set(stepNo, {
          stepNo,
          batchDebugItems,
          actionType,
          currentApp,
          status: this.parseTraceStatus(details.status, result),
          startedAt: startedAtTrace,
          endedAt: endedAtTrace,
          durationMs,
          screenshotMs: Number.isFinite(screenshotMsRaw) ? Math.max(0, Math.round(screenshotMsRaw)) : 0,
          modelInferenceMs: Number.isFinite(modelInferenceMsRaw) ? Math.max(0, Math.round(modelInferenceMsRaw)) : 0,
          loopDelayMs: Number.isFinite(loopDelayMsRaw) ? Math.max(0, Math.round(loopDelayMsRaw)) : 0,
          reasoning,
          decisionJson: typeof details.actionJson === "string" ? details.actionJson : "",
          result,
          inputScreenshotPath,
          debugScreenshotPath,
          somScreenshotPath,
          recentScreenshotPaths,
        });
        continue;
      }

      if (customType === "openpocket_step") {
        const fallback = this.parseFallbackStepContent(this.extractTextBlocks(message.content));
        if (fallback && isObject(details.trace)) {
          const trace = details.trace;
          if (typeof trace.actionType === "string" && trace.actionType.trim()) {
            fallback.actionType = trace.actionType.trim();
          }
          if (typeof trace.currentApp === "string" && trace.currentApp.trim()) {
            fallback.currentApp = trace.currentApp.trim();
          }
          const startedAtTrace = this.parseIsoOrEmpty(trace.startedAt);
          const endedAtTrace = this.parseIsoOrEmpty(trace.endedAt);
          if (startedAtTrace) {
            fallback.startedAt = startedAtTrace;
          }
          if (endedAtTrace) {
            fallback.endedAt = endedAtTrace;
          }
          const durationMsRaw = Number(trace.durationMs ?? 0);
          if (Number.isFinite(durationMsRaw)) {
            fallback.durationMs = Math.max(0, Math.round(durationMsRaw));
          }
          const screenshotMsFb = Number(trace.screenshotMs ?? 0);
          if (Number.isFinite(screenshotMsFb)) {
            fallback.screenshotMs = Math.max(0, Math.round(screenshotMsFb));
          }
          const modelInferenceMsFb = Number(trace.modelInferenceMs ?? 0);
          if (Number.isFinite(modelInferenceMsFb)) {
            fallback.modelInferenceMs = Math.max(0, Math.round(modelInferenceMsFb));
          }
          const loopDelayMsFb = Number(trace.loopDelayMs ?? 0);
          if (Number.isFinite(loopDelayMsFb)) {
            fallback.loopDelayMs = Math.max(0, Math.round(loopDelayMsFb));
          }
          fallback.status = this.parseTraceStatus(trace.status, fallback.result);
        }
        if (fallback && !current.fallbackStepByStep.has(fallback.stepNo)) {
          current.fallbackStepByStep.set(fallback.stepNo, fallback);
        }
      }
    }

    const results: DashboardTraceRun[] = [];
    for (let i = 0; i < accumulators.length; i++) {
      const run = accumulators[i];
      if (!run.startedAt) {
        run.startedAt = nowIso();
      }
      if (!run.modelProfile) {
        run.modelProfile = "unknown";
      }
      if (!run.modelName) {
        run.modelName = "unknown";
      }

      const mergedActions = new Map<number, DashboardTraceAction>(run.fallbackStepByStep);
      for (const [stepNo, action] of run.actionTraceByStep.entries()) {
        const fallback = mergedActions.get(stepNo);
        mergedActions.set(stepNo, {
          ...fallback,
          ...action,
          batchDebugItems: action.batchDebugItems?.length ? action.batchDebugItems : (fallback?.batchDebugItems || []),
          decisionJson: action.decisionJson || fallback?.decisionJson || "",
          inputScreenshotPath: action.inputScreenshotPath || fallback?.inputScreenshotPath || null,
          debugScreenshotPath: action.debugScreenshotPath || fallback?.debugScreenshotPath || null,
          somScreenshotPath: action.somScreenshotPath || fallback?.somScreenshotPath || null,
          recentScreenshotPaths: action.recentScreenshotPaths?.length ? action.recentScreenshotPaths : (fallback?.recentScreenshotPaths || []),
        });
      }
      const actions = Array.from(mergedActions.values()).sort((a, b) => a.stepNo - b.stepNo);

      let durationMs: number | null = null;
      const startedMs = Date.parse(run.startedAt);
      const endedMs = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
      if (Number.isFinite(startedMs) && Number.isFinite(endedMs)) {
        durationMs = Math.max(0, endedMs - startedMs);
      } else if (Number.isFinite(startedMs) && actions.length > 0) {
        const latestEnded = Date.parse(actions[actions.length - 1].endedAt);
        if (Number.isFinite(latestEnded)) {
          durationMs = Math.max(0, latestEnded - startedMs);
        }
      }

      const status: DashboardTraceRun["status"] = run.endedAt
        ? (run.finalStopReason === "error" ? "failed" : "success")
        : "running";

      const runSessionId = accumulators.length > 1
        ? `${sessionId}#${i + 1}`
        : sessionId;

      results.push({
        sessionId: runSessionId,
        sessionPath: filePath,
        task: run.task,
        modelProfile: run.modelProfile,
        modelName: run.modelName,
        status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs,
        finalMessage: run.finalMessage,
        actions,
      });
    }
    return { runs: results, truncated: content.truncated };
  }

  private readTraceRuns(limitRuns = 12): { runs: DashboardTraceRun[]; skippedFiles: number; truncatedFiles: number } {
    const limit = Math.max(1, Math.min(100, Math.round(limitRuns)));
    const sessionsDir = path.join(this.config.workspaceDir, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return { runs: [], skippedFiles: 0, truncatedFiles: 0 };
    }
    let skippedFiles = 0;
    let truncatedFiles = 0;
    const candidates = fs.readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(sessionsDir, name))
      .map((filePath) => {
        try {
          const stat = fs.statSync(filePath);
          return { filePath, mtimeMs: stat.mtimeMs };
        } catch {
          skippedFiles += 1;
          return null;
        }
      })
      .filter((item): item is { filePath: string; mtimeMs: number } => Boolean(item))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const allRuns: DashboardTraceRun[] = [];
    for (const candidate of candidates) {
      const parsed = this.parseSessionTraceFile(candidate.filePath);
      if (parsed.truncated) {
        truncatedFiles += 1;
      }
      allRuns.push(...parsed.runs);
      if (allRuns.length >= limit) {
        break;
      }
    }
    allRuns.sort((a, b) => {
      const aMs = Date.parse(a.startedAt);
      const bMs = Date.parse(b.startedAt);
      if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
        return bMs - aMs;
      }
      return 0;
    });
    return { runs: allRuns.slice(0, limit), skippedFiles, truncatedFiles };
  }

  private async runEmulatorLifecycleExclusive<T>(action: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.emulatorLifecycleQueue;
    let resolveQueue!: () => void;
    this.emulatorLifecycleQueue = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });

    await previous;
    this.log(`emulator action begin ${action}`);
    try {
      return await fn();
    } finally {
      this.log(`emulator action end ${action}`);
      resolveQueue();
    }
  }

  private gatewayStatus(): DashboardGatewayStatus {
    if (this.getGatewayStatusFn) {
      try {
        return this.getGatewayStatusFn();
      } catch {
        return {
          running: false,
          managed: this.mode === "integrated",
          note: "gateway status callback failed",
        };
      }
    }
    return {
      running: this.mode === "integrated",
      managed: this.mode === "integrated",
      note:
        this.mode === "integrated"
          ? "managed by current gateway process"
          : "status unavailable in standalone mode",
    };
  }

  private runtimePayload(): Record<string, unknown> {
    const emulator = (() => {
      try {
        return this.emulator.status();
      } catch (error) {
        return {
          targetType: this.config.target.type,
          avdName: this.config.emulator.avdName,
          devices: [],
          bootedDevices: [],
          error: (error as Error).message,
        };
      }
    })();
    const emulatorError = "error" in emulator ? String(emulator.error ?? "") : "";
    return {
      mode: this.mode,
      gateway: this.gatewayStatus(),
      emulator: {
        targetType: emulator.targetType,
        avdName: emulator.avdName,
        devices: emulator.devices,
        bootedDevices: emulator.bootedDevices,
        statusText:
          emulatorError
            ? `Unavailable (${emulatorError})`
            : emulator.bootedDevices.length > 0
            ? `Running (${emulator.bootedDevices.join(", ")})`
            : emulator.devices.length > 0
              ? `Starting (${emulator.devices.join(", ")})`
              : "Stopped",
        error: emulatorError || null,
      },
      dashboard: {
        address: this.address,
      },
      config: {
        configPath: this.config.configPath,
        stateDir: this.config.stateDir,
        workspaceDir: this.config.workspaceDir,
        defaultModel: this.config.defaultModel,
        projectName: this.config.projectName,
      },
      preview: this.previewCache,
      now: nowIso(),
    };
  }

  private applyConfigPatch(input: unknown): OpenPocketConfig {
    if (!isObject(input)) {
      throw new Error("Invalid config patch payload.");
    }

    const next: OpenPocketConfig = {
      ...this.config,
      emulator: { ...this.config.emulator },
      agent: { ...this.config.agent },
      dashboard: { ...this.config.dashboard },
    };

    if (typeof input.projectName === "string" && input.projectName.trim()) {
      next.projectName = input.projectName.trim();
    }
    if (typeof input.workspaceDir === "string" && input.workspaceDir.trim()) {
      next.workspaceDir = resolvePath(input.workspaceDir.trim());
    }
    if (typeof input.stateDir === "string" && input.stateDir.trim()) {
      next.stateDir = resolvePath(input.stateDir.trim());
    }
    if (typeof input.defaultModel === "string" && input.defaultModel.trim()) {
      const candidate = input.defaultModel.trim();
      if (!next.models[candidate]) {
        throw new Error(`Unknown default model: ${candidate}`);
      }
      next.defaultModel = candidate;
    }

    if (isObject(input.emulator)) {
      if (typeof input.emulator.avdName === "string" && input.emulator.avdName.trim()) {
        next.emulator.avdName = input.emulator.avdName.trim();
      }
      if (
        typeof input.emulator.androidSdkRoot === "string" &&
        input.emulator.androidSdkRoot.trim()
      ) {
        next.emulator.androidSdkRoot = resolvePath(input.emulator.androidSdkRoot.trim());
      }
      if (typeof input.emulator.bootTimeoutSec === "number" && Number.isFinite(input.emulator.bootTimeoutSec)) {
        next.emulator.bootTimeoutSec = Math.max(20, Math.round(input.emulator.bootTimeoutSec));
      }
      if (typeof input.emulator.headless === "boolean") {
        next.emulator.headless = input.emulator.headless;
      }
    }

    if (isObject(input.agent)) {
      if (typeof input.agent.deviceId === "string" && input.agent.deviceId.trim()) {
        next.agent.deviceId = input.agent.deviceId.trim();
      } else if (input.agent.deviceId === null || input.agent.deviceId === "") {
        next.agent.deviceId = null;
      }
    }

    if (isObject(input.dashboard)) {
      if (typeof input.dashboard.host === "string" && input.dashboard.host.trim()) {
        next.dashboard.host = input.dashboard.host.trim();
      }
      if (typeof input.dashboard.port === "number" && Number.isFinite(input.dashboard.port)) {
        next.dashboard.port = Math.max(1, Math.min(65535, Math.round(input.dashboard.port)));
      }
      if (typeof input.dashboard.enabled === "boolean") {
        next.dashboard.enabled = input.dashboard.enabled;
      }
      if (typeof input.dashboard.autoOpenBrowser === "boolean") {
        next.dashboard.autoOpenBrowser = input.dashboard.autoOpenBrowser;
      }
    }

    saveConfig(next);
    this.config = loadConfig(this.config.configPath);
    this.emulator = new EmulatorManager(this.config);
    this.adb = new AdbRuntime(this.config, this.emulator);
    this.log("config patched and reloaded");
    return this.config;
  }

  private readScopedFiles(control: MenuBarControlSettings): string[] {
    const permission = control.permission;
    if (!permission.allowLocalStorageView) {
      return [];
    }

    const root = resolvePath(permission.storageDirectoryPath || this.config.workspaceDir);
    if (!fs.existsSync(root)) {
      return [];
    }

    const allowedSubpaths = permission.allowedSubpaths.length > 0 ? permission.allowedSubpaths : [""];
    const allowedPrefixes = allowedSubpaths
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => path.resolve(root, segment));
    if (allowedPrefixes.length === 0) {
      allowedPrefixes.push(root);
    }

    const allowedExt = new Set(permission.allowedExtensions.map((ext) => ext.toLowerCase()));
    const output: string[] = [];

    const stack = [root];
    while (stack.length > 0 && output.length < 2000) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.isSymbolicLink()) {
            continue;
          }
          const shouldTraverse = allowedPrefixes.some((prefix) =>
            pathWithin(fullPath, prefix) || pathWithin(prefix, fullPath),
          );
          if (!shouldTraverse) {
            continue;
          }
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        const ext = path.extname(fullPath).replace(/^\./, "").toLowerCase();
        if (allowedExt.size > 0 && !allowedExt.has(ext)) {
          continue;
        }

        if (!allowedPrefixes.some((prefix) => pathWithin(prefix, fullPath))) {
          continue;
        }

        output.push(fullPath);
        if (output.length >= 2000) {
          break;
        }
      }
    }

    output.sort((a, b) => a.localeCompare(b));
    return output;
  }

  private readScopedFile(control: MenuBarControlSettings, filePath: string): string {
    const permission = control.permission;
    if (!permission.allowLocalStorageView) {
      throw new Error("Local storage file view permission is disabled.");
    }
    const resolved = resolvePath(filePath);
    const root = resolvePath(permission.storageDirectoryPath || this.config.workspaceDir);
    if (!pathWithin(root, resolved)) {
      throw new Error("Selected file is outside storage root.");
    }

    const allowedSubpaths = permission.allowedSubpaths.length > 0 ? permission.allowedSubpaths : [""];
    const allowedPrefixes = allowedSubpaths
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => path.resolve(root, segment));
    if (allowedPrefixes.length === 0) {
      allowedPrefixes.push(root);
    }

    if (!allowedPrefixes.some((prefix) => pathWithin(prefix, resolved))) {
      throw new Error("Selected file is outside allowed scope.");
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 2_000_000) {
      throw new Error(`File too large (${stat.size} bytes).`);
    }

    const content = fs.readFileSync(resolved);
    return content.toString("utf-8");
  }

  private readPromptFile(promptPath: string): string {
    const resolved = resolvePath(promptPath);
    if (!fs.existsSync(resolved)) {
      return "";
    }
    const stat = fs.statSync(resolved);
    if (stat.size > 2_000_000) {
      throw new Error(`Prompt file too large (${stat.size} bytes).`);
    }
    const content = fs.readFileSync(resolved);
    return content.toString("utf-8");
  }

  private savePromptFile(promptPath: string, content: string): void {
    const resolved = resolvePath(promptPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
  }

  private readTraceScreenshotFile(filePath: string): { content: Buffer; contentType: string; path: string } {
    const resolved = resolvePath(filePath);
    if (!resolved || !fs.existsSync(resolved)) {
      throw new Error("Trace screenshot not found.");
    }

    const allowedRoots = new Set<string>([
      resolvePath(this.config.workspaceDir),
      resolvePath(this.config.screenshots.directory),
    ]);
    const stateScreenshots = path.join(resolvePath(this.config.stateDir), "screenshots");
    allowedRoots.add(resolvePath(stateScreenshots));

    const allowed = Array.from(allowedRoots).some((root) => root && pathWithin(root, resolved));
    if (!allowed) {
      throw new Error("Trace screenshot path is outside allowed roots.");
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 10_000_000) {
      throw new Error(`Trace screenshot too large (${stat.size} bytes).`);
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : "image/png";
    return {
      content: fs.readFileSync(resolved),
      contentType,
      path: resolved,
    };
  }

  private applyOnboarding(input: unknown): { onboarding: OnboardingStateFile; config: OpenPocketConfig } {
    if (!isObject(input)) {
      throw new Error("Invalid onboarding payload.");
    }

    const consentAccepted = safeBoolean(input.consentAccepted, false);
    const selectedModelProfile = String(input.selectedModelProfile ?? "").trim();
    const useEnvKey = safeBoolean(input.useEnvKey, true);
    const rawApiKey = String(input.apiKey ?? "").trim();
    const gmailLoginDone = safeBoolean(input.gmailLoginDone, false);

    if (!consentAccepted) {
      throw new Error("Consent is required before onboarding can be saved.");
    }
    if (!selectedModelProfile || !this.config.models[selectedModelProfile]) {
      throw new Error("Selected model profile is invalid.");
    }

    const nextConfig: OpenPocketConfig = {
      ...this.config,
      models: { ...this.config.models },
      defaultModel: selectedModelProfile,
    };

    if (!useEnvKey && rawApiKey) {
      const selected = nextConfig.models[selectedModelProfile];
      const providerHost = (() => {
        try {
          return new URL(selected.baseUrl).host.toLowerCase();
        } catch {
          return selected.baseUrl.toLowerCase();
        }
      })();

      for (const [modelName, profile] of Object.entries(nextConfig.models)) {
        const currentHost = (() => {
          try {
            return new URL(profile.baseUrl).host.toLowerCase();
          } catch {
            return profile.baseUrl.toLowerCase();
          }
        })();
        if (currentHost === providerHost || profile.apiKeyEnv === selected.apiKeyEnv) {
          nextConfig.models[modelName] = {
            ...profile,
            apiKey: rawApiKey,
            apiKeyEnv: selected.apiKeyEnv,
          };
        }
      }
    }

    saveConfig(nextConfig);
    this.config = loadConfig(this.config.configPath);
    this.emulator = new EmulatorManager(this.config);
    this.adb = new AdbRuntime(this.config, this.emulator);

    const now = nowIso();
    const onboarding: OnboardingStateFile = {
      ...loadOnboardingState(this.config),
      updatedAt: now,
      consentAcceptedAt: loadOnboardingState(this.config).consentAcceptedAt ?? now,
      modelProfile: selectedModelProfile,
      modelProvider: providerLabel(this.config.models[selectedModelProfile].baseUrl),
      modelConfiguredAt: now,
      apiKeyEnv: this.config.models[selectedModelProfile].apiKeyEnv,
      apiKeySource: useEnvKey ? "env" : "config",
      apiKeyConfiguredAt: now,
      gmailLoginConfirmedAt: gmailLoginDone ? now : null,
    };
    saveOnboardingState(this.config, onboarding);

    // Write profile fields if provided.
    const assistantName = String(input.assistantName ?? "").trim();
    const assistantPersona = String(input.assistantPersona ?? "").trim();
    const userAddress = String(input.userAddress ?? "").trim();

    if (assistantName || assistantPersona) {
      const idPath = path.join(this.config.workspaceDir, "IDENTITY.md");
      fs.mkdirSync(path.dirname(idPath), { recursive: true });
      fs.writeFileSync(idPath, [
        "# IDENTITY",
        "",
        `- Name: ${assistantName || "OpenPocket"}`,
        `- Persona: ${assistantPersona || "Helpful assistant"}`,
        "",
      ].join("\n"), "utf-8");
    }

    if (userAddress) {
      const userPath = path.join(this.config.workspaceDir, "USER.md");
      fs.mkdirSync(path.dirname(userPath), { recursive: true });
      fs.writeFileSync(userPath, [
        "# USER",
        "",
        `- Preferred form of address: ${userAddress}`,
        "",
      ].join("\n"), "utf-8");
    }

    // Mark workspace onboarding complete if profile is now filled.
    const readiness = this.checkProfileReadiness();
    if (readiness.ready || (assistantName && assistantPersona && userAddress)) {
      if (!isWorkspaceOnboardingCompleted(this.config.workspaceDir)) {
        markWorkspaceOnboardingCompleted(this.config.workspaceDir);
      }
    }

    this.log(`onboarding applied model=${selectedModelProfile} source=${onboarding.apiKeySource}`);

    return {
      onboarding,
      config: this.config,
    };
  }

  private credentialStatusMap(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [profileName, profile] of Object.entries(this.config.models)) {
      const configKey = profile.apiKey.trim();
      const envName = profile.apiKeyEnv;
      const envValue = (process.env[envName] ?? "").trim();

      if (configKey) {
        if (!envValue) {
          result[profileName] = `Credential source: config.json (detected, length ${configKey.length}). ${envName} is optional.`;
        } else {
          result[profileName] = `Credential source: config.json (detected, length ${configKey.length}). ${envName} also detected (length ${envValue.length}).`;
        }
        continue;
      }

      if (envValue) {
        result[profileName] = `Credential source: ${envName} env var (detected, length ${envValue.length}).`;
      } else {
        result[profileName] = `No API key found in config.json or ${envName}.`;
      }
    }
    return result;
  }

  private htmlShell(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenPocket Dashboard</title>
  <style>
    :root {
      --bg-0: #f6f2eb;
      --bg-1: #eef6ff;
      --ink-0: #111827;
      --ink-1: #3a4352;
      --brand: #0b8f6a;
      --brand-soft: #d7f5ea;
      --danger: #a92929;
      --card: rgba(255, 255, 255, 0.92);
      --line: #d7dee8;
      --shadow: 0 14px 40px rgba(15, 35, 60, 0.12);
      --mono: "SF Mono", "Menlo", "Consolas", monospace;
      --sans: "Avenir Next", "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--sans);
      color: var(--ink-0);
      background:
        radial-gradient(1200px 400px at 15% -5%, #f9e1c8 0%, transparent 55%),
        radial-gradient(900px 420px at 100% -10%, #cae8ff 0%, transparent 60%),
        linear-gradient(160deg, var(--bg-0), var(--bg-1));
    }
    .layout {
      max-width: 1280px;
      margin: 0 auto;
      padding: 20px 22px 30px;
      display: grid;
      gap: 14px;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: space-between;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
      padding: 14px 16px;
    }
    .title {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .title h1 {
      margin: 0;
      font-size: 29px;
      letter-spacing: 0.2px;
    }
    .subtitle {
      margin: 0;
      color: var(--ink-1);
      font-size: 13px;
    }
    .badge-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .badge {
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--line);
      background: #fff;
      color: #2b3340;
    }
    .badge.ok {
      background: var(--brand-soft);
      color: #0f6f52;
      border-color: #bde7d7;
    }
    .tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tab-btn {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      color: #1f2b3d;
      padding: 9px 14px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 120ms ease, background 120ms ease;
    }
    .tab-btn:hover {
      transform: translateY(-1px);
      background: #f4f8fc;
    }
    .tab-btn.active {
      background: #e7f6ef;
      border-color: #b9e9d6;
      color: #0e6f51;
    }
    .status-line {
      font-size: 13px;
      color: var(--ink-1);
      padding: 0 3px;
      min-height: 20px;
    }
    .tab-panel {
      display: none;
      animation: rise 180ms ease-out;
    }
    .tab-panel.active {
      display: block;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .grid {
      display: grid;
      gap: 12px;
    }
    .grid.cols-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .core-paths-grid {
      grid-template-columns: 1fr;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 18px;
    }
    .hint {
      color: var(--ink-1);
      font-size: 13px;
      margin-top: 3px;
      margin-bottom: 10px;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .row.spread {
      justify-content: space-between;
    }
    .btn {
      border: 1px solid #bfd3e2;
      background: #fff;
      color: #172234;
      border-radius: 9px;
      cursor: pointer;
      font-weight: 700;
      padding: 8px 12px;
    }
    .btn.primary {
      border-color: #0f906a;
      background: #0f906a;
      color: #fff;
    }
    .btn.warn {
      border-color: #b73f3f;
      background: #b73f3f;
      color: #fff;
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    input[type="text"], input[type="password"], select, textarea {
      width: 100%;
      border: 1px solid #c7d4e2;
      border-radius: 9px;
      background: #fff;
      padding: 8px 10px;
      color: #122133;
      font-size: 14px;
      font-family: inherit;
    }
    textarea {
      min-height: 96px;
      resize: vertical;
    }
    .kv {
      font-size: 13px;
      color: var(--ink-1);
      margin-top: 8px;
      line-height: 1.5;
    }
    .kv code {
      font-family: var(--mono);
      font-size: 12px;
      color: #14365a;
      background: #edf4fb;
      border-radius: 6px;
      padding: 2px 5px;
    }
    .preview-wrap {
      position: relative;
      background: #0b1118;
      border-radius: 12px;
      min-height: 270px;
      overflow: hidden;
      border: 1px solid #0d1723;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #preview-image {
      max-width: 100%;
      max-height: 420px;
      display: none;
      cursor: crosshair;
      image-rendering: auto;
    }
    .preview-empty {
      color: #dbe7f4;
      font-size: 13px;
      text-align: center;
      padding: 14px;
    }
    .mono {
      font-family: var(--mono);
      font-size: 12px;
    }
    .placeholder {
      color: var(--ink-1);
      font-size: 14px;
      line-height: 1.7;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(260px, 34%) 1fr;
      gap: 10px;
    }
    .runtime-layout {
      display: grid;
      grid-template-columns: minmax(340px, 32%) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .runtime-left {
      display: grid;
      gap: 12px;
    }
    .runtime-right {
      min-width: 0;
    }
    .runtime-preview-card {
      min-height: 78vh;
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      gap: 10px;
    }
    .runtime-preview-wrap {
      min-height: 58vh;
      max-height: none;
      height: 100%;
    }
    .runtime-preview-wrap #preview-image {
      max-height: calc(78vh - 190px);
      max-width: 100%;
    }
    .list-box {
      width: 100%;
      min-height: 250px;
      border: 1px solid #c7d4e2;
      border-radius: 9px;
      padding: 6px;
      background: #fff;
      font-family: var(--mono);
      font-size: 12px;
    }
    .log-view {
      min-height: 360px;
      max-height: 56vh;
      overflow: auto;
      border: 1px solid #0f172a;
      border-radius: 10px;
      padding: 10px;
      background: #030712;
      color: #55f18e;
      font-family: var(--mono);
      font-size: 12px;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .timeline-wrap {
      display: grid;
      gap: 10px;
      margin-top: 10px;
    }
    .trace-run-card {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      background: #fff;
      padding: 16px;
      display: grid;
      gap: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      cursor: pointer;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .trace-run-card:hover {
      border-color: #cbd5e1;
      box-shadow: 0 3px 10px rgba(15, 23, 42, 0.06);
    }
    .trace-run-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .trace-run-head-left {
      flex: 1;
      min-width: 0;
    }
    .trace-task {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      line-height: 1.4;
      color: #1a2332;
    }
    .trace-kv-line {
      color: #64748b;
      font-size: 12px;
      line-height: 1.6;
      margin-top: 2px;
    }
    .trace-timing-row {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
      margin-top: 2px;
    }
    .trace-timing-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      border-radius: 4px;
      padding: 1px 7px;
      font-size: 11px;
      line-height: 1.6;
    }
    .trace-timing-chip.steps {
      background: #f1f5f9;
      color: #475569;
    }
    .trace-timing-chip.exec {
      background: #f0fdf4;
      color: #166534;
    }
    .trace-timing-chip.model {
      background: #eff6ff;
      color: #1e40af;
    }
    .trace-timing-chip.screenshot {
      background: #fffbeb;
      color: #92400e;
    }
    .trace-timing-chip.delay {
      background: #f1f5f9;
      color: #64748b;
    }
    .trace-timing-chip.overhead {
      background: #fef3c7;
      color: #92400e;
    }
    .trace-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 400;
      white-space: nowrap;
      letter-spacing: 0.01em;
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      color: #475569;
    }
    .trace-pill.ok,
    .trace-pill.success {
      border-color: #86efac;
      background: #f0fdf4;
      color: #166534;
    }
    .trace-pill.error,
    .trace-pill.failed {
      border-color: #fca5a5;
      background: #fef2f2;
      color: #991b1b;
    }
    .trace-pill.running {
      border-color: #c4b5fd;
      background: #f5f3ff;
      color: #5b21b6;
    }
    .trace-final {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.5;
      color: #334155;
      max-height: 3.6em;
      overflow: hidden;
      position: relative;
      cursor: pointer;
    }
    .trace-final.expanded {
      max-height: none;
    }
    .trace-final:not(.expanded)::after {
      content: "";
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 20px;
      background: linear-gradient(transparent, #f8fafc);
      pointer-events: none;
    }
    .trace-final-label {
      font-weight: 500;
      color: #475569;
      margin-right: 4px;
    }
    .trace-action-list-wrap {
      max-height: 232px;
      overflow-y: auto;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
    }
    .trace-action-list {
      display: table;
      width: 100%;
      border-collapse: collapse;
    }
    .trace-action-row {
      display: table-row;
      cursor: pointer;
      transition: background 0.1s;
      user-select: none;
      background: #fff;
    }
    .trace-action-row:nth-child(even) {
      background: #f8fafc;
    }
    .trace-action-row:hover {
      background: #eef4fb;
    }
    .trace-action-row:active {
      background: #e2ecf5;
    }
    .trace-action-row > * {
      display: table-cell;
      vertical-align: middle;
      height: 38px;
      padding: 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .trace-action-row:last-child > * {
      border-bottom: none;
    }
    .trace-action-name {
      font-size: 13px;
      font-weight: 400;
      color: #1e293b;
      white-space: nowrap;
      padding-left: 14px;
      padding-right: 14px;
    }
    .trace-action-dots {
      width: 120px;
      min-width: 120px;
      max-width: 120px;
      display: flex;
      align-items: center;
      gap: 3px;
      overflow: hidden;
    }
    .trace-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .trace-dot.ok {
      background: #22c55e;
    }
    .trace-dot.error {
      background: #ef4444;
    }
    .trace-action-count {
      white-space: nowrap;
      text-align: right;
      padding-right: 8px;
    }
    .trace-action-dur {
      white-space: nowrap;
      text-align: right;
      padding-right: 8px;
    }
    .trace-action-err {
      white-space: nowrap;
      text-align: center;
      padding-right: 8px;
    }
    .trace-action-arrow {
      color: #94a3b8;
      font-size: 16px;
      padding-right: 14px;
      white-space: nowrap;
    }
    .trace-filters {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .trace-status-group {
      display: flex;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .trace-status-btn {
      background: #fff;
      border: none;
      border-right: 1px solid #e2e8f0;
      padding: 5px 12px;
      font-size: 12px;
      color: #64748b;
      cursor: pointer;
      transition: background 0.1s, color 0.1s;
    }
    .trace-status-btn:last-child {
      border-right: none;
    }
    .trace-status-btn:hover {
      background: #f1f5f9;
    }
    .trace-status-btn.active {
      background: #1e293b;
      color: #fff;
    }
    .trace-search {
      flex: 0 0 180px;
      max-width: 180px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 12px;
      color: #1e293b;
      outline: none;
      box-sizing: border-box;
    }
    .trace-filter-meta {
      font-size: 12px;
      color: #94a3b8;
      margin-left: auto;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .trace-search:focus {
      border-color: #94a3b8;
    }
    .trace-pager {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 8px 0 2px;
    }
    .trace-pager-btn {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 600;
      color: #475569;
      cursor: pointer;
      transition: background 0.1s;
    }
    .trace-pager-btn:hover { background: #f1f5f9; }
    .trace-pager-btn:disabled {
      opacity: 0.4;
      cursor: default;
      background: #fff;
    }
    .trace-pager-info {
      font-size: 12px;
      color: #64748b;
    }
    .trace-panel-overlay {
      position: fixed;
      inset: 0;
      z-index: 9000;
      display: none;
    }
    .trace-panel-overlay.open {
      display: flex;
      justify-content: flex-end;
    }
    body.panel-open {
      overflow: hidden;
    }
    .trace-panel-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(15,23,42,0.35);
      animation: panelFadeIn 0.15s ease-out;
    }
    .trace-panel-sheet {
      position: relative;
      width: 520px;
      max-width: 90vw;
      height: 100%;
      background: #fff;
      box-shadow: -4px 0 24px rgba(0,0,0,0.12);
      display: flex;
      flex-direction: column;
      animation: panelSlideIn 0.2s ease-out;
    }
    @keyframes panelSlideIn {
      from { transform: translateX(100%); }
      to { transform: translateX(0); }
    }
    @keyframes panelFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .trace-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid #e2e8f0;
      flex-shrink: 0;
    }
    .trace-panel-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: #1e293b;
    }
    .trace-panel-close {
      background: none;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      width: 32px;
      height: 32px;
      font-size: 18px;
      cursor: pointer;
      color: #64748b;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.1s;
      flex-shrink: 0;
    }
    .trace-panel-close:hover {
      background: #f1f5f9;
      color: #1e293b;
    }
    .trace-panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .trace-step-card {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #fff;
      padding: 12px 14px;
      display: grid;
      gap: 8px;
    }
    .trace-step-card.ok {
      border-left: 3px solid #22c55e;
    }
    .trace-step-card.error {
      border-left: 3px solid #ef4444;
    }
    .trace-step-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .trace-step-head-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .trace-step-title {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: #1e293b;
    }
    .trace-step-meta {
      font-size: 11px;
      color: #94a3b8;
    }
    .trace-step-chips {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .trace-block {
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: #f8fafc;
      padding: 8px 10px;
      font-family: var(--mono);
      font-size: 11.5px;
      white-space: pre-wrap;
      line-height: 1.5;
      color: #334155;
      max-height: 200px;
      overflow-y: auto;
    }
    .trace-block-label {
      display: block;
      font-family: var(--sans);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #94a3b8;
      margin-bottom: 3px;
    }
    .trace-screenshot-wrap {
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: #f8fafc;
      padding: 8px;
      display: grid;
      gap: 6px;
    }
    .trace-screenshot-image {
      display: block;
      width: 100%;
      max-height: 280px;
      object-fit: contain;
      border-radius: 4px;
      background: #e2e8f0;
    }
    .trace-screenshot-path {
      font-family: var(--mono);
      font-size: 10px;
      color: #64748b;
      word-break: break-all;
    }
    .trace-batch-strip {
      display: grid;
      gap: 8px;
    }
    .trace-batch-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
    }
    .trace-batch-item {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #fff;
      padding: 6px;
      display: grid;
      gap: 5px;
    }
    .trace-batch-thumb {
      width: 100%;
      height: 120px;
      object-fit: contain;
      border-radius: 6px;
      background: #e2e8f0;
      display: block;
    }
    .trace-batch-caption {
      font-family: var(--mono);
      font-size: 10px;
      color: #475569;
      line-height: 1.4;
      word-break: break-word;
    }
    @media (max-width: 980px) {
      .grid.cols-2 {
        grid-template-columns: 1fr;
      }
      .split {
        grid-template-columns: 1fr;
      }
      .runtime-layout {
        grid-template-columns: 1fr;
      }
      .runtime-preview-card {
        min-height: auto;
      }
      .runtime-preview-wrap {
        min-height: 340px;
      }
      .runtime-preview-wrap #preview-image {
        max-height: 60vh;
      }
      .layout {
        padding: 12px;
      }
      .title h1 {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <header class="topbar">
      <div class="title">
        <h1>OpenPocket</h1>
        <p class="subtitle">Local agent phone control dashboard</p>
      </div>
      <div class="badge-row">
        <span class="badge" id="gateway-badge">Gateway: Unknown</span>
        <span class="badge" id="emulator-badge">Emulator: Unknown</span>
      </div>
    </header>

    <div class="tabs">
      <button class="tab-btn active" data-tab="runtime">Runtime</button>
      <button class="tab-btn" data-tab="onboarding">Onboarding</button>
      <button class="tab-btn" data-tab="permissions">Permissions</button>
      <button class="tab-btn" data-tab="prompts">Agent Prompts</button>
      <button class="tab-btn" data-tab="channels">Channels</button>
      <button class="tab-btn" data-tab="timeline">Action Timeline</button>
      <button class="tab-btn" data-tab="logs">Logs</button>
    </div>

    <div class="status-line" id="status-line"></div>

    <section class="tab-panel active" data-panel="runtime">
      <div class="runtime-layout">
        <div class="runtime-left">
          <div class="card">
            <h3>Gateway</h3>
            <p class="hint">Gateway is managed by CLI in integrated mode. Runtime status refreshes automatically.</p>
            <div class="row">
              <button class="btn" id="runtime-refresh-btn">Refresh Runtime</button>
            </div>
            <div class="kv" id="gateway-kv"></div>
          </div>

          <div class="card">
            <h3>Android Emulator</h3>
            <p class="hint">Control emulator lifecycle and visibility while tasks continue in background. Show can auto-switch from headless to windowed mode.</p>
            <div class="row">
              <button class="btn primary" data-emu-action="start">Start</button>
              <button class="btn warn" data-emu-action="stop">Stop</button>
              <button class="btn" data-emu-action="show">Show / Interact</button>
              <button class="btn" data-emu-action="hide">Hide</button>
              <button class="btn" id="emu-refresh-btn">Refresh Status</button>
            </div>
            <div class="kv" id="emulator-kv"></div>
          </div>

          <div class="card">
            <h3>Core Paths</h3>
            <div class="grid core-paths-grid">
              <div>
                <label for="workspace-input">Workspace</label>
                <input type="text" id="workspace-input" />
              </div>
              <div>
                <label for="state-input">State</label>
                <input type="text" id="state-input" />
              </div>
            </div>
            <div class="row" style="margin-top:10px;">
              <button class="btn primary" id="save-core-paths-btn">Save Config</button>
            </div>
          </div>
        </div>

        <div class="runtime-right">
          <div class="card runtime-preview-card">
            <h3>Emulator Screen Preview</h3>
            <div class="row">
              <button class="btn" id="preview-refresh-btn">Refresh Preview</button>
              <label class="row">
                <input type="checkbox" id="preview-auto" />
                <span>Auto refresh (2s)</span>
              </label>
              <span class="kv" id="preview-meta"></span>
            </div>
            <div class="row">
              <input type="text" id="emulator-text-input" placeholder="Type text to active input field" />
              <button class="btn" id="emulator-text-send">Send Text</button>
            </div>
            <div class="preview-wrap runtime-preview-wrap">
              <img id="preview-image" alt="Emulator preview" />
              <div class="preview-empty" id="preview-empty">Preview unavailable. Start emulator and click Refresh Preview.</div>
            </div>
            <div class="hint">Click on preview image to send tap. Coordinates are mapped to device pixels.</div>
          </div>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="timeline">
      <div class="card">
        <div class="row spread">
          <h3 style="margin:0;">Action Timeline</h3>
          <div class="row">
            <button class="btn" id="timeline-refresh-btn">Refresh</button>
            <label class="row">
              <input type="checkbox" id="timeline-auto" />
              <span>Auto refresh (3s)</span>
            </label>
          </div>
        </div>
        <div class="trace-filters">
          <div class="trace-status-group">
            <button class="trace-status-btn active" data-status="all">All</button>
            <button class="trace-status-btn" data-status="success">Success</button>
            <button class="trace-status-btn" data-status="failed">Failed</button>
            <button class="trace-status-btn" data-status="running">Running</button>
          </div>
          <input type="text" class="trace-search" id="trace-search" placeholder="Search tasks..." />
          <span class="trace-filter-meta" id="timeline-meta"></span>
        </div>
        <div class="timeline-wrap" id="timeline-runs">
          <div class="placeholder">No trace runs yet.</div>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="onboarding">
      <div class="grid cols-2">
        <div class="card">
          <h3>User Consent</h3>
          <p class="hint">Emulator artifacts are stored locally. Cloud model providers may receive task text/screenshots.</p>
          <label class="row">
            <input type="checkbox" id="onboard-consent" />
            <span>I accept local automation and data handling terms.</span>
          </label>
        </div>
        <div class="card">
          <h3>Play Store Login</h3>
          <p class="hint">Manually complete Gmail sign-in in emulator when needed.</p>
          <label class="row">
            <input type="checkbox" id="onboard-gmail-done" />
            <span>I finished Gmail sign-in and verified Play Store access.</span>
          </label>
          <div class="row" style="margin-top:10px;">
            <button class="btn" id="onboard-start-emu">Start Emulator</button>
            <button class="btn" id="onboard-show-emu">Show Emulator</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Model Selection</h3>
        <div class="row">
          <div style="min-width:320px;flex:1;">
            <label for="onboard-model-select">Default Model</label>
            <select id="onboard-model-select"></select>
          </div>
        </div>
        <div class="kv" id="onboard-model-meta"></div>
      </div>

      <div class="card">
        <h3>API Key Setup</h3>
        <label class="row">
          <input type="checkbox" id="onboard-use-env" checked />
          <span>Use environment variable for API key</span>
        </label>
        <div style="margin-top:10px;" id="onboard-api-key-wrap">
          <input type="password" id="onboard-api-key" placeholder="Paste API key when not using env variable" />
        </div>
      </div>

      <div class="card" id="onboard-profile-status"></div>

      <div class="card" id="onboard-profile-fields">
        <h3>Profile Setup</h3>
        <p class="hint">These fields are required before the gateway will accept tasks.</p>
        <div style="margin-bottom:8px;">
          <label for="onboard-assistant-name">Assistant name</label>
          <input type="text" id="onboard-assistant-name" placeholder="e.g. Pocket, Jarvis, Friday" value="Pocket" />
        </div>
        <div style="margin-bottom:8px;">
          <label for="onboard-assistant-persona">Assistant persona</label>
          <input type="text" id="onboard-assistant-persona" placeholder="e.g. Helpful and concise assistant" value="Helpful and concise phone assistant" />
        </div>
        <div style="margin-bottom:8px;">
          <label for="onboard-user-address">What should the assistant call you?</label>
          <input type="text" id="onboard-user-address" placeholder="e.g. Boss, your first name" value="Boss" />
        </div>
      </div>

      <div class="card">
        <div class="row spread">
          <h3 style="margin:0;">Save Onboarding</h3>
          <button class="btn primary" id="onboard-save-btn" disabled>Save Onboarding to Config + State</button>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="permissions">
      <div class="grid cols-2">
        <div class="card">
          <h3>File Access Permissions</h3>
          <p class="hint">Control local file scope exposed in dashboard.</p>
          <label class="row">
            <input type="checkbox" id="perm-allow-view" />
            <span>Allow local storage file view in dashboard</span>
          </label>
          <div style="margin-top:10px;">
            <label for="perm-storage-root">Storage root</label>
            <input type="text" id="perm-storage-root" placeholder="/path/to/workspace" />
          </div>
          <div style="margin-top:10px;">
            <label for="perm-subpaths">Allowed subpaths (one per line)</label>
            <textarea id="perm-subpaths"></textarea>
          </div>
          <div style="margin-top:10px;">
            <label for="perm-exts">Allowed extensions (one per line, without dot)</label>
            <textarea id="perm-exts"></textarea>
          </div>
          <div class="row" style="margin-top:10px;">
            <button class="btn primary" id="perm-save-btn">Apply Scope</button>
            <button class="btn" id="perm-refresh-files-btn">Refresh Files</button>
          </div>
        </div>

        <div class="card">
          <h3>Scoped File Viewer</h3>
          <div class="split">
            <div>
              <div class="row spread">
                <span class="hint" id="perm-file-count">0 files</span>
              </div>
              <select id="perm-file-list" class="list-box" size="14"></select>
            </div>
            <div>
              <textarea id="perm-file-content" style="min-height:320px;" readonly placeholder="File content"></textarea>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="prompts">
      <div class="card">
        <h3>Prompt Files</h3>
        <div class="split">
          <div>
            <div style="margin-bottom:8px;">
              <label for="prompt-add-title">Title</label>
              <input type="text" id="prompt-add-title" placeholder="AGENTS" />
            </div>
            <div style="margin-bottom:8px;">
              <label for="prompt-add-path">Path</label>
              <input type="text" id="prompt-add-path" placeholder="/path/to/AGENTS.md" />
            </div>
            <div class="row" style="margin-bottom:8px;">
              <button class="btn" id="prompt-add-btn">Add Prompt File</button>
              <button class="btn warn" id="prompt-remove-btn">Remove</button>
            </div>
            <select id="prompt-list" class="list-box" size="12"></select>
          </div>
          <div>
            <div class="row spread">
              <span class="hint" id="prompt-selected-meta">No prompt selected</span>
              <div class="row">
                <button class="btn" id="prompt-reload-btn">Reload</button>
                <button class="btn primary" id="prompt-save-btn">Save</button>
              </div>
            </div>
            <textarea id="prompt-editor" style="min-height:340px;" placeholder="Prompt file content"></textarea>
          </div>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="channels">
      <div class="card">
        <div class="row spread">
          <h3 style="margin:0;">Channel Management</h3>
          <button class="btn" id="channels-refresh-btn">Refresh</button>
        </div>
        <p class="hint">Manage messaging channel connections, access policies, and sender approvals.</p>
      </div>
      <div id="channels-container"></div>
    </section>

    <section class="tab-panel" data-panel="logs">
      <div class="card">
        <h3>Dashboard Logs</h3>
        <div class="row">
          <button class="btn" id="logs-refresh-btn">Refresh</button>
          <button class="btn warn" id="logs-clear-btn">Clear</button>
          <label class="row">
            <input type="checkbox" id="logs-auto" />
            <span>Auto refresh (2s)</span>
          </label>
          <span class="hint" id="logs-meta"></span>
        </div>
        <div class="log-view" id="logs-view"></div>
      </div>
    </section>
  </div>
  <div class="trace-panel-overlay" id="trace-panel-overlay">
    <div class="trace-panel-backdrop" id="trace-panel-backdrop"></div>
    <div class="trace-panel-sheet" id="trace-panel-sheet">
      <div class="trace-panel-head">
        <h4 class="trace-panel-title" id="trace-panel-title"></h4>
        <button class="trace-panel-close" id="trace-panel-close">&times;</button>
      </div>
      <div class="trace-panel-body" id="trace-panel-body"></div>
    </div>
  </div>
  <script>
    const state = {
      runtime: null,
      config: null,
      onboarding: null,
      controlSettings: null,
      promptFiles: [],
      selectedPromptId: "",
      preview: null,
      previewTimer: null,
      runtimeTimer: null,
      logsTimer: null,
      timelineTimer: null,
      tracePanelTimer: null,
      emulatorActionPending: false,
      credentialStatus: {},
      traceRuns: [],
      traceSkippedFiles: 0,
      traceTruncatedFiles: 0,
      tracePage: 0,
      tracePageSize: 5,
      traceStatusFilter: "all",
      traceSearchFilter: "",
      expandedResults: new Set(),
      channelsData: null,
      openTraceRunSessionId: "",
      openTraceStepNo: null,
    };

    const $ = (selector) => document.querySelector(selector);

    function setStatus(text, tone = "normal") {
      const el = $("#status-line");
      el.textContent = text || "";
      if (tone === "error") {
        el.style.color = "#a92929";
      } else if (tone === "ok") {
        el.style.color = "#0f7c5a";
      } else {
        el.style.color = "";
      }
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || response.statusText || "Request failed");
      }
      return payload;
    }

    function activateTab(tab) {
      document.querySelectorAll(".tab-btn").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tab);
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === tab);
      });
    }

    function updateBadges(runtime) {
      const gatewayBadge = $("#gateway-badge");
      const emulatorBadge = $("#emulator-badge");
      const gatewayRunning = Boolean(runtime?.gateway?.running);
      const emulatorRunning = (runtime?.emulator?.bootedDevices || []).length > 0;

      gatewayBadge.textContent = "Gateway: " + (gatewayRunning ? "Running" : "Stopped/Unknown");
      gatewayBadge.classList.toggle("ok", gatewayRunning);

      const targetLabel = runtime?.emulator?.targetType || "emulator";
      emulatorBadge.textContent = "Device (" + targetLabel + "): " + (runtime?.emulator?.statusText || "Unknown");
      emulatorBadge.classList.toggle("ok", emulatorRunning);
    }

    function renderRuntime(runtime) {
      updateBadges(runtime);
      $("#gateway-kv").innerHTML =
        "<div>Mode: <code>" + (runtime.mode || "unknown") + "</code></div>" +
        "<div>Gateway note: " + (runtime.gateway?.note || "n/a") + "</div>" +
        "<div>Dashboard: <code>" + (runtime.dashboard?.address || location.origin) + "</code></div>";

      $("#emulator-kv").innerHTML =
        "<div>Target: <code>" + (runtime.emulator?.targetType || "emulator") + "</code></div>" +
        "<div>AVD: <code>" + (runtime.emulator?.avdName || "unknown") + "</code></div>" +
        "<div>Devices: " + ((runtime.emulator?.devices || []).join(", ") || "(none)") + "</div>" +
        "<div>Booted: " + ((runtime.emulator?.bootedDevices || []).join(", ") || "(none)") + "</div>";

      if (!$("#workspace-input").value) {
        $("#workspace-input").value = runtime.config?.workspaceDir || "";
      }
      if (!$("#state-input").value) {
        $("#state-input").value = runtime.config?.stateDir || "";
      }
    }

    async function loadRuntime() {
      const payload = await api("/api/runtime");
      state.runtime = payload;
      renderRuntime(payload);
      return payload;
    }

    async function loadConfigAndOnboarding() {
      const [configPayload, onboardingPayload] = await Promise.all([
        api("/api/config"),
        api("/api/onboarding"),
      ]);
      state.config = configPayload.config;
      state.credentialStatus = configPayload.credentialStatus || {};
      state.onboarding = onboardingPayload.onboarding || {};
      state.profileReadiness = onboardingPayload.profileReadiness || null;
      state.profileValues = onboardingPayload.profileValues || {};
      renderOnboarding();
    }

    function snapshotOnboardingForm() {
      return JSON.stringify({
        model: $("#onboard-model-select").value,
        consent: $("#onboard-consent").checked,
        gmail: $("#onboard-gmail-done").checked,
        useEnv: $("#onboard-use-env").checked,
        apiKey: $("#onboard-api-key").value,
        name: $("#onboard-assistant-name").value,
        persona: $("#onboard-assistant-persona").value,
        address: $("#onboard-user-address").value,
      });
    }

    function updateSaveButtonState() {
      var dirty = !state.onboardSnapshot || snapshotOnboardingForm() !== state.onboardSnapshot;
      $("#onboard-save-btn").disabled = !dirty;
    }

    function renderOnboarding() {
      const config = state.config;
      const onboarding = state.onboarding || {};
      if (!config) {
        return;
      }

      const select = $("#onboard-model-select");
      const current = onboarding.modelProfile || config.defaultModel;
      select.innerHTML = "";
      const providerLabelFromBaseUrl = (baseUrl) => {
        const text = String(baseUrl || "").toLowerCase();
        if (text.includes("api.openai.com")) {
          return "OpenAI";
        }
        if (text.includes("openrouter.ai")) {
          return "OpenRouter";
        }
        if (text.includes("api.z.ai")) {
          return "AutoGLM";
        }
        try {
          return new URL(baseUrl).host || "custom";
        } catch {
          return "custom";
        }
      };
      Object.keys(config.models || {}).sort().forEach((key) => {
        const profile = config.models[key];
        const option = document.createElement("option");
        option.value = key;
        option.textContent = key + " (" + providerLabelFromBaseUrl(profile.baseUrl) + ")";
        if (key === current) {
          option.selected = true;
        }
        select.appendChild(option);
      });

      $("#onboard-consent").checked = Boolean(onboarding.consentAcceptedAt);
      $("#onboard-gmail-done").checked = Boolean(onboarding.gmailLoginConfirmedAt);
      $("#onboard-use-env").checked = (onboarding.apiKeySource || "env") !== "config";
      $("#onboard-api-key-wrap").style.display = $("#onboard-use-env").checked ? "none" : "block";

      const selected = select.value || config.defaultModel;
      const profile = config.models[selected];
      const provider = profile?.baseUrl ? profile.baseUrl : "unknown";
      const envName = profile?.apiKeyEnv || "N/A";
      const modelId = profile?.model || "unknown";
      const status = state.credentialStatus[selected] || "";

      $("#onboard-model-meta").innerHTML =
        "<div>Model ID: <code>" + modelId + "</code></div>" +
        "<div>Provider: <code>" + provider + "</code></div>" +
        "<div>Provider API env: <code>" + envName + "</code></div>" +
        "<div>" + status + "</div>";

      const pr = state.profileReadiness;
      const statusEl = $("#onboard-profile-status");
      if (pr && !pr.ready) {
        statusEl.style.display = "";
        statusEl.innerHTML =
          "<h3 style='color:#e65100;margin-top:0;'>Profile Incomplete</h3>" +
          "<p>The gateway will not run tasks until these are resolved. Fill in the fields below and save.</p>" +
          "<ul>" + pr.missing.map(function(m) { return "<li>" + m + "</li>"; }).join("") + "</ul>";
      } else {
        statusEl.style.display = "none";
        statusEl.innerHTML = "";
      }

      var pv = state.profileValues || {};
      if (!$("#onboard-assistant-name").value) $("#onboard-assistant-name").value = pv.assistantName || "";
      if (!$("#onboard-assistant-persona").value) $("#onboard-assistant-persona").value = pv.assistantPersona || "";
      if (!$("#onboard-user-address").value) $("#onboard-user-address").value = pv.userAddress || "";

      state.onboardSnapshot = snapshotOnboardingForm();
      updateSaveButtonState();
    }

    async function loadControlSettings() {
      const payload = await api("/api/control-settings");
      state.controlSettings = payload.controlSettings || null;
      state.promptFiles = state.controlSettings?.promptFiles || [];
      renderPermissions();
      renderPromptList();
    }

    function renderPermissions() {
      const control = state.controlSettings;
      if (!control) {
        return;
      }
      const permission = control.permission || {};
      $("#perm-allow-view").checked = Boolean(permission.allowLocalStorageView);
      $("#perm-storage-root").value = permission.storageDirectoryPath || (state.config?.workspaceDir || "");
      $("#perm-subpaths").value = (permission.allowedSubpaths || []).join("\\n");
      $("#perm-exts").value = (permission.allowedExtensions || []).join("\\n");
    }

    async function savePermissions() {
      const permission = {
        allowLocalStorageView: $("#perm-allow-view").checked,
        storageDirectoryPath: $("#perm-storage-root").value.trim(),
        allowedSubpaths: $("#perm-subpaths").value
          .split("\\n")
          .map((line) => line.trim())
          .filter(Boolean),
        allowedExtensions: $("#perm-exts").value
          .split("\\n")
          .map((line) => line.trim().toLowerCase())
          .filter(Boolean),
      };
      await api("/api/control-settings", {
        method: "POST",
        body: JSON.stringify({ permission }),
      });
      await loadControlSettings();
      setStatus("Permission scope saved.", "ok");
    }

    async function loadScopedFiles() {
      const payload = await api("/api/permissions/files");
      const files = payload.files || [];
      const list = $("#perm-file-list");
      list.innerHTML = "";
      files.forEach((item) => {
        const option = document.createElement("option");
        option.value = item;
        option.textContent = item;
        list.appendChild(option);
      });
      $("#perm-file-count").textContent = files.length + " files";
      if (files.length === 0) {
        $("#perm-file-content").value = "";
      }
    }

    async function readScopedFile() {
      const selected = $("#perm-file-list").value;
      if (!selected) {
        $("#perm-file-content").value = "";
        return;
      }
      const payload = await api("/api/permissions/read-file", {
        method: "POST",
        body: JSON.stringify({ path: selected }),
      });
      $("#perm-file-content").value = payload.content || "";
    }

    function renderPromptList() {
      const list = $("#prompt-list");
      list.innerHTML = "";
      if (!(state.promptFiles || []).some((item) => item.id === state.selectedPromptId)) {
        state.selectedPromptId = "";
      }
      (state.promptFiles || []).forEach((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.title + " | " + item.path;
        if (item.id === state.selectedPromptId) {
          option.selected = true;
        }
        list.appendChild(option);
      });
      if (!state.selectedPromptId && state.promptFiles.length > 0) {
        state.selectedPromptId = state.promptFiles[0].id;
      }
      list.value = state.selectedPromptId || "";
      updatePromptMeta();
    }

    function updatePromptMeta() {
      const current = (state.promptFiles || []).find((item) => item.id === state.selectedPromptId);
      if (!current) {
        $("#prompt-selected-meta").textContent = "No prompt selected";
        return;
      }
      $("#prompt-selected-meta").textContent = current.title + " | " + current.path;
    }

    async function readPromptContent() {
      const id = state.selectedPromptId;
      if (!id) {
        $("#prompt-editor").value = "";
        updatePromptMeta();
        return;
      }
      const payload = await api("/api/prompts/read", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      $("#prompt-editor").value = payload.content || "";
      updatePromptMeta();
    }

    async function addPrompt() {
      const title = $("#prompt-add-title").value.trim();
      const promptPath = $("#prompt-add-path").value.trim();
      if (!promptPath) {
        setStatus("Prompt path is required.", "error");
        return;
      }
      const payload = await api("/api/prompts/add", {
        method: "POST",
        body: JSON.stringify({ title, path: promptPath }),
      });
      state.promptFiles = payload.promptFiles || [];
      state.selectedPromptId = state.promptFiles.length > 0 ? state.promptFiles[state.promptFiles.length - 1].id : "";
      renderPromptList();
      await readPromptContent();
      $("#prompt-add-title").value = "";
      $("#prompt-add-path").value = "";
      setStatus("Prompt file added.", "ok");
    }

    async function removePrompt() {
      const id = state.selectedPromptId;
      if (!id) {
        return;
      }
      const payload = await api("/api/prompts/remove", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      state.promptFiles = payload.promptFiles || [];
      state.selectedPromptId = state.promptFiles.length > 0 ? state.promptFiles[0].id : "";
      renderPromptList();
      await readPromptContent();
      setStatus("Prompt removed.", "ok");
    }

    async function savePrompt() {
      const id = state.selectedPromptId;
      if (!id) {
        setStatus("Select a prompt first.", "error");
        return;
      }
      const content = $("#prompt-editor").value;
      await api("/api/prompts/save", {
        method: "POST",
        body: JSON.stringify({ id, content }),
      });
      setStatus("Prompt file saved.", "ok");
    }

    async function loadLogs() {
      const payload = await api("/api/logs?limit=1000");
      const lines = payload.lines || [];
      $("#logs-view").textContent = lines.join("\\n");
      $("#logs-meta").textContent = lines.length + " lines";
    }

    function formatDuration(durationMs) {
      const ms = Number(durationMs);
      if (!Number.isFinite(ms) || ms < 0) {
        return "n/a";
      }
      if (ms === 0) {
        return "<1ms";
      }
      if (ms < 1000) {
        return Math.round(ms) + "ms";
      }
      const totalSeconds = ms / 1000;
      if (totalSeconds < 60) {
        return totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0) + "s";
      }
      const mins = Math.floor(totalSeconds / 60);
      const secs = Math.round(totalSeconds - (mins * 60));
      return mins + "m " + secs + "s";
    }

    function formatTime(value) {
      const parsed = Date.parse(String(value || ""));
      if (!Number.isFinite(parsed)) {
        return "n/a";
      }
      return new Date(parsed).toLocaleString();
    }

    function makeStatusPill(status) {
      const pill = document.createElement("span");
      const normalized = String(status || "unknown").toLowerCase();
      pill.className = "trace-pill " + normalized;
      pill.textContent = normalized;
      return pill;
    }

    function traceScreenshotUrl(filePath) {
      return "/api/trace-screenshot?path=" + encodeURIComponent(String(filePath || ""));
    }

    function traceRunPageUrl(sessionId, stepNo) {
      const params = new URLSearchParams();
      params.set("session", String(sessionId || ""));
      if (stepNo != null && Number.isFinite(Number(stepNo))) {
        params.set("step", String(Math.round(Number(stepNo))));
      }
      return "/trace?" + params.toString();
    }

    function buildTracePanelTitle(run) {
      const actions = Array.isArray(run?.actions) ? run.actions : [];
      const totalStepDur = actions.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
      return (run?.task || "Steps").slice(0, 60) +
        " \\u2014 " +
        actions.length + " steps" +
        " \\u2014 " +
        formatDuration(totalStepDur);
    }

    function openTraceRun(run, scrollToStep) {
      if (!run) return;
      const url = traceRunPageUrl(run.sessionId, scrollToStep);
      window.open(url, "_blank", "noopener");
    }

    function syncOpenTracePanel() {
      if (!state.openTraceRunSessionId) {
        return;
      }
      const overlay = $("#trace-panel-overlay");
      if (!overlay.classList.contains("open")) {
        state.openTraceRunSessionId = "";
        state.openTraceStepNo = null;
        return;
      }
      const run = Array.isArray(state.traceRuns)
        ? state.traceRuns.find((item) => String(item.sessionId || "") === state.openTraceRunSessionId)
        : null;
      if (!run) {
        closeTracePanel();
        return;
      }
      openTracePanel(
        buildTracePanelTitle(run),
        Array.isArray(run.actions) ? run.actions : [],
        null,
      );
    }

    function openTracePanel(title, steps, scrollToStep) {
      const overlay = $("#trace-panel-overlay");
      $("#trace-panel-title").textContent = title;
      const body = $("#trace-panel-body");
      body.textContent = "";
      let scrollTarget = null;

      for (const step of steps) {
        const card = document.createElement("section");
        card.className = "trace-step-card " + String(step.status || "ok");
        if (scrollToStep != null && Number(step.stepNo) === scrollToStep) {
          scrollTarget = card;
        }

        const head = document.createElement("div");
        head.className = "trace-step-head";
        const headLeft = document.createElement("div");
        headLeft.className = "trace-step-head-left";
        const title = document.createElement("span");
        title.className = "trace-step-title";
        title.textContent =
          "Step " + String(step.stepNo || "?") +
          " \\u00B7 " + String(step.actionType || "unknown");
        headLeft.appendChild(title);
        const app = document.createElement("span");
        app.className = "trace-step-meta";
        app.textContent = String(step.currentApp || "");
        headLeft.appendChild(app);
        head.appendChild(headLeft);

        const totalStepMs = Number(step.durationMs || 0)
          + Number(step.screenshotMs || 0)
          + Number(step.modelInferenceMs || 0);
        const hasBreakdown = Number(step.screenshotMs || 0) > 0 || Number(step.modelInferenceMs || 0) > 0;

        const chips = document.createElement("div");
        chips.className = "trace-step-chips";
        chips.appendChild(makeStatusPill(step.status || "ok"));
        const dur = document.createElement("span");
        dur.className = "trace-pill";
        dur.textContent = hasBreakdown
          ? formatDuration(totalStepMs)
          : formatDuration(step.durationMs);
        chips.appendChild(dur);
        head.appendChild(chips);
        card.appendChild(head);

        const meta = document.createElement("div");
        meta.className = "trace-step-meta";
        const metaParts = [];
        if (hasBreakdown) {
          metaParts.push(
            "exec " + formatDuration(step.durationMs) +
            " · model " + formatDuration(step.modelInferenceMs) +
            " · screenshot " + formatDuration(step.screenshotMs) +
            " · delay " + formatDuration(step.loopDelayMs)
          );
        }
        metaParts.push(
          formatTime(step.startedAt) +
          (step.endedAt ? " \\u2192 " + formatTime(step.endedAt) : "")
        );
        meta.textContent = metaParts.join("  |  ");
        card.appendChild(meta);

        if (step.reasoning && step.reasoning !== "(empty)") {
          const block = document.createElement("div");
          block.className = "trace-block";
          const label = document.createElement("span");
          label.className = "trace-block-label";
          label.textContent = "Thought Process";
          block.appendChild(label);
          block.appendChild(document.createTextNode(String(step.reasoning)));
          card.appendChild(block);
        }

        if (step.decisionJson && step.decisionJson !== "(empty)") {
          const block = document.createElement("div");
          block.className = "trace-block";
          const label = document.createElement("span");
          label.className = "trace-block-label";
          label.textContent = "Decision";
          block.appendChild(label);
          block.appendChild(document.createTextNode(String(step.decisionJson)));
          card.appendChild(block);
        }

        function addPanelShot(labelText, filePath) {
          if (!filePath) return;
          const wrap = document.createElement("div");
          wrap.className = "trace-screenshot-wrap";
          const label = document.createElement("span");
          label.className = "trace-block-label";
          label.textContent = labelText;
          wrap.appendChild(label);
          const image = document.createElement("img");
          image.className = "trace-screenshot-image";
          image.loading = "lazy";
          image.alt = labelText;
          image.src = traceScreenshotUrl(filePath);
          wrap.appendChild(image);
          const pathMeta = document.createElement("div");
          pathMeta.className = "trace-screenshot-path";
          pathMeta.textContent = String(filePath);
          wrap.appendChild(pathMeta);
          card.appendChild(wrap);
        }
        if (Array.isArray(step.recentScreenshotPaths)) {
          for (let ri = 0; ri < step.recentScreenshotPaths.length; ri++) {
            addPanelShot("Recent Frame " + (ri + 1), step.recentScreenshotPaths[ri]);
          }
        }
        addPanelShot("Input Screenshot", step.inputScreenshotPath);
        addPanelShot("SoM Overlay", step.somScreenshotPath);
        addPanelShot("Click Overlay", step.debugScreenshotPath);

        if (Array.isArray(step.batchDebugItems) && step.batchDebugItems.length > 0) {
          const wrap = document.createElement("div");
          wrap.className = "trace-batch-strip";
          const label = document.createElement("span");
          label.className = "trace-block-label";
          label.textContent = "Batch Action Locations";
          wrap.appendChild(label);
          const grid = document.createElement("div");
          grid.className = "trace-batch-grid";
          for (const item of step.batchDebugItems) {
            const box = document.createElement("div");
            box.className = "trace-batch-item";
            const img = document.createElement("img");
            img.className = "trace-batch-thumb";
            img.loading = "lazy";
            img.alt = "Batch action " + String(item.index || "");
            img.src = traceScreenshotUrl(item.imagePath);
            box.appendChild(img);
            const caption = document.createElement("div");
            caption.className = "trace-batch-caption";
            caption.textContent =
              "#" + String(item.index || "?") +
              " " + String(item.actionType || "unknown") +
              (item.summary ? " · " + String(item.summary) : "");
            box.appendChild(caption);
            grid.appendChild(box);
          }
          wrap.appendChild(grid);
          card.appendChild(wrap);
        }

        if (step.result && step.result !== "(empty)") {
          const block = document.createElement("div");
          block.className = "trace-block";
          const label = document.createElement("span");
          label.className = "trace-block-label";
          label.textContent = "Outcome";
          block.appendChild(label);
          block.appendChild(document.createTextNode(String(step.result)));
          card.appendChild(block);
        }

        body.appendChild(card);
      }

      overlay.classList.add("open");
      document.body.classList.add("panel-open");
      if (scrollTarget) {
        requestAnimationFrame(() => scrollTarget.scrollIntoView({ behavior: "smooth", block: "center" }));
      }
    }

    function closeTracePanel() {
      state.openTraceRunSessionId = "";
      state.openTraceStepNo = null;
      if (state.tracePanelTimer) {
        clearInterval(state.tracePanelTimer);
        state.tracePanelTimer = null;
      }
      $("#trace-panel-overlay").classList.remove("open");
      document.body.classList.remove("panel-open");
    }

    function bindTracePanelEvents() {
      const backdrop = $("#trace-panel-backdrop");
      const closeBtn = $("#trace-panel-close");
      if (backdrop) backdrop.addEventListener("click", closeTracePanel);
      if (closeBtn) closeBtn.addEventListener("click", closeTracePanel);
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeTracePanel();
      });
    }

    function renderTraces(runs) {
      const host = $("#timeline-runs");
      host.textContent = "";
      if (!Array.isArray(runs) || runs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "placeholder";
        empty.textContent = "No trace runs yet.";
        host.appendChild(empty);
        $("#timeline-meta").textContent = "0 runs";
        return;
      }

      const statusFilter = state.traceStatusFilter;
      const searchFilter = state.traceSearchFilter.toLowerCase();
      const filtered = runs.filter((r) => {
        if (statusFilter !== "all" && r.status !== statusFilter) return false;
        if (searchFilter && !(r.task || "").toLowerCase().includes(searchFilter)) return false;
        return true;
      });

      const total = filtered.length;
      const pageSize = state.tracePageSize;
      const totalPages = Math.ceil(total / pageSize);
      if (state.tracePage >= totalPages) state.tracePage = Math.max(0, totalPages - 1);
      const page = state.tracePage;
      const start = page * pageSize;
      const pageRuns = filtered.slice(start, start + pageSize);

      if (total === 0) {
        const empty = document.createElement("div");
        empty.className = "placeholder";
        empty.textContent = runs.length > 0
          ? "No runs match the current filters."
          : "No trace runs yet.";
        host.appendChild(empty);
        const label = runs.length > 0 ? "0 of " + runs.length + " runs" : "0 runs";
        $("#timeline-meta").textContent = label;
        return;
      }

      for (const run of pageRuns) {
        const card = document.createElement("article");
        card.className = "trace-run-card";
        card.addEventListener("click", () => {
          openTraceRun(run, null);
        });

        const head = document.createElement("div");
        head.className = "trace-run-head";

        const left = document.createElement("div");
        left.className = "trace-run-head-left";
        const task = document.createElement("h4");
        task.className = "trace-task";
        task.textContent = run.task || "(no task text)";
        left.appendChild(task);

        const runMeta = document.createElement("div");
        runMeta.className = "trace-kv-line";
        runMeta.textContent =
          "Session: " + (run.sessionId || "unknown") +
          " | Model: " + (run.modelProfile || "unknown") +
          " (" + (run.modelName || "unknown") + ")" +
          " | Duration: " + formatDuration(run.durationMs);
        left.appendChild(runMeta);

        const runTimes = document.createElement("div");
        runTimes.className = "trace-kv-line";
        runTimes.textContent =
          "Started: " + formatTime(run.startedAt) +
          (run.endedAt ? " | Ended: " + formatTime(run.endedAt) : " | Ended: running");
        left.appendChild(runTimes);

        const right = document.createElement("div");
        right.appendChild(makeStatusPill(run.status));

        head.appendChild(left);
        head.appendChild(right);
        card.appendChild(head);

        if (run.finalMessage) {
          const resultKey = run.sessionId;
          const finalBlock = document.createElement("div");
          finalBlock.className = "trace-final";
          if (state.expandedResults.has(resultKey)) {
            finalBlock.classList.add("expanded");
          }
          finalBlock.addEventListener("click", (e) => {
            e.stopPropagation();
            const isExpanded = finalBlock.classList.toggle("expanded");
            if (isExpanded) {
              state.expandedResults.add(resultKey);
            } else {
              state.expandedResults.delete(resultKey);
            }
          });
          const finalLabel = document.createElement("span");
          finalLabel.className = "trace-final-label";
          finalLabel.textContent = "Result:";
          finalBlock.appendChild(finalLabel);
          finalBlock.appendChild(document.createTextNode(" " + run.finalMessage));
          card.appendChild(finalBlock);
        }

        const actions = Array.isArray(run.actions) ? run.actions : [];
        if (actions.length === 0) {
          const empty = document.createElement("div");
          empty.className = "placeholder";
          empty.textContent = "No completed actions recorded.";
          card.appendChild(empty);
        } else {
          const groupsByAction = new Map();
          for (const action of actions) {
            const actionType = String(action.actionType || "unknown");
            if (!groupsByAction.has(actionType)) {
              groupsByAction.set(actionType, {
                actionType,
                steps: [],
                totalDurationMs: 0,
                errorCount: 0,
                firstStepNo: Number(action.stepNo || 0),
              });
            }
            const group = groupsByAction.get(actionType);
            group.steps.push(action);
            group.totalDurationMs += Number(action.durationMs || 0);
            if (String(action.status || "ok") === "error") {
              group.errorCount += 1;
            }
            group.firstStepNo = Math.min(group.firstStepNo, Number(action.stepNo || 0));
          }

          const actionGroups = Array.from(groupsByAction.values())
            .map((g) => ({
              ...g,
              steps: g.steps.sort((a, b) => Number(a.stepNo || 0) - Number(b.stepNo || 0)),
            }))
            .sort((a, b) => a.firstStepNo - b.firstStepNo);

          const allStepsSorted = actions.slice().sort((a, b) => Number(a.stepNo || 0) - Number(b.stepNo || 0));
          const totalStepDur = allStepsSorted.reduce((s, a) => s + Number(a.durationMs || 0), 0);
          const totalScreenshotMs = allStepsSorted.reduce((s, a) => s + Number(a.screenshotMs || 0), 0);
          const totalModelMs = allStepsSorted.reduce((s, a) => s + Number(a.modelInferenceMs || 0), 0);
          const totalLoopDelayMs = allStepsSorted.reduce((s, a) => s + Number(a.loopDelayMs || 0), 0);
          const hasTimingData = totalScreenshotMs > 0 || totalModelMs > 0;

          const stepsLabel = document.createElement("div");
          stepsLabel.className = "trace-timing-row";
          function addChip(cls, text) {
            const chip = document.createElement("span");
            chip.className = "trace-timing-chip " + cls;
            chip.textContent = text;
            stepsLabel.appendChild(chip);
          }
          addChip("steps", allStepsSorted.length + " steps");
          addChip("exec", "exec " + formatDuration(totalStepDur));
          if (hasTimingData) {
            addChip("model", "model " + formatDuration(totalModelMs));
            addChip("screenshot", "screenshot " + formatDuration(totalScreenshotMs));
            addChip("delay", "delay " + formatDuration(totalLoopDelayMs));
          } else if (run.durationMs != null) {
            const overhead = Math.max(0, run.durationMs - totalStepDur);
            addChip("overhead", "overhead " + formatDuration(overhead));
          }
          card.appendChild(stepsLabel);

          const listWrap = document.createElement("div");
          listWrap.className = "trace-action-list-wrap";
          const list = document.createElement("div");
          list.className = "trace-action-list";

          for (const group of actionGroups) {
            const row = document.createElement("div");
            row.className = "trace-action-row";

            const nameCell = document.createElement("div");
            nameCell.className = "trace-action-name";
            nameCell.textContent = group.actionType;
            row.appendChild(nameCell);

            const dotsCell = document.createElement("div");
            dotsCell.className = "trace-action-dots";
            for (const step of group.steps) {
              const dot = document.createElement("span");
              dot.className = "trace-dot " + String(step.status || "ok");
              dot.title = "Step " + step.stepNo + " (" + String(step.status || "ok") + ")";
              dotsCell.appendChild(dot);
            }
            row.appendChild(dotsCell);

            const countCell = document.createElement("div");
            countCell.className = "trace-action-count";
            const countPill = document.createElement("span");
            countPill.className = "trace-pill";
            countPill.textContent = String(group.steps.length) + " step" + (group.steps.length === 1 ? "" : "s");
            countCell.appendChild(countPill);
            row.appendChild(countCell);

            const durCell = document.createElement("div");
            durCell.className = "trace-action-dur";
            const durPill = document.createElement("span");
            durPill.className = "trace-pill";
            durPill.textContent = formatDuration(group.totalDurationMs);
            durCell.appendChild(durPill);
            row.appendChild(durCell);

            const errCell = document.createElement("div");
            errCell.className = "trace-action-err";
            if (group.errorCount > 0) {
              errCell.appendChild(makeStatusPill("error"));
            }
            row.appendChild(errCell);

            const arrowCell = document.createElement("div");
            arrowCell.className = "trace-action-arrow";
            arrowCell.textContent = "\\u203A";
            row.appendChild(arrowCell);

            const firstStepOfGroup = group.firstStepNo;
            row.addEventListener("click", (e) => {
              e.stopPropagation();
              openTraceRun({
                ...run,
                actions: allStepsSorted,
              }, firstStepOfGroup);
            });

            list.appendChild(row);
          }
          listWrap.appendChild(list);
          card.appendChild(listWrap);
        }

        host.appendChild(card);
      }

      if (totalPages > 1) {
        const pager = document.createElement("div");
        pager.className = "trace-pager";

        const prevBtn = document.createElement("button");
        prevBtn.className = "trace-pager-btn";
        prevBtn.textContent = "\\u2039 Prev";
        prevBtn.disabled = page === 0;
        prevBtn.addEventListener("click", () => {
          state.tracePage = Math.max(0, state.tracePage - 1);
          renderTraces(state.traceRuns);
        });
        pager.appendChild(prevBtn);

        const info = document.createElement("span");
        info.className = "trace-pager-info";
        info.textContent = "Page " + (page + 1) + " of " + totalPages;
        pager.appendChild(info);

        const nextBtn = document.createElement("button");
        nextBtn.className = "trace-pager-btn";
        nextBtn.textContent = "Next \\u203A";
        nextBtn.disabled = page >= totalPages - 1;
        nextBtn.addEventListener("click", () => {
          state.tracePage = Math.min(totalPages - 1, state.tracePage + 1);
          renderTraces(state.traceRuns);
        });
        pager.appendChild(nextBtn);

        host.appendChild(pager);
      }

      const metaLabel = total === runs.length
        ? total + " run" + (total === 1 ? "" : "s")
        : total + " of " + runs.length + " runs";
      const skipped = state.traceSkippedFiles || 0;
      const truncated = state.traceTruncatedFiles || 0;
      const notes = [];
      if (truncated > 0) {
        notes.push(
          truncated + " large session file" + (truncated === 1 ? "" : "s") +
          " parsed from tail",
        );
      }
      if (skipped > 0) {
        notes.push(
          skipped + " session file" + (skipped === 1 ? "" : "s") +
          " skipped",
        );
      }
      $("#timeline-meta").textContent = notes.length > 0
        ? metaLabel + " (" + notes.join("; ") + ")"
        : metaLabel;
    }

    async function loadTraces(options = {}) {
      const silent = options.silent !== false;
      const payload = await api("/api/traces?limit=50");
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      const skipped = Number(payload.skippedFiles || 0);
      const truncated = Number(payload.truncatedFiles || 0);
      state.traceRuns = runs;
      state.traceSkippedFiles = skipped;
      state.traceTruncatedFiles = truncated;
      renderTraces(runs);
      syncOpenTracePanel();
      if (!silent) {
        setStatus("Action timeline refreshed.", "ok");
      }
    }

    async function refreshPreview(options = {}) {
      const silent = Boolean(options.silent);
      if (!silent) {
        setStatus("Refreshing emulator preview...");
      }
      const preview = await api("/api/emulator/preview");
      state.preview = preview;
      const image = $("#preview-image");
      image.src = "data:image/png;base64," + preview.screenshotBase64;
      image.dataset.pixelWidth = String(preview.width || 0);
      image.dataset.pixelHeight = String(preview.height || 0);
      image.style.display = "block";
      $("#preview-empty").style.display = "none";
      $("#preview-meta").textContent =
        "App: " + (preview.currentApp || "unknown") +
        " | " + (preview.width || "?") + "x" + (preview.height || "?") +
        " | Updated: " + new Date(preview.capturedAt || Date.now()).toLocaleTimeString();
      if (!silent) {
        setStatus("Preview updated.", "ok");
      }
    }

    async function emulatorAction(action) {
      if (state.emulatorActionPending) {
        setStatus("Another emulator action is already running. Please wait.", "error");
        return;
      }
      state.emulatorActionPending = true;
      setEmulatorButtonsDisabled(true);
      setStatus("Running emulator action: " + action + " ...");
      try {
        const payload = await api("/api/emulator/" + action, { method: "POST", body: "{}" });
        setStatus(payload.message || ("Emulator " + action + " done."), "ok");
        await loadRuntime();
      } finally {
        state.emulatorActionPending = false;
        setEmulatorButtonsDisabled(false);
      }
    }

    function setEmulatorButtonsDisabled(disabled) {
      document
        .querySelectorAll("[data-emu-action], #emu-refresh-btn, #onboard-start-emu, #onboard-show-emu")
        .forEach((button) => {
          button.disabled = Boolean(disabled);
        });
    }

    async function sendTextInput() {
      const text = $("#emulator-text-input").value || "";
      if (!text.trim()) {
        setStatus("Input text is empty.", "error");
        return;
      }
      const payload = await api("/api/emulator/type", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setStatus(payload.message || "Text input sent.", "ok");
      await refreshPreview({ silent: true }).catch(() => {});
    }

    async function saveCorePaths() {
      const workspaceDir = $("#workspace-input").value.trim();
      const stateDir = $("#state-input").value.trim();
      const payload = await api("/api/config", {
        method: "POST",
        body: JSON.stringify({ workspaceDir, stateDir }),
      });
      state.config = payload.config;
      setStatus("Config saved.", "ok");
      await loadRuntime();
      await loadConfigAndOnboarding();
      await loadControlSettings();
    }

    async function saveOnboarding() {
      const selectedModelProfile = $("#onboard-model-select").value;
      const consentAccepted = $("#onboard-consent").checked;
      const gmailLoginDone = $("#onboard-gmail-done").checked;
      const useEnvKey = $("#onboard-use-env").checked;
      const apiKey = $("#onboard-api-key").value;
      const assistantName = $("#onboard-assistant-name").value.trim();
      const assistantPersona = $("#onboard-assistant-persona").value.trim();
      const userAddress = $("#onboard-user-address").value.trim();

      await api("/api/onboarding/apply", {
        method: "POST",
        body: JSON.stringify({
          selectedModelProfile,
          consentAccepted,
          gmailLoginDone,
          useEnvKey,
          apiKey,
          assistantName,
          assistantPersona,
          userAddress,
        }),
      });
      setStatus("Onboarding saved to config + state.", "ok");
      await loadConfigAndOnboarding();
      await loadRuntime();
    }

    async function sendPreviewTap(event) {
      const image = $("#preview-image");
      const width = Number(image.dataset.pixelWidth || "0");
      const height = Number(image.dataset.pixelHeight || "0");
      if (!width || !height) {
        return;
      }
      const rect = image.getBoundingClientRect();
      const localX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const localY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
      const targetX = Math.round((localX / rect.width) * width);
      const targetY = Math.round((localY / rect.height) * height);

      await api("/api/emulator/tap", {
        method: "POST",
        body: JSON.stringify({ x: targetX, y: targetY }),
      });
      setStatus("Tap sent at (" + targetX + ", " + targetY + ").", "ok");
      await refreshPreview({ silent: true }).catch(() => {});
    }

    function bindEvents() {
      bindTracePanelEvents();
      document.querySelectorAll(".tab-btn").forEach((button) => {
        button.addEventListener("click", () => {
          const tab = button.dataset.tab;
          activateTab(tab);
          if (tab === "logs") {
            loadLogs().catch(() => {});
          }
          if (tab === "timeline") {
            loadTraces({ silent: true }).catch(() => {});
          }
          if (tab === "permissions") {
            loadScopedFiles().catch(() => {});
          }
          if (tab === "prompts") {
            renderPromptList();
            readPromptContent().catch(() => {});
          }
        });
      });

      $("#runtime-refresh-btn").addEventListener("click", () => {
        loadRuntime().then(() => setStatus("Runtime refreshed.", "ok")).catch((error) => setStatus(error.message, "error"));
      });

      $("#emu-refresh-btn").addEventListener("click", () => {
        loadRuntime().then(() => setStatus("Emulator status refreshed.", "ok")).catch((error) => setStatus(error.message, "error"));
      });

      document.querySelectorAll("[data-emu-action]").forEach((button) => {
        button.addEventListener("click", () => {
          emulatorAction(button.dataset.emuAction).catch((error) => setStatus(error.message, "error"));
        });
      });

      $("#preview-refresh-btn").addEventListener("click", () => {
        refreshPreview({ silent: false }).catch((error) => setStatus(error.message, "error"));
      });

      $("#preview-auto").addEventListener("change", (event) => {
        const enabled = event.target.checked;
        if (state.previewTimer) {
          clearInterval(state.previewTimer);
          state.previewTimer = null;
        }
        if (enabled) {
          state.previewTimer = setInterval(() => {
            refreshPreview({ silent: true }).catch(() => {});
          }, 2000);
        }
      });

      $("#emulator-text-send").addEventListener("click", () => {
        sendTextInput().catch((error) => setStatus(error.message, "error"));
      });

      $("#save-core-paths-btn").addEventListener("click", () => {
        saveCorePaths().catch((error) => setStatus(error.message, "error"));
      });

      $("#onboard-use-env").addEventListener("change", (event) => {
        $("#onboard-api-key-wrap").style.display = event.target.checked ? "none" : "block";
      });

      $("#onboard-model-select").addEventListener("change", () => {
        const select = $("#onboard-model-select");
        const selected = select.value || state.config?.defaultModel;
        const profile = state.config?.models?.[selected];
        const provider = profile?.baseUrl || "unknown";
        const envName = profile?.apiKeyEnv || "N/A";
        const modelId = profile?.model || "unknown";
        const status = state.credentialStatus[selected] || "";
        // Use textContent to avoid XSS from config values.
        const meta = $("#onboard-model-meta");
        meta.textContent = "";
        const lines = [
          "Model ID: " + modelId,
          "Provider: " + provider,
          "Provider API env: " + envName,
          status,
        ].filter(Boolean);
        for (const line of lines) {
          const div = document.createElement("div");
          div.textContent = line;
          meta.appendChild(div);
        }
      });

      ["onboard-model-select", "onboard-consent", "onboard-gmail-done",
       "onboard-use-env", "onboard-api-key", "onboard-assistant-name",
       "onboard-assistant-persona", "onboard-user-address"].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener(el.tagName === "SELECT" ? "change" : "input", updateSaveButtonState);
      });

      $("#onboard-save-btn").addEventListener("click", () => {
        saveOnboarding().catch((error) => setStatus(error.message, "error"));
      });

      $("#onboard-start-emu").addEventListener("click", () => {
        emulatorAction("start").catch((error) => setStatus(error.message, "error"));
      });

      $("#onboard-show-emu").addEventListener("click", () => {
        emulatorAction("show").catch((error) => setStatus(error.message, "error"));
      });

      $("#preview-image").addEventListener("click", (event) => {
        sendPreviewTap(event).catch((error) => setStatus(error.message, "error"));
      });

      $("#perm-save-btn").addEventListener("click", () => {
        savePermissions()
          .then(() => loadScopedFiles())
          .catch((error) => setStatus(error.message, "error"));
      });

      $("#perm-refresh-files-btn").addEventListener("click", () => {
        loadScopedFiles()
          .then(() => setStatus("Scoped files refreshed.", "ok"))
          .catch((error) => setStatus(error.message, "error"));
      });

      $("#perm-file-list").addEventListener("change", () => {
        readScopedFile().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-add-btn").addEventListener("click", () => {
        addPrompt().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-remove-btn").addEventListener("click", () => {
        removePrompt().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-list").addEventListener("change", (event) => {
        state.selectedPromptId = event.target.value || "";
        readPromptContent().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-reload-btn").addEventListener("click", () => {
        readPromptContent().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-save-btn").addEventListener("click", () => {
        savePrompt().catch((error) => setStatus(error.message, "error"));
      });

      $("#logs-refresh-btn").addEventListener("click", () => {
        loadLogs().catch((error) => setStatus(error.message, "error"));
      });

      $("#timeline-refresh-btn").addEventListener("click", () => {
        loadTraces({ silent: false }).catch((error) => setStatus(error.message, "error"));
      });

      $("#logs-clear-btn").addEventListener("click", () => {
        api("/api/logs/clear", { method: "POST", body: "{}" })
          .then(() => loadLogs())
          .then(() => setStatus("Logs cleared.", "ok"))
          .catch((error) => setStatus(error.message, "error"));
      });

      $("#logs-auto").addEventListener("change", (event) => {
        const enabled = event.target.checked;
        if (state.logsTimer) {
          clearInterval(state.logsTimer);
          state.logsTimer = null;
        }
        if (enabled) {
          state.logsTimer = setInterval(() => {
            if (document.querySelector('[data-panel="logs"]').classList.contains("active")) {
              loadLogs().catch(() => {});
            }
          }, 2000);
        }
      });

      document.querySelectorAll(".trace-status-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".trace-status-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          state.traceStatusFilter = btn.dataset.status;
          state.tracePage = 0;
          renderTraces(state.traceRuns);
        });
      });

      $("#trace-search").addEventListener("input", (event) => {
        state.traceSearchFilter = event.target.value;
        state.tracePage = 0;
        renderTraces(state.traceRuns);
      });

      $("#timeline-auto").addEventListener("change", (event) => {
        const enabled = event.target.checked;
        if (state.timelineTimer) {
          clearInterval(state.timelineTimer);
          state.timelineTimer = null;
        }
        if (enabled) {
          state.timelineTimer = setInterval(() => {
            const timelineActive = document.querySelector('[data-panel="timeline"]').classList.contains("active");
            const traceOpen = $("#trace-panel-overlay").classList.contains("open");
            if (timelineActive || traceOpen) {
              loadTraces({ silent: true }).catch(() => {});
            }
          }, 3000);
        }
      });

      $("#channels-refresh-btn").addEventListener("click", () => {
        loadChannels().then(() => setStatus("Channels refreshed.", "ok")).catch((error) => setStatus(error.message, "error"));
      });
    }

    // -------------------------------------------------------------------
    // Channels tab
    // -------------------------------------------------------------------

    async function loadChannels() {
      const payload = await api("/api/channels");
      state.channelsData = payload.channels;
      renderChannels(payload.channels);
    }

    function channelIcon(ch) {
      if (ch === "telegram") return "📨";
      if (ch === "whatsapp") return "💬";
      if (ch === "discord") return "🎮";
      if (ch === "imessage") return "🍎";
      return "📡";
    }

    function sessionBadge(ch, status) {
      if (ch === "whatsapp") {
        return status === "linked"
          ? '<span class="badge ok" style="font-size:11px;">Session Linked</span>'
          : '<span class="badge" style="font-size:11px;">Not Linked</span>';
      }
      if (ch === "imessage") {
        if (status === "chat_db_found") return '<span class="badge ok" style="font-size:11px;">chat.db OK</span>';
        if (status === "unsupported_platform") return '<span class="badge" style="font-size:11px;">Not macOS</span>';
        return '<span class="badge" style="font-size:11px;">chat.db Missing</span>';
      }
      if (ch === "telegram") {
        return status === "token_configured"
          ? '<span class="badge ok" style="font-size:11px;">Token OK</span>'
          : '<span class="badge" style="font-size:11px;">No Token</span>';
      }
      return "";
    }

    function renderChannels(channels) {
      const container = $("#channels-container");
      if (!channels || Object.keys(channels).length === 0) {
        container.innerHTML = '<div class="card"><p class="hint">No channels configured. Edit config.json or run <code>openpocket onboard</code>.</p></div>';
        return;
      }

      const order = ["telegram", "whatsapp", "discord", "imessage"];
      const sorted = order.filter((k) => channels[k]);

      container.innerHTML = sorted.map((ch) => {
        const c = channels[ch];
        const icon = channelIcon(ch);
        const session = sessionBadge(ch, c.sessionStatus);
        const enabledBadge = c.enabled
          ? '<span class="badge ok" style="font-size:11px;">Enabled</span>'
          : '<span class="badge" style="font-size:11px;">Disabled</span>';

        const allowFromHtml = c.allowFrom.length > 0
          ? c.allowFrom.map((id) => '<code style="font-size:12px;background:rgba(0,0,0,0.05);padding:2px 6px;border-radius:4px;">' + escHtml(id) + '</code>').join(" ")
          : '<span class="hint">empty (owner claim on first message)</span>';

        const approvedHtml = c.approved.length > 0
          ? '<table style="width:100%;border-collapse:collapse;margin-top:6px;"><thead><tr style="text-align:left;border-bottom:1px solid rgba(0,0,0,0.1);"><th style="padding:4px 8px;font-size:12px;">Sender ID</th><th style="padding:4px 8px;font-size:12px;"></th></tr></thead><tbody>'
            + c.approved.map((id) => '<tr style="border-bottom:1px solid rgba(0,0,0,0.04);"><td style="padding:4px 8px;font-size:13px;font-family:monospace;">' + escHtml(id) + '</td><td style="padding:4px 8px;text-align:right;"></td></tr>').join("")
            + '</tbody></table>'
          : '<span class="hint">No approved senders yet.</span>';

        const pendingHtml = c.pending.length > 0
          ? '<table style="width:100%;border-collapse:collapse;margin-top:6px;"><thead><tr style="text-align:left;border-bottom:1px solid rgba(0,0,0,0.1);"><th style="padding:4px 8px;font-size:12px;">Code</th><th style="padding:4px 8px;font-size:12px;">Sender</th><th style="padding:4px 8px;font-size:12px;">Name</th><th style="padding:4px 8px;font-size:12px;">Expires</th><th style="padding:4px 8px;font-size:12px;">Actions</th></tr></thead><tbody>'
            + c.pending.map((p) => '<tr style="border-bottom:1px solid rgba(0,0,0,0.04);"><td style="padding:4px 8px;font-size:13px;font-family:monospace;font-weight:600;">' + escHtml(p.code) + '</td><td style="padding:4px 8px;font-size:13px;font-family:monospace;">' + escHtml(p.senderId) + '</td><td style="padding:4px 8px;font-size:13px;">' + escHtml(p.senderName || "-") + '</td><td style="padding:4px 8px;font-size:12px;">' + new Date(p.expiresAt).toLocaleTimeString() + '</td><td style="padding:4px 8px;"><button class="btn primary" style="padding:2px 10px;font-size:11px;" data-pairing-action="approve" data-ch="' + ch + '" data-code="' + escHtml(p.code) + '">Approve</button> <button class="btn warn" style="padding:2px 10px;font-size:11px;" data-pairing-action="reject" data-ch="' + ch + '" data-code="' + escHtml(p.code) + '">Reject</button></td></tr>').join("")
            + '</tbody></table>'
          : '<span class="hint">No pending requests.</span>';

        return '<div class="card" style="margin-top:12px;">'
          + '<div class="row spread" style="align-items:center;">'
          + '<h3 style="margin:0;">' + icon + ' ' + ch.charAt(0).toUpperCase() + ch.slice(1) + '</h3>'
          + '<div class="row" style="gap:6px;">' + enabledBadge + session + '</div>'
          + '</div>'
          + '<div class="grid cols-2" style="margin-top:12px;gap:16px;">'
          + '<div>'
          + '<div class="kv">'
          + '<div><strong>DM Policy</strong><span>' + escHtml(c.dmPolicy) + '</span></div>'
          + '<div><strong>Group Policy</strong><span>' + escHtml(c.groupPolicy) + '</span></div>'
          + '<div><strong>Allow From</strong><span>' + allowFromHtml + '</span></div>'
          + '</div>'
          + '</div>'
          + '<div>'
          + '<div style="display:flex;gap:8px;margin-bottom:8px;">'
          + '<select id="dm-policy-select-' + ch + '" style="padding:4px 8px;border-radius:4px;border:1px solid rgba(0,0,0,0.15);font-size:12px;">'
          + ['pairing','allowlist','open','disabled'].map((p) => '<option value="' + p + '"' + (p === c.dmPolicy ? ' selected' : '') + '>' + p + '</option>').join("")
          + '</select>'
          + '<select id="group-policy-select-' + ch + '" style="padding:4px 8px;border-radius:4px;border:1px solid rgba(0,0,0,0.15);font-size:12px;">'
          + ['open','allowlist','disabled'].map((p) => '<option value="' + p + '"' + (p === c.groupPolicy ? ' selected' : '') + '>' + p + '</option>').join("")
          + '</select>'
          + '<button class="btn primary" style="padding:4px 12px;font-size:12px;" data-save-policy="' + ch + '">Save Policy</button>'
          + '</div>'
          + '</div>'
          + '</div>'
          + '<details style="margin-top:12px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;">Approved Senders (' + c.approved.length + ')</summary>' + approvedHtml
          + '<div class="row" style="margin-top:8px;gap:6px;">'
          + '<input type="text" id="add-sender-' + ch + '" placeholder="Sender ID" style="padding:4px 8px;border-radius:4px;border:1px solid rgba(0,0,0,0.15);font-size:12px;width:200px;" />'
          + '<button class="btn" style="padding:4px 12px;font-size:12px;" data-add-sender="' + ch + '">Add Sender</button>'
          + '</div>'
          + '</details>'
          + '<details style="margin-top:8px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;">Pending Pairing Requests (' + c.pending.length + ')</summary>' + pendingHtml + '</details>'
          + '</div>';
      }).join("");

      container.querySelectorAll("[data-pairing-action]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const action = btn.dataset.pairingAction;
          const ch = btn.dataset.ch;
          const code = btn.dataset.code;
          try {
            await api("/api/channels/pairing/" + action, {
              method: "POST",
              body: JSON.stringify({ channel: ch, code }),
            });
            setStatus("Pairing " + code + " " + action + "d on " + ch + ".", "ok");
            await loadChannels();
          } catch (error) {
            setStatus(error.message, "error");
          }
        });
      });

      container.querySelectorAll("[data-save-policy]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const ch = btn.dataset.savePolicy;
          const dmPolicy = $("#dm-policy-select-" + ch).value;
          const groupPolicy = $("#group-policy-select-" + ch).value;
          try {
            await api("/api/channels/config", {
              method: "POST",
              body: JSON.stringify({ channel: ch, config: { dmPolicy, groupPolicy } }),
            });
            setStatus(ch + " policy saved.", "ok");
            await loadChannels();
          } catch (error) {
            setStatus(error.message, "error");
          }
        });
      });

      container.querySelectorAll("[data-add-sender]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const ch = btn.dataset.addSender;
          const input = $("#add-sender-" + ch);
          const senderId = input.value.trim();
          if (!senderId) return;
          try {
            await api("/api/channels/pairing/add", {
              method: "POST",
              body: JSON.stringify({ channel: ch, senderId }),
            });
            input.value = "";
            setStatus("Sender " + senderId + " added to " + ch + ".", "ok");
            await loadChannels();
          } catch (error) {
            setStatus(error.message, "error");
          }
        });
      });
    }

    function escHtml(str) {
      return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    async function init() {
      bindEvents();
      if ($("#timeline-auto").checked) {
        $("#timeline-auto").dispatchEvent(new Event("change"));
      }

      const startupTasks = [
        { label: "runtime", run: () => loadRuntime() },
        { label: "onboarding", run: () => loadConfigAndOnboarding() },
        { label: "control", run: () => loadControlSettings() },
        { label: "permissions", run: () => loadScopedFiles() },
        { label: "logs", run: () => loadLogs() },
        { label: "timeline", run: () => loadTraces() },
        { label: "channels", run: () => loadChannels() },
      ];
      const failures = [];

      for (const task of startupTasks) {
        try {
          await task.run();
        } catch (error) {
          failures.push(task.label + ": " + (error?.message || "failed"));
        }
      }

      if (failures.length === 0) {
        setStatus("Dashboard ready.", "ok");
      } else {
        const preview = failures.slice(0, 2).join("; ");
        const suffix = failures.length > 2 ? "; ..." : "";
        setStatus("Dashboard partial init (" + failures.length + "): " + preview + suffix, "error");
      }
      state.runtimeTimer = setInterval(() => {
        loadRuntime().catch(() => {});
      }, 3000);
    }

    init();
  </script>
</body>
</html>`;
  }

  private traceDetailShell(sessionId: string, scrollToStep: number | null): string {
    const safeSessionId = JSON.stringify(sessionId);
    const safeStepNo = Number.isFinite(scrollToStep ?? Number.NaN) ? Math.max(1, Math.round(scrollToStep as number)) : null;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenPocket Trace Detail</title>
  <style>
    :root {
      --bg: #f6f8fb;
      --card: #ffffff;
      --line: #dbe4ee;
      --ink: #0f172a;
      --muted: #64748b;
      --ok: #22c55e;
      --err: #ef4444;
      --mono: "SF Mono", "Menlo", "Consolas", monospace;
      --sans: "Avenir Next", "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: linear-gradient(180deg, #eef4fb, #f8fafc);
      color: var(--ink);
    }
    .layout {
      max-width: 1200px;
      margin: 0 auto;
      padding: 18px;
      display: grid;
      gap: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    .head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .title {
      margin: 0;
      font-size: 28px;
      font-weight: 800;
    }
    .sub {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .btn {
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 8px 12px;
      background: #fff;
      color: #0f172a;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 5px 10px;
      border: 1px solid #cbd5e1;
      font-size: 12px;
      background: #f8fafc;
      color: #475569;
    }
    .pill.ok { background: #f0fdf4; color: #166534; border-color: #86efac; }
    .pill.failed { background: #fef2f2; color: #991b1b; border-color: #fca5a5; }
    .pill.running { background: #f5f3ff; color: #5b21b6; border-color: #c4b5fd; }
    .steps {
      display: grid;
      gap: 14px;
    }
    .step {
      border: 1px solid var(--line);
      border-left: 4px solid var(--ok);
      border-radius: 12px;
      background: #fff;
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .step.error { border-left-color: var(--err); }
    .step-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .step-title {
      margin: 0;
      font-size: 16px;
      font-weight: 800;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.6;
    }
    .block, .shot {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #f8fafc;
      padding: 10px;
    }
    .media-row {
      display: flex;
      gap: 10px;
      align-items: start;
      overflow-x: auto;
      overflow-y: hidden;
      width: 100%;
      min-width: 0;
      padding-bottom: 4px;
      overscroll-behavior-x: contain;
      scrollbar-width: thin;
    }
    .media-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #f8fafc;
      padding: 10px;
      display: grid;
      gap: 8px;
      flex: 0 0 320px;
      width: 320px;
      min-width: 320px;
      max-width: 320px;
      overflow: hidden;
    }
    .media-card img {
      display: block;
      width: 100%;
      max-height: 320px;
      object-fit: contain;
      border-radius: 8px;
      background: #e2e8f0;
    }
    .label {
      display: block;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #94a3b8;
      margin-bottom: 6px;
    }
    .block {
      white-space: pre-wrap;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.6;
      color: #334155;
    }
    .shot img {
      display: block;
      width: 100%;
      height: 320px;
      max-height: 320px;
      object-fit: contain;
      border-radius: 8px;
      background: #e2e8f0;
    }
    .shot .path {
      margin-top: 6px;
      font-family: var(--mono);
      font-size: 10px;
      color: var(--muted);
      word-break: break-all;
    }
    .batch-strip {
      display: grid;
      gap: 8px;
    }
    .batch-carousel {
      position: relative;
    }
    .batch-viewport {
      overflow: hidden;
      border-radius: 10px;
    }
    .batch-item {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      padding: 8px;
      display: grid;
      gap: 6px;
    }
    .batch-item img {
      display: block;
      width: 100%;
      max-height: 280px;
      object-fit: contain;
      border-radius: 8px;
      background: #e2e8f0;
    }
    .batch-cap {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      line-height: 1.5;
      word-break: break-word;
    }
    .batch-arrow {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid #cbd5e1;
      background: #fff;
      color: #334155;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
      z-index: 2;
    }
    .batch-arrow:hover { background: #f1f5f9; }
    .batch-arrow:disabled { opacity: 0.3; cursor: default; }
    .batch-arrow.left { left: -14px; }
    .batch-arrow.right { right: -14px; }
    .batch-counter {
      text-align: center;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      margin-top: 4px;
    }
    .empty {
      color: var(--muted);
      font-size: 14px;
    }
    @media (max-width: 900px) {
      .media-card {
        width: 280px;
        min-width: 280px;
        max-width: 280px;
        flex-basis: 280px;
      }
      .media-card img {
        max-height: 280px;
      }
      .shot img {
        height: 280px;
        max-height: 280px;
      }
      .batch-item img {
        max-height: 240px;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <section class="card">
      <div class="head">
        <div>
          <h1 class="title">Trace Detail</h1>
          <div class="sub" id="run-meta">Loading trace…</div>
        </div>
        <div class="row">
          <a class="btn" href="/">Back to Dashboard</a>
          <button class="btn" id="refresh-btn">Refresh</button>
          <span class="pill" id="status-pill">loading</span>
        </div>
      </div>
    </section>
    <section class="steps" id="steps-host">
      <div class="card empty">Loading…</div>
    </section>
  </div>
  <script>
    const sessionId = ${safeSessionId};
    const initialStep = ${safeStepNo === null ? "null" : String(safeStepNo)};
    let latestRun = null;

    function formatDuration(ms) {
      const n = Number(ms || 0);
      if (!Number.isFinite(n) || n <= 0) return "0ms";
      if (n < 1000) return n + "ms";
      const s = n / 1000;
      if (s < 60) return (s >= 10 ? s.toFixed(1) : s.toFixed(1)) + "s";
      const mins = Math.floor(s / 60);
      const secs = Math.round(s - mins * 60);
      return mins + "m " + secs + "s";
    }

    function formatTime(value) {
      const parsed = Date.parse(String(value || ""));
      return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "n/a";
    }

    function traceScreenshotUrl(filePath) {
      return "/api/trace-screenshot?path=" + encodeURIComponent(String(filePath || ""));
    }

    async function api(path) {
      const res = await fetch(path, { headers: { "content-type": "application/json" } });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || res.statusText || "Request failed");
      return payload;
    }

    function renderRun(run) {
      latestRun = run;
      const meta = document.getElementById("run-meta");
      const statusPill = document.getElementById("status-pill");
      const host = document.getElementById("steps-host");
      host.textContent = "";

      if (!run) {
        meta.textContent = "Run not found for session " + sessionId;
        statusPill.textContent = "missing";
        statusPill.className = "pill";
        const empty = document.createElement("section");
        empty.className = "card empty";
        empty.textContent = "No run found.";
        host.appendChild(empty);
        return;
      }

      meta.textContent =
        (run.task || "(no task)") + " | Session: " + (run.sessionId || "unknown") +
        " | Model: " + (run.modelProfile || "unknown") + " (" + (run.modelName || "unknown") + ")" +
        " | Started: " + formatTime(run.startedAt) +
        " | Ended: " + (run.endedAt ? formatTime(run.endedAt) : "running");

      statusPill.textContent = String(run.status || "unknown");
      statusPill.className = "pill " + String(run.status || "");

      const steps = Array.isArray(run.actions) ? run.actions : [];
      if (steps.length === 0) {
        const empty = document.createElement("section");
        empty.className = "card empty";
        empty.textContent = "No completed actions recorded.";
        host.appendChild(empty);
        return;
      }

      let scrollTarget = null;
      for (const step of steps) {
        const card = document.createElement("section");
        card.className = "step " + String(step.status || "ok");
        if (initialStep != null && Number(step.stepNo) === Number(initialStep) && !scrollTarget) {
          scrollTarget = card;
        }

        const head = document.createElement("div");
        head.className = "step-head";
        const title = document.createElement("h2");
        title.className = "step-title";
        title.textContent = "Step " + String(step.stepNo || "?") + " · " + String(step.actionType || "unknown");
        head.appendChild(title);
        const pill = document.createElement("span");
        pill.className = "pill " + String(step.status || "");
        pill.textContent = String(step.status || "");
        head.appendChild(pill);
        card.appendChild(head);

        const metaLine = document.createElement("div");
        metaLine.className = "meta";
        const timing = [];
        if (step.screenshotMs > 0) timing.push("screenshot " + formatDuration(step.screenshotMs));
        if (step.modelInferenceMs > 0) timing.push("model " + formatDuration(step.modelInferenceMs));
        if (step.loopDelayMs > 0) timing.push("delay " + formatDuration(step.loopDelayMs));
        const inlineTotalMs = Number(step.durationMs || 0)
          + Number(step.screenshotMs || 0)
          + Number(step.modelInferenceMs || 0);
        const inlineHasBreakdown = timing.length > 0;
        metaLine.textContent =
          "App: " + String(step.currentApp || "unknown") +
          " | " + formatTime(step.startedAt) + " → " + formatTime(step.endedAt) +
          " | total " + formatDuration(inlineHasBreakdown ? inlineTotalMs : step.durationMs) +
          (inlineHasBreakdown ? " (exec " + formatDuration(step.durationMs) + " · " + timing.join(" · ") + ")" : "");
        card.appendChild(metaLine);

        const mediaRow = document.createElement("div");
        mediaRow.className = "media-row";
        let hasMedia = false;

        function addBlock(labelText, value) {
          if (!value || value === "(empty)") return;
          const block = document.createElement("div");
          block.className = "block";
          const label = document.createElement("span");
          label.className = "label";
          label.textContent = labelText;
          block.appendChild(label);
          block.appendChild(document.createTextNode(String(value)));
          card.appendChild(block);
        }

        function addShot(labelText, filePath) {
          if (!filePath) return;
          hasMedia = true;
          const wrap = document.createElement("div");
          wrap.className = "media-card";
          const label = document.createElement("span");
          label.className = "label";
          label.textContent = labelText;
          wrap.appendChild(label);
          const img = document.createElement("img");
          img.loading = "lazy";
          img.alt = labelText;
          img.src = traceScreenshotUrl(filePath);
          wrap.appendChild(img);
          const path = document.createElement("div");
          path.className = "path";
          path.textContent = String(filePath);
          wrap.appendChild(path);
          mediaRow.appendChild(wrap);
        }

        function addBatchStrip(items) {
          if (!Array.isArray(items) || items.length === 0) return;
          hasMedia = true;
          const wrap = document.createElement("div");
          wrap.className = "media-card batch-strip";
          const label = document.createElement("span");
          label.className = "label";
          label.textContent = "Batch Action Locations";
          wrap.appendChild(label);

          const carousel = document.createElement("div");
          carousel.className = "batch-carousel";
          const viewport = document.createElement("div");
          viewport.className = "batch-viewport";

          const slides = [];
          for (const item of items) {
            const box = document.createElement("div");
            box.className = "batch-item";
            const img = document.createElement("img");
            img.loading = "lazy";
            img.alt = "Batch action " + String(item.index || "");
            img.src = traceScreenshotUrl(item.imagePath);
            box.appendChild(img);
            const cap = document.createElement("div");
            cap.className = "batch-cap";
            cap.textContent =
              "#" + String(item.index || "?") +
              " " + String(item.actionType || "unknown") +
              (item.summary ? " · " + String(item.summary) : "");
            box.appendChild(cap);
            slides.push(box);
          }

          let cur = 0;
          function show(i) {
            cur = i;
            viewport.textContent = "";
            viewport.appendChild(slides[cur]);
            leftBtn.disabled = cur === 0;
            rightBtn.disabled = cur === slides.length - 1;
            counter.textContent = (cur + 1) + " / " + slides.length;
          }

          const leftBtn = document.createElement("button");
          leftBtn.className = "batch-arrow left";
          leftBtn.innerHTML = "&#8249;";
          leftBtn.onclick = function() { if (cur > 0) show(cur - 1); };

          const rightBtn = document.createElement("button");
          rightBtn.className = "batch-arrow right";
          rightBtn.innerHTML = "&#8250;";
          rightBtn.onclick = function() { if (cur < slides.length - 1) show(cur + 1); };

          carousel.appendChild(leftBtn);
          carousel.appendChild(viewport);
          carousel.appendChild(rightBtn);
          wrap.appendChild(carousel);

          const counter = document.createElement("div");
          counter.className = "batch-counter";
          wrap.appendChild(counter);

          show(0);
          mediaRow.appendChild(wrap);
        }

        if (Array.isArray(step.recentScreenshotPaths)) {
          for (let ri = 0; ri < step.recentScreenshotPaths.length; ri++) {
            addShot("Recent Frame " + (ri + 1), step.recentScreenshotPaths[ri]);
          }
        }
        addShot("Input Screenshot", step.inputScreenshotPath);
        addShot("SoM Overlay", step.somScreenshotPath);
        addShot("Click Overlay", step.debugScreenshotPath);
        addBatchStrip(step.batchDebugItems);
        if (hasMedia) {
          card.appendChild(mediaRow);
        }
        addBlock("Thought Process", step.reasoning);
        addBlock("Decision", step.decisionJson);
        addBlock("Outcome", step.result);

        host.appendChild(card);
      }

      if (scrollTarget) {
        requestAnimationFrame(() => scrollTarget.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    }

    let lastFingerprint = "";
    function runFingerprint(run) {
      if (!run) return "null";
      const actions = Array.isArray(run.actions) ? run.actions : [];
      return String(run.status || "") + ":" + actions.length + ":" + String(run.endedAt || "");
    }

    async function load(force) {
      const payload = await api("/api/traces?limit=100");
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      const run = runs.find((item) => String(item.sessionId || "") === sessionId) || null;
      const fp = runFingerprint(run);
      if (!force && fp === lastFingerprint) return;
      lastFingerprint = fp;
      const scrollY = window.scrollY;
      renderRun(run);
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }

    document.getElementById("refresh-btn").addEventListener("click", () => {
      load(true).catch((error) => {
        document.getElementById("run-meta").textContent = error.message;
      });
    });

    load(true).catch((error) => {
      document.getElementById("run-meta").textContent = error.message;
    });
    setInterval(() => {
      load(false).catch(() => {});
    }, 2000);
  </script>
</body>
</html>`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);

    try {
      if (method === "GET" && url.pathname === "/") {
        sendHtml(res, 200, this.htmlShell());
        return;
      }

      if (method === "GET" && url.pathname === "/trace") {
        const sessionId = String(url.searchParams.get("session") ?? "").trim();
        if (!sessionId) {
          throw new Error("Missing trace session id.");
        }
        const stepRaw = Number(url.searchParams.get("step") ?? "");
        const stepNo = Number.isFinite(stepRaw) && stepRaw > 0 ? Math.round(stepRaw) : null;
        sendHtml(res, 200, this.traceDetailShell(sessionId, stepNo));
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          mode: this.mode,
          address: this.address,
          now: nowIso(),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/runtime") {
        sendJson(res, 200, this.runtimePayload());
        return;
      }

      if (method === "GET" && url.pathname === "/api/traces") {
        const limitRaw = Number(url.searchParams.get("limit") ?? "12");
        const limit = Number.isFinite(limitRaw)
          ? Math.max(1, Math.min(100, Math.round(limitRaw)))
          : 12;
        const traceResult = this.readTraceRuns(limit);
        sendJson(res, 200, {
          runs: traceResult.runs,
          skippedFiles: traceResult.skippedFiles,
          truncatedFiles: traceResult.truncatedFiles,
          fetchedAt: nowIso(),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/trace-screenshot") {
        const filePath = String(url.searchParams.get("path") ?? "").trim();
        if (!filePath) {
          throw new Error("Missing trace screenshot path.");
        }
        const screenshot = this.readTraceScreenshotFile(filePath);
        sendBinary(res, 200, screenshot.content, screenshot.contentType);
        return;
      }

      if (method === "GET" && url.pathname === "/api/logs") {
        const limitRaw = Number(url.searchParams.get("limit") ?? "200");
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, Math.round(limitRaw))) : 200;
        sendJson(res, 200, {
          lines: this.listLogs(limit),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/logs/clear") {
        this.clearLogs();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, {
          config: this.config,
          modelProfiles: Object.keys(this.config.models).sort(),
          credentialStatus: this.credentialStatusMap(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/config") {
        const body = await readJsonBody(req);
        const updated = this.applyConfigPatch(body);
        sendJson(res, 200, {
          ok: true,
          config: updated,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/onboarding") {
        const readiness = this.checkProfileReadiness();
        sendJson(res, 200, {
          onboarding: loadOnboardingState(this.config),
          profileReadiness: readiness,
          profileValues: readiness.values,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/onboarding") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid onboarding state payload.");
        }
        const merged: OnboardingStateFile = {
          ...loadOnboardingState(this.config),
          ...body,
          updatedAt: nowIso(),
        };
        saveOnboardingState(this.config, merged);
        sendJson(res, 200, {
          ok: true,
          onboarding: merged,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/onboarding/apply") {
        const body = await readJsonBody(req);
        const applied = this.applyOnboarding(body);
        sendJson(res, 200, {
          ok: true,
          onboarding: applied.onboarding,
          config: applied.config,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/control-settings") {
        const current = loadControlSettings(this.config);
        sendJson(res, 200, {
          controlSettings: current,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/control-settings") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid control settings payload.");
        }
        const merged: MenuBarControlSettings = {
          ...defaultControlSettings(this.config),
          ...loadControlSettings(this.config),
          ...body,
          updatedAt: nowIso(),
        };
        saveControlSettings(this.config, merged);
        sendJson(res, 200, {
          ok: true,
          controlSettings: merged,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/prompts") {
        const control = loadControlSettings(this.config);
        sendJson(res, 200, {
          promptFiles: control.promptFiles,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/prompts/add") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid prompt add payload.");
        }
        const title = String(body.title ?? "").trim();
        const promptPath = String(body.path ?? "").trim();
        if (!promptPath) {
          throw new Error("Prompt path is required.");
        }

        const control = loadControlSettings(this.config);
        const next = {
          ...control,
          promptFiles: [...control.promptFiles],
          updatedAt: nowIso(),
        };
        const id = String(body.id ?? "").trim() || `prompt-${crypto.randomUUID()}`;
        next.promptFiles.push({
          id,
          title: title || path.basename(promptPath, path.extname(promptPath)),
          path: resolvePath(promptPath),
        });
        saveControlSettings(this.config, next);
        this.log(`prompt added id=${id}`);
        sendJson(res, 200, {
          ok: true,
          promptFiles: next.promptFiles,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/prompts/remove") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid prompt remove payload.");
        }
        const id = String(body.id ?? "").trim();
        if (!id) {
          throw new Error("Prompt id is required.");
        }

        const control = loadControlSettings(this.config);
        const next = {
          ...control,
          promptFiles: control.promptFiles.filter((item) => item.id !== id),
          updatedAt: nowIso(),
        };
        saveControlSettings(this.config, next);
        this.log(`prompt removed id=${id}`);
        sendJson(res, 200, {
          ok: true,
          promptFiles: next.promptFiles,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/prompts/read") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid prompt read payload.");
        }
        const id = String(body.id ?? "").trim();
        if (!id) {
          throw new Error("Prompt id is required.");
        }

        const control = loadControlSettings(this.config);
        const prompt = control.promptFiles.find((item) => item.id === id);
        if (!prompt) {
          throw new Error(`Prompt not found: ${id}`);
        }
        const content = this.readPromptFile(prompt.path);
        sendJson(res, 200, {
          prompt,
          content,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/prompts/save") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid prompt save payload.");
        }
        const id = String(body.id ?? "").trim();
        if (!id) {
          throw new Error("Prompt id is required.");
        }
        const content = String(body.content ?? "");

        const control = loadControlSettings(this.config);
        const prompt = control.promptFiles.find((item) => item.id === id);
        if (!prompt) {
          throw new Error(`Prompt not found: ${id}`);
        }
        this.savePromptFile(prompt.path, content);
        this.log(`prompt saved id=${id}`);
        sendJson(res, 200, {
          ok: true,
          prompt,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/permissions/files") {
        const control = loadControlSettings(this.config);
        sendJson(res, 200, {
          files: this.readScopedFiles(control),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/permissions/read-file") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid read-file payload.");
        }
        const filePath = String(body.path ?? "").trim();
        if (!filePath) {
          throw new Error("Missing file path.");
        }
        const control = loadControlSettings(this.config);
        const content = this.readScopedFile(control, filePath);
        sendJson(res, 200, {
          path: filePath,
          content,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/emulator/status") {
        const status = this.emulator.status();
        sendJson(res, 200, {
          status,
          statusText:
            status.bootedDevices.length > 0
              ? `Running (${status.bootedDevices.join(", ")})`
              : status.devices.length > 0
                ? `Starting (${status.devices.join(", ")})`
                : "Stopped",
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/start") {
        const message = await this.runEmulatorLifecycleExclusive("start", () => this.emulator.start(true));
        this.log(`emulator start ${message}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/stop") {
        const message = await this.runEmulatorLifecycleExclusive("stop", async () => this.emulator.stop());
        this.log(`emulator stop ${message}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/show") {
        const message = await this.runEmulatorLifecycleExclusive("show", () => this.emulator.ensureWindowVisible());
        this.log(`emulator show ${message}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/hide") {
        const message = await this.runEmulatorLifecycleExclusive("hide", () => this.emulator.ensureHiddenBackground());
        this.log(`emulator hide ${message}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "GET" && url.pathname === "/api/emulator/preview") {
        const snapshot = await this.adb.captureScreenSnapshot(this.config.agent.deviceId);
        this.previewCache = snapshot;
        sendJson(res, 200, snapshot);
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/tap") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid tap payload.");
        }
        const x = Number(body.x);
        const y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("Tap coordinates must be numbers.");
        }
        const message = this.emulator.tap(Math.round(x), Math.round(y), this.config.agent.deviceId ?? undefined);
        this.log(`emulator tap x=${Math.round(x)} y=${Math.round(y)}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/type") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid text payload.");
        }
        const text = String(body.text ?? "");
        if (!text.trim()) {
          throw new Error("Text input is empty.");
        }
        const message = this.emulator.typeText(text, this.config.agent.deviceId ?? undefined);
        this.log(`emulator type length=${text.length}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      // ---------------------------------------------------------------
      // Channels API
      // ---------------------------------------------------------------

      if (method === "GET" && url.pathname === "/api/channels") {
        const pairingDir = this.config.pairing?.stateDir ?? path.join(this.config.stateDir, "pairing");
        const store = new FilePairingStore({
          stateDir: pairingDir,
          codeLength: this.config.pairing?.codeLength,
          expiresAfterSec: this.config.pairing?.expiresAfterSec,
        });

        const channelTypes: ChannelType[] = ["telegram", "whatsapp", "discord", "imessage"];
        const channels: Record<string, unknown> = {};

        for (const ch of channelTypes) {
          const cfg = ch === "telegram" ? this.config.channels?.telegram
            : ch === "whatsapp" ? this.config.channels?.whatsapp
            : ch === "discord" ? this.config.channels?.discord
            : ch === "imessage" ? this.config.channels?.imessage
            : undefined;
          if (!cfg) continue;

          const approved = store.listApproved(ch);
          const pending = store.listPending(ch);

          let sessionStatus: string | null = null;
          if (ch === "whatsapp") {
            const authDir = path.join(this.config.stateDir, "whatsapp-auth");
            sessionStatus = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0 ? "linked" : "not_linked";
          }
          if (ch === "telegram") {
            const tgCfg = this.config.channels?.telegram;
            const envName = tgCfg?.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
            const hasToken = Boolean((tgCfg?.botToken ?? "").trim() || process.env[envName]?.trim());
            sessionStatus = hasToken ? "token_configured" : "no_token";
          }
          if (ch === "imessage") {
            const chatDbPath = (cfg as { chatDbPath?: string }).chatDbPath
              ?? path.join(os.homedir(), "Library", "Messages", "chat.db");
            const hasChatDb = process.platform === "darwin" && fs.existsSync(chatDbPath);
            sessionStatus = hasChatDb ? "chat_db_found" : (process.platform === "darwin" ? "chat_db_missing" : "unsupported_platform");
          }

          channels[ch] = {
            enabled: (cfg as { enabled?: boolean }).enabled !== false,
            dmPolicy: (cfg as { dmPolicy?: string }).dmPolicy ?? "pairing",
            groupPolicy: (cfg as { groupPolicy?: string }).groupPolicy ?? "open",
            allowFrom: (cfg as { allowFrom?: string[] }).allowFrom ?? [],
            approved,
            pending: pending.map((p) => ({
              code: p.code,
              senderId: p.senderId,
              senderName: p.senderName,
              createdAt: p.createdAt,
              expiresAt: p.expiresAt,
            })),
            sessionStatus,
          };
        }

        sendJson(res, 200, { channels });
        return;
      }

      if (method === "POST" && url.pathname === "/api/channels/pairing/approve") {
        const body = await readJsonBody(req);
        if (!isObject(body)) throw new Error("Invalid payload.");
        const channel = String(body.channel ?? "").trim() as ChannelType;
        const code = String(body.code ?? "").trim();
        if (!channel || !code) throw new Error("channel and code are required.");

        const pairingDir = this.config.pairing?.stateDir ?? path.join(this.config.stateDir, "pairing");
        const store = new FilePairingStore({
          stateDir: pairingDir,
          codeLength: this.config.pairing?.codeLength,
          expiresAfterSec: this.config.pairing?.expiresAfterSec,
        });
        const ok = store.approvePairing(channel, code);
        this.log(`dashboard pairing approve channel=${channel} code=${code} result=${ok}`);
        sendJson(res, 200, { ok, channel, code });
        return;
      }

      if (method === "POST" && url.pathname === "/api/channels/pairing/reject") {
        const body = await readJsonBody(req);
        if (!isObject(body)) throw new Error("Invalid payload.");
        const channel = String(body.channel ?? "").trim() as ChannelType;
        const code = String(body.code ?? "").trim();
        if (!channel || !code) throw new Error("channel and code are required.");

        const pairingDir = this.config.pairing?.stateDir ?? path.join(this.config.stateDir, "pairing");
        const store = new FilePairingStore({
          stateDir: pairingDir,
          codeLength: this.config.pairing?.codeLength,
          expiresAfterSec: this.config.pairing?.expiresAfterSec,
        });
        const ok = store.rejectPairing(channel, code);
        this.log(`dashboard pairing reject channel=${channel} code=${code} result=${ok}`);
        sendJson(res, 200, { ok, channel, code });
        return;
      }

      if (method === "POST" && url.pathname === "/api/channels/pairing/add") {
        const body = await readJsonBody(req);
        if (!isObject(body)) throw new Error("Invalid payload.");
        const channel = String(body.channel ?? "").trim() as ChannelType;
        const senderId = String(body.senderId ?? "").trim();
        if (!channel || !senderId) throw new Error("channel and senderId are required.");

        const pairingDir = this.config.pairing?.stateDir ?? path.join(this.config.stateDir, "pairing");
        const store = new FilePairingStore({
          stateDir: pairingDir,
          codeLength: this.config.pairing?.codeLength,
          expiresAfterSec: this.config.pairing?.expiresAfterSec,
        });
        store.addToAllowlist(channel, senderId);
        this.log(`dashboard pairing add channel=${channel} senderId=${senderId}`);
        sendJson(res, 200, { ok: true, channel, senderId });
        return;
      }

      if (method === "POST" && url.pathname === "/api/channels/config") {
        const body = await readJsonBody(req);
        if (!isObject(body)) throw new Error("Invalid payload.");
        const channel = String(body.channel ?? "").trim();
        const patch = body.config;
        if (!channel || !isObject(patch)) throw new Error("channel and config are required.");

        if (!this.config.channels) (this.config as any).channels = {};
        const channels = this.config.channels as Record<string, unknown>;
        const existing = (channels[channel] ?? {}) as Record<string, unknown>;
        channels[channel] = { ...existing, ...patch };
        saveConfig(this.config);

        this.config = loadConfig(this.config.configPath);
        this.emulator = new EmulatorManager(this.config);
        this.adb = new AdbRuntime(this.config, this.emulator);
        this.log(`dashboard channel config updated channel=${channel}`);
        sendJson(res, 200, { ok: true, config: channels[channel] });
        return;
      }

      sendText(res, 404, "Not found");
    } catch (error) {
      const message = (error as Error).message || "Unknown error";
      this.log(`request failed method=${method} path=${url.pathname} error=${message}`);
      sendJson(res, 400, {
        ok: false,
        error: message,
      });
    }
  }
}
