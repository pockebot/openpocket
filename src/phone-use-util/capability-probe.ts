import { nowIso } from "../utils/paths.js";

export type PhoneUseCapability = "camera" | "microphone" | "location" | "photos";
export type PhoneUseCapabilityPhase = "requested" | "active";

export interface CapabilityProbeEvent {
  capability: PhoneUseCapability;
  phase: PhoneUseCapabilityPhase;
  packageName: string;
  source: "appops" | "camera_service" | "activity_log" | "permission_dialog";
  observedAt: string;
  confidence: number;
  evidence: string;
}

export interface CapabilityProbePollParams {
  deviceId: string;
  foregroundPackage: string;
  candidatePackages?: string[];
}

export interface CapabilityProbeAdbRunner {
  run(deviceId: string, args: string[], timeoutMs?: number): string;
}

export interface PhoneUseCapabilityProbeOptions {
  adbRunner: CapabilityProbeAdbRunner;
  nowMs?: () => number;
  nowIso?: () => string;
  recentWindowMs?: number;
  dedupeWindowMs?: number;
  minPollIntervalMs?: number;
  logcatLookbackSec?: number;
}

type AppOpsSignalParseParams = {
  packageName: string;
  observedAt: string;
  recentWindowMs: number;
};

type ActivityLogParseParams = {
  fallbackPackage: string;
  observedAt: string;
};

const PACKAGE_RE = /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\b/g;
const APP_OPS_TARGETS = new Set([
  "CAMERA",
  "RECORD_AUDIO",
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "READ_MEDIA_IMAGES",
  "READ_EXTERNAL_STORAGE",
]);

const CAMERA_ACTIONS = new Set([
  "android.media.action.IMAGE_CAPTURE",
  "android.media.action.VIDEO_CAPTURE",
]);
const MIC_ACTIONS = new Set([
  "android.provider.MediaStore.RECORD_SOUND",
  "android.speech.action.RECOGNIZE_SPEECH",
]);
const PHOTO_ACTIONS = new Set([
  "android.intent.action.GET_CONTENT",
  "android.intent.action.OPEN_DOCUMENT",
  "android.provider.action.PICK_IMAGES",
  "android.intent.action.PICK",
]);

function extractPackages(text: string): string[] {
  const out = new Set<string>();
  let match = PACKAGE_RE.exec(text);
  while (match) {
    out.add(match[1]);
    match = PACKAGE_RE.exec(text);
  }
  PACKAGE_RE.lastIndex = 0;
  return [...out];
}

export function parseAgoDurationMs(rawValue: string): number | null {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw
    .replace(/^\+/, "")
    .replace(/\s+ago$/i, "")
    .replace(/\s+/g, "");
  if (!normalized) {
    return null;
  }

  const tokenRe = /(\d+)(ms|d|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  let matched = false;
  let token = tokenRe.exec(normalized);
  while (token) {
    matched = true;
    consumed += token[0].length;
    const value = Number(token[1]);
    const unit = token[2];
    if (!Number.isFinite(value)) {
      return null;
    }
    switch (unit) {
      case "d":
        total += value * 24 * 60 * 60 * 1000;
        break;
      case "h":
        total += value * 60 * 60 * 1000;
        break;
      case "m":
        total += value * 60 * 1000;
        break;
      case "s":
        total += value * 1000;
        break;
      case "ms":
        total += value;
        break;
      default:
        return null;
    }
    token = tokenRe.exec(normalized);
  }
  if (!matched || consumed !== normalized.length) {
    return null;
  }
  return total;
}

function extractAgoFromTail(tail: string, key: "time" | "rejectTime"): number | null {
  const match = tail.match(new RegExp(`${key}=([^;]+)`));
  if (!match?.[1]) {
    return null;
  }
  return parseAgoDurationMs(match[1]);
}

function appOpsToCapability(op: string): PhoneUseCapability | null {
  switch (op) {
    case "CAMERA":
      return "camera";
    case "RECORD_AUDIO":
      return "microphone";
    case "ACCESS_FINE_LOCATION":
    case "ACCESS_COARSE_LOCATION":
      return "location";
    case "READ_MEDIA_IMAGES":
    case "READ_EXTERNAL_STORAGE":
      return "photos";
    default:
      return null;
  }
}

export function parseAppOpsCapabilitySignals(
  appOpsOutput: string,
  params: AppOpsSignalParseParams,
): CapabilityProbeEvent[] {
  const lines = appOpsOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: CapabilityProbeEvent[] = [];

  for (const line of lines) {
    const normalizedLine = line.replace(/^Uid mode:\s*/i, "");
    const parsed = normalizedLine.match(/^([A-Z_]+)\s*:\s*([a-z_]+)(.*)$/i);
    if (!parsed) {
      continue;
    }
    const op = String(parsed[1] || "").toUpperCase();
    if (!APP_OPS_TARGETS.has(op)) {
      continue;
    }
    const capability = appOpsToCapability(op);
    if (!capability) {
      continue;
    }
    const mode = String(parsed[2] || "").toLowerCase();
    const tail = String(parsed[3] || "");

    const accessAgoMs = extractAgoFromTail(tail, "time");
    const rejectAgoMs = extractAgoFromTail(tail, "rejectTime");

    if (
      accessAgoMs !== null
      && accessAgoMs <= params.recentWindowMs
      && (mode === "allow" || mode === "foreground")
    ) {
      out.push({
        capability,
        phase: "active",
        packageName: params.packageName,
        source: "appops",
        observedAt: params.observedAt,
        confidence: 0.93,
        evidence: line.slice(0, 220),
      });
      continue;
    }

    if (
      rejectAgoMs !== null
      && rejectAgoMs <= params.recentWindowMs
      && (mode === "ignore" || mode === "deny" || mode === "default")
    ) {
      out.push({
        capability,
        phase: "requested",
        packageName: params.packageName,
        source: "appops",
        observedAt: params.observedAt,
        confidence: 0.7,
        evidence: line.slice(0, 220),
      });
    }
  }

  return out;
}

export function parseCameraDumpsysCapabilitySignals(
  cameraDumpsysOutput: string,
  params: { foregroundPackage: string; observedAt: string },
): CapabilityProbeEvent[] {
  const sectionMatch = cameraDumpsysOutput.match(
    /Active Camera Clients:\s*([\s\S]*?)(?:\n\s*\n|$)/i,
  );
  const section = sectionMatch?.[1] ?? "";
  if (!section || /\[\s*\]/.test(section)) {
    return [];
  }
  const packageNames = extractPackages(section);
  if (packageNames.length === 0) {
    return [];
  }
  return packageNames.map((packageName) => ({
    capability: "camera",
    phase: "active",
    packageName,
    source: "camera_service",
    observedAt: params.observedAt,
    confidence: packageName === params.foregroundPackage ? 0.98 : 0.92,
    evidence: section.trim().slice(0, 220),
  }));
}

function looksLikePhotoIntent(action: string, message: string): boolean {
  if (action === "android.provider.action.PICK_IMAGES") {
    return true;
  }
  if (!PHOTO_ACTIONS.has(action)) {
    return false;
  }
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("typ=image/")
    || lowerMessage.includes("typ=vnd.android.cursor.dir/image")
    || lowerMessage.includes("pick_images")
    || lowerMessage.includes("image/*")
  );
}

function resolveCallerPackage(message: string, fallbackPackage: string): string {
  const fromUidMatch = message.match(/from uid \d+ \(([^)]+)\)/i);
  if (fromUidMatch?.[1]) {
    return fromUidMatch[1];
  }
  const cmpMatch = message.match(/\bcmp=([a-zA-Z0-9._]+)\//);
  if (cmpMatch?.[1]) {
    return cmpMatch[1];
  }
  return fallbackPackage;
}

export function parseActivityLogCapabilitySignals(
  activityLogOutput: string,
  params: ActivityLogParseParams,
): CapabilityProbeEvent[] {
  const lines = activityLogOutput.split(/\r?\n/);
  const out: CapabilityProbeEvent[] = [];

  for (const rawLine of lines) {
    if (!rawLine.includes("ActivityTaskManager: START")) {
      continue;
    }
    const messageMatch = rawLine.match(/ActivityTaskManager:\s+(.*)$/);
    if (!messageMatch?.[1]) {
      continue;
    }
    const message = messageMatch[1];
    const actionMatch = message.match(/\bact=([^\s}]+)/);
    if (!actionMatch?.[1]) {
      continue;
    }
    const action = actionMatch[1];
    const callerPackage = resolveCallerPackage(message, params.fallbackPackage);

    if (CAMERA_ACTIONS.has(action)) {
      out.push({
        capability: "camera",
        phase: "requested",
        packageName: callerPackage,
        source: "activity_log",
        observedAt: params.observedAt,
        confidence: 0.89,
        evidence: message.slice(0, 220),
      });
      continue;
    }

    if (MIC_ACTIONS.has(action)) {
      out.push({
        capability: "microphone",
        phase: "requested",
        packageName: callerPackage,
        source: "activity_log",
        observedAt: params.observedAt,
        confidence: 0.89,
        evidence: message.slice(0, 220),
      });
      continue;
    }

    if (looksLikePhotoIntent(action, message)) {
      out.push({
        capability: "photos",
        phase: "requested",
        packageName: callerPackage,
        source: "activity_log",
        observedAt: params.observedAt,
        confidence: 0.87,
        evidence: message.slice(0, 220),
      });
    }
  }

  return out;
}

function isLikelyPackageName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(value);
}

export class PhoneUseCapabilityProbe {
  private readonly adbRunner: CapabilityProbeAdbRunner;
  private readonly nowMsFn: () => number;
  private readonly nowIsoFn: () => string;
  private readonly recentWindowMs: number;
  private readonly dedupeWindowMs: number;
  private readonly minPollIntervalMs: number;
  private readonly logcatLookbackSec: number;
  private lastPollAtMs = 0;
  private lastLogcatSinceEpochSec = 0;
  private readonly seenFingerprints = new Map<string, number>();

  constructor(options: PhoneUseCapabilityProbeOptions) {
    this.adbRunner = options.adbRunner;
    this.nowMsFn = options.nowMs ?? (() => Date.now());
    this.nowIsoFn = options.nowIso ?? (() => nowIso());
    this.recentWindowMs = Math.max(1000, Math.round(options.recentWindowMs ?? 12_000));
    this.dedupeWindowMs = Math.max(1000, Math.round(options.dedupeWindowMs ?? 10_000));
    this.minPollIntervalMs = Math.max(300, Math.round(options.minPollIntervalMs ?? 4_000));
    this.logcatLookbackSec = Math.max(1, Math.round(options.logcatLookbackSec ?? 10));
  }

  poll(params: CapabilityProbePollParams): CapabilityProbeEvent[] {
    const deviceId = String(params.deviceId || "").trim();
    const foregroundPackage = String(params.foregroundPackage || "").trim();
    const candidatePackages = Array.isArray(params.candidatePackages)
      ? params.candidatePackages
      : [];
    const appPackages = [
      foregroundPackage,
      ...candidatePackages.map((item) => String(item || "").trim()),
    ].filter((item, index, arr) => (
      isLikelyPackageName(item)
      && arr.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index
    ));
    if (!deviceId || appPackages.length === 0) {
      return [];
    }

    const nowMs = this.nowMsFn();
    if (nowMs - this.lastPollAtMs < this.minPollIntervalMs) {
      return [];
    }
    this.lastPollAtMs = nowMs;

    const observedAt = this.nowIsoFn();
    const events: CapabilityProbeEvent[] = [];

    for (const packageName of appPackages) {
      const appOpsOutput = this.safeRunAdb(deviceId, ["shell", "cmd", "appops", "get", packageName], 2800);
      if (!appOpsOutput) {
        continue;
      }
      events.push(
        ...parseAppOpsCapabilitySignals(appOpsOutput, {
          packageName,
          observedAt,
          recentWindowMs: this.recentWindowMs,
        }),
      );
    }

    const cameraOutput = this.safeRunAdb(deviceId, ["shell", "dumpsys", "media.camera"], 2800);
    if (cameraOutput) {
      events.push(
        ...parseCameraDumpsysCapabilitySignals(cameraOutput, {
          foregroundPackage: appPackages[0] ?? foregroundPackage,
          observedAt,
        }),
      );
    }

    const nowEpochSec = Math.floor(nowMs / 1000);
    const sinceEpochSec = this.lastLogcatSinceEpochSec > 0
      ? this.lastLogcatSinceEpochSec
      : Math.max(0, nowEpochSec - this.logcatLookbackSec);
    const activityLog = this.safeRunAdb(
      deviceId,
      [
        "shell",
        "logcat",
        "-d",
        "-v",
        "epoch",
        "-T",
        String(sinceEpochSec),
        "ActivityTaskManager:I",
        "ActivityManager:I",
        "*:S",
      ],
      3200,
    );
    this.lastLogcatSinceEpochSec = nowEpochSec;
    if (activityLog) {
      events.push(
        ...parseActivityLogCapabilitySignals(activityLog, {
          fallbackPackage: appPackages[0] ?? foregroundPackage,
          observedAt,
        }),
      );
    }

    return this.dedupe(events, nowMs);
  }

  private safeRunAdb(deviceId: string, args: string[], timeoutMs: number): string {
    try {
      return this.adbRunner.run(deviceId, args, timeoutMs);
    } catch {
      return "";
    }
  }

  private dedupe(events: CapabilityProbeEvent[], nowMs: number): CapabilityProbeEvent[] {
    const out: CapabilityProbeEvent[] = [];

    for (const [key, ts] of this.seenFingerprints.entries()) {
      if (nowMs - ts > this.dedupeWindowMs * 2) {
        this.seenFingerprints.delete(key);
      }
    }

    for (const event of events) {
      const fingerprint = [
        event.capability,
        event.phase,
        event.packageName,
        event.source,
      ].join("|");
      const last = this.seenFingerprints.get(fingerprint) ?? 0;
      if (nowMs - last < this.dedupeWindowMs) {
        continue;
      }
      this.seenFingerprints.set(fingerprint, nowMs);
      out.push(event);
    }
    return out;
  }
}
