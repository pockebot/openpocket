import type {
  AgentAction,
  OpenPocketConfig,
  ScreenSnapshot,
  ScreenSnapshotCaptureMetrics,
  UiElementSnapshot,
} from "../types.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { nowIso } from "../utils/paths.js";
import { drawSetOfMarkOverlay, scaleScreenshot } from "../utils/image-scale.js";
import { sleep } from "../utils/time.js";
import { EmulatorManager } from "./emulator-manager.js";
import { normalizeDeviceTargetType } from "./target-types.js";

export function extractPackageName(input: string): string {
  const patterns = [
    /mCurrentFocus=.*\s([A-Za-z0-9._$]+)\/[A-Za-z0-9._$]+/,
    /mFocusedApp=.*\s([A-Za-z0-9._$]+)\/[A-Za-z0-9._$]+/,
    /topResumedActivity=.*\s([A-Za-z0-9._$]+)\/[A-Za-z0-9._$]+/,
    /ResumedActivity:.*\s([A-Za-z0-9._$]+)\/[A-Za-z0-9._$]+/,
    /ACTIVITY\s+([A-Za-z0-9._$]+)\/[A-Za-z0-9._$]+/,
  ];

  for (const re of patterns) {
    const matched = input.match(re);
    if (matched?.[1]) {
      return matched[1];
    }
  }
  return "unknown";
}

function parseScreenSize(output: string): { width: number; height: number } {
  const match = output.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) {
    return { width: 1080, height: 1920 };
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseBounds(boundsRaw: string): { left: number; top: number; right: number; bottom: number } | null {
  const match = boundsRaw.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) {
    return null;
  }
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  if (![left, top, right, bottom].every((value) => Number.isFinite(value))) {
    return null;
  }
  if (right <= left || bottom <= top) {
    return null;
  }
  return { left, top, right, bottom };
}

function parseUiXmlNodes(xml: string): Array<{
  text: string;
  contentDesc: string;
  resourceId: string;
  className: string;
  clickable: boolean;
  enabled: boolean;
  focusable: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
}> {
  const nodes: Array<{
    text: string;
    contentDesc: string;
    resourceId: string;
    className: string;
    clickable: boolean;
    enabled: boolean;
    focusable: boolean;
    bounds: { left: number; top: number; right: number; bottom: number };
  }> = [];
  const nodeRe = /<node\s+([^>]*?)\/>/g;
  const attrRe = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
  let nodeMatch = nodeRe.exec(xml);
  while (nodeMatch) {
    const attrsRaw = nodeMatch[1] ?? "";
    const attrs: Record<string, string> = {};
    attrRe.lastIndex = 0;
    let attrMatch = attrRe.exec(attrsRaw);
    while (attrMatch) {
      attrs[attrMatch[1]] = attrMatch[2] ?? "";
      attrMatch = attrRe.exec(attrsRaw);
    }
    const parsedBounds = parseBounds(String(attrs.bounds ?? "").trim());
    if (parsedBounds) {
      nodes.push({
        text: String(attrs.text ?? ""),
        contentDesc: String(attrs["content-desc"] ?? ""),
        resourceId: String(attrs["resource-id"] ?? ""),
        className: String(attrs.class ?? ""),
        clickable: String(attrs.clickable ?? "").toLowerCase() === "true",
        enabled: String(attrs.enabled ?? "").toLowerCase() !== "false",
        focusable: String(attrs.focusable ?? "").toLowerCase() === "true",
        bounds: parsedBounds,
      });
    }
    nodeMatch = nodeRe.exec(xml);
  }
  return nodes;
}

function uiNodeScore(node: {
  text: string;
  contentDesc: string;
  resourceId: string;
  className: string;
  clickable: boolean;
  enabled: boolean;
  focusable: boolean;
}): number {
  if (!node.enabled) {
    return 0;
  }
  const classLower = node.className.toLowerCase();
  let score = 0;
  if (node.clickable) score += 5;
  if (node.focusable) score += 2;
  if (node.text.trim()) score += 4;
  if (node.contentDesc.trim()) score += 4;
  if (node.resourceId.trim()) score += 2;
  if (classLower.includes("button")) score += 6;
  if (classLower.includes("imagebutton")) score += 4;
  if (classLower.includes("edittext")) score += 3;
  return score;
}

function isLikelyLowValueFullscreenSurface(
  node: UiElementSnapshot,
  scaledWidth: number,
  scaledHeight: number,
): boolean {
  const classLower = String(node.className || "").toLowerCase();
  const isSurfaceClass =
    classLower.includes("surfaceview")
    || classLower.includes("textureview")
    || classLower.includes("glsurfaceview")
    || classLower === "android.view.view";
  if (!isSurfaceClass) {
    return false;
  }
  if (node.clickable || node.text.trim() || node.contentDesc.trim()) {
    return false;
  }
  const bounds = node.scaledBounds;
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const areaRatio = (width * height) / Math.max(1, scaledWidth * scaledHeight);
  const nearFullscreen =
    bounds.left <= 2
    && bounds.top <= 2
    && bounds.right >= scaledWidth - 3
    && bounds.bottom >= scaledHeight - 3;
  const stageHint = String(node.resourceId || "").toLowerCase().includes(":id/stage");
  return areaRatio >= 0.9 && (nearFullscreen || stageHint);
}

function encodeInputText(text: string): string {
  // Escape device-shell metacharacters before passing the value to
  // `adb shell input text ...`, then normalize spaces/newlines for input parser.
  // Keep unicode chars as-is; URL-encoding unicode (e.g. %E6%97...) will be
  // typed literally on many devices.
  return text
    .replace(/([\\(){}[\]<>|;&$`!~"'?#*^@])/g, "\\$1")
    .replace(/ /g, "%s")
    .replace(/\n/g, "%s");
}

function stripOuterQuotes(value: string): string {
  const input = String(value ?? "").trim();
  if (input.length < 2) {
    return input;
  }
  if (input.startsWith("'") && input.endsWith("'")) {
    // Decode the common shell-safe single-quote escape sequence.
    return input.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (input.startsWith("\"") && input.endsWith("\"")) {
    return input
      .slice(1, -1)
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, "\"")
      .replace(/\\\$/g, "$")
      .replace(/\\`/g, "`");
  }
  return input;
}

function parseExplicitShellWrap(command: string): { shell: "sh" | "bash"; mode: "-c" | "-lc"; script: string } | null {
  const normalized = String(command || "").trim();
  const wrapped = normalized.match(/^(sh|bash)\s+(-lc|-c)\s+([\s\S]+)$/i);
  if (!wrapped) {
    return null;
  }
  const shell = wrapped[1]?.toLowerCase() === "bash" ? "bash" : "sh";
  const mode = wrapped[2] === "-c" ? "-c" : "-lc";
  const script = stripOuterQuotes(String(wrapped[3] ?? ""));
  return { shell, mode, script };
}

function splitShellArgs(command: string): string[] {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return [];
  }

  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote === null) {
      if (/\s/.test(ch)) {
        if (current) {
          args.push(current);
          current = "";
        }
        continue;
      }
      if (ch === "'" || ch === "\"") {
        quote = ch as "'" | "\"";
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      current += ch;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    // double-quoted text
    if (ch === "\"") {
      quote = null;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    current += ch;
  }

  if (quote !== null) {
    throw new Error("invalid shell command: unterminated quoted string");
  }
  if (escaping) {
    current += "\\";
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

function looksLikeClipboardCommandError(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("no shell command implementation")) {
    return true;
  }
  return /(^|\s)(error|unknown|usage|exception|not found|unsupported|no shell command implementation)(\s|:|$)/i.test(normalized);
}

function looksLikeBroadcastFailure(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return /no receivers|unable to resolve|exception|error/.test(normalized);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || "unknown error");
}

function looksLikeAdbTimeout(error: unknown): boolean {
  const text = String(
    error instanceof Error
      ? [error.message, (error as { stack?: string }).stack ?? ""].join("\n")
      : error ?? "",
  ).toLowerCase();
  if (!text) {
    return false;
  }
  return text.includes("timed out")
    || text.includes("timeout")
    || text.includes("etimedout")
    || text.includes("signal: sigterm");
}

const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;

function hammingDistanceHex(left: string, right: string): number | null {
  if (!left || !right || left.length !== right.length) {
    return null;
  }
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = Number.parseInt(left[i], 16);
    const b = Number.parseInt(right[i], 16);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return null;
    }
    distance += NIBBLE_POPCOUNT[a ^ b];
  }
  return distance;
}

async function computeVisualHash(
  pngBuffer: Buffer,
  width: number,
  height: number,
): Promise<string> {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));

  let top = Math.max(0, Math.round(safeHeight * VISUAL_HASH_TOP_TRIM_RATIO));
  let bottom = Math.max(0, Math.round(safeHeight * VISUAL_HASH_BOTTOM_TRIM_RATIO));
  let croppedHeight = safeHeight - top - bottom;
  if (croppedHeight < VISUAL_HASH_MIN_CROP_HEIGHT) {
    top = 0;
    bottom = 0;
    croppedHeight = safeHeight;
  }

  try {
    const raw = await sharp(pngBuffer)
      .extract({
        left: 0,
        top,
        width: safeWidth,
        height: Math.max(1, croppedHeight),
      })
      .grayscale()
      .resize(VISUAL_HASH_GRID_WIDTH, VISUAL_HASH_GRID_HEIGHT, {
        fit: "fill",
        kernel: "nearest",
      })
      .raw()
      .toBuffer();

    const expectedSize = VISUAL_HASH_GRID_WIDTH * VISUAL_HASH_GRID_HEIGHT;
    if (raw.length < expectedSize) {
      return createHash("sha1").update(pngBuffer).digest("hex").slice(0, 16);
    }

    let bits = 0n;
    let bitIndex = 0n;
    for (let y = 0; y < VISUAL_HASH_GRID_HEIGHT; y += 1) {
      const rowStart = y * VISUAL_HASH_GRID_WIDTH;
      for (let x = 0; x < VISUAL_HASH_COMPARE_WIDTH; x += 1) {
        const l = raw[rowStart + x];
        const r = raw[rowStart + x + 1];
        const diff = Math.abs(l - r);
        const bit = l > r && diff > VISUAL_HASH_PIXEL_NOISE_THRESHOLD;
        if (bit) {
          bits |= (1n << bitIndex);
        }
        bitIndex += 1n;
      }
    }
    return bits.toString(16).padStart(VISUAL_HASH_BITS / 4, "0");
  } catch {
    return createHash("sha1").update(pngBuffer).digest("hex").slice(0, 16);
  }
}

const DEFAULT_LOCKSCREEN_PIN = "1234";
const SCREEN_AWAKE_HEARTBEAT_MS = 3_000;
const PIN_UNLOCK_MAX_ATTEMPTS = 2;
const PIN_UNLOCK_SETTLE_MS = 1_500;
const UI_DUMP_TIMEOUT_MS = 12_000;
const UI_DUMP_CACHE_MAX_AGE_MS = 15_000;
const UI_DUMP_CACHE_MAX_REUSE = 1;
const UI_DUMP_MAX_HASH_DISTANCE = 4;
const UI_NODE_MIN_SCORE = 4;
const VISUAL_HASH_BITS = 64;
const VISUAL_HASH_GRID_WIDTH = 9;
const VISUAL_HASH_COMPARE_WIDTH = 8;
const VISUAL_HASH_GRID_HEIGHT = 8;
const VISUAL_HASH_TOP_TRIM_RATIO = 0.07;
const VISUAL_HASH_BOTTOM_TRIM_RATIO = 0.11;
const VISUAL_HASH_MIN_CROP_HEIGHT = 200;
const VISUAL_HASH_PIXEL_NOISE_THRESHOLD = 3;

type ScreenAwakeWorkerParams = {
  adbPath: string;
  preferredDeviceId: string | null;
  adbEndpoint: string | null;
  targetType: string;
  intervalMs: number;
};

type ScreenAwakeWorkerHandle = {
  stop: () => void;
};

type AdbRuntimeOptions = {
  createScreenAwakeWorker?: (params: ScreenAwakeWorkerParams) => ScreenAwakeWorkerHandle;
};

type UiDumpCaptureResult = {
  uiElements: UiElementSnapshot[];
  failed: boolean;
  timedOut: boolean;
};

type UiDumpCacheEntry = {
  currentApp: string;
  scaledWidth: number;
  scaledHeight: number;
  visualHash: string;
  uiElements: UiElementSnapshot[];
  updatedAtMs: number;
  reuseCount: number;
};

export class AdbRuntime {
  private readonly config: OpenPocketConfig;
  private readonly emulator: EmulatorManager;
  private readonly screenSizeCache = new Map<string, { width: number; height: number; updatedAtMs: number }>();
  private readonly uiDumpCache = new Map<string, UiDumpCacheEntry>();
  private readonly createScreenAwakeWorker: (params: ScreenAwakeWorkerParams) => ScreenAwakeWorkerHandle;
  private screenAwakeWorker: ScreenAwakeWorkerHandle | null = null;
  private screenAwakeWorkerKey = "";

  constructor(config: OpenPocketConfig, emulator: EmulatorManager, options?: AdbRuntimeOptions) {
    this.config = config;
    this.emulator = emulator;
    this.createScreenAwakeWorker = options?.createScreenAwakeWorker ?? ((params) => this.spawnScreenAwakeWorker(params));
  }

  private targetType() {
    return normalizeDeviceTargetType(this.config.target?.type);
  }

  private shouldPrepareInteractiveTarget(): boolean {
    const targetType = this.targetType();
    return targetType === "physical-phone" || targetType === "android-tv";
  }

  private normalizeTargetAdbEndpoint(): string | null {
    const raw = String(this.config.target?.adbEndpoint ?? "").trim();
    if (!raw) {
      return null;
    }
    if (raw.includes(":")) {
      return raw;
    }
    return `${raw}:5555`;
  }

  private buildScreenAwakeWorkerParams(
    preferred?: string | null,
    intervalMs = SCREEN_AWAKE_HEARTBEAT_MS,
  ): ScreenAwakeWorkerParams {
    const normalizedInterval = Math.max(1_000, Math.round(intervalMs));
    const targetType = this.targetType();
    return {
      adbPath: this.emulator.adbBinary(),
      preferredDeviceId:
        preferred !== undefined
          ? preferred
          : (this.config.agent.deviceId ?? null),
      adbEndpoint: targetType === "emulator" ? null : this.normalizeTargetAdbEndpoint(),
      targetType,
      intervalMs: normalizedInterval,
    };
  }

  private spawnScreenAwakeWorker(params: ScreenAwakeWorkerParams): ScreenAwakeWorkerHandle {
    const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "screen-awake-worker.js");
    const child = spawn(process.execPath, [workerPath, JSON.stringify(params)], {
      stdio: "ignore",
      detached: false,
    });
    child.unref();
    return {
      stop: () => {
        if (child.killed) {
          return;
        }
        try {
          child.kill();
        } catch {
          // best effort kill
        }
      },
    };
  }

  startScreenAwakeHeartbeat(preferred?: string | null, intervalMs = SCREEN_AWAKE_HEARTBEAT_MS): void {
    let params: ScreenAwakeWorkerParams;
    try {
      params = this.buildScreenAwakeWorkerParams(preferred, intervalMs);
    } catch {
      // Keep-awake worker is best effort and must not break runtime startup.
      return;
    }

    const key = JSON.stringify(params);
    if (this.screenAwakeWorker && this.screenAwakeWorkerKey === key) {
      return;
    }
    this.stopScreenAwakeHeartbeat();

    try {
      this.screenAwakeWorker = this.createScreenAwakeWorker(params);
      this.screenAwakeWorkerKey = key;
    } catch {
      // Keep-awake worker is best effort.
      this.screenAwakeWorker = null;
      this.screenAwakeWorkerKey = "";
    }
  }

  stopScreenAwakeHeartbeat(): void {
    if (!this.screenAwakeWorker) {
      return;
    }
    this.screenAwakeWorker.stop();
    this.screenAwakeWorker = null;
    this.screenAwakeWorkerKey = "";
  }

  private isDisplayInteractive(deviceId: string): boolean | null {
    try {
      const dump = this.emulator.runAdb(["-s", deviceId, "shell", "dumpsys", "power"], 8_000);
      if (/mInteractive=true/i.test(dump)) {
        return true;
      }
      if (/mInteractive=false/i.test(dump)) {
        return false;
      }
      if (/Display Power:\s*state=ON/i.test(dump)) {
        return true;
      }
      if (/Display Power:\s*state=(OFF|DOZE|DOZE_SUSPEND)/i.test(dump)) {
        return false;
      }
      return null;
    } catch {
      return null;
    }
  }

  private isKeyguardShowing(deviceId: string): boolean | null {
    try {
      const dump = this.emulator.runAdb(["-s", deviceId, "shell", "dumpsys", "window", "policy"], 8_000);
      if (
        /isStatusBarKeyguard=true/i.test(dump)
        || /mShowingLockscreen=true/i.test(dump)
        || /mKeyguardShowing=true/i.test(dump)
        || /KeyguardServiceDelegate[\s\S]{0,500}\bshowing=true\b/i.test(dump)
      ) {
        return true;
      }
      if (
        /isStatusBarKeyguard=false/i.test(dump)
        || /mShowingLockscreen=false/i.test(dump)
        || /mKeyguardShowing=false/i.test(dump)
        || /KeyguardServiceDelegate[\s\S]{0,500}\bshowing=false\b/i.test(dump)
      ) {
        return false;
      }
      return null;
    } catch {
      return null;
    }
  }

  private resolveConfiguredUnlockPin(): string {
    const configured = String(this.config.target?.pin ?? "").trim();
    if (/^\d{4}$/.test(configured)) {
      return configured;
    }
    return DEFAULT_LOCKSCREEN_PIN;
  }

  private async attemptPinUnlock(deviceId: string, pin: string): Promise<void> {
    const normalized = String(pin ?? "").trim();
    if (!/^\d{4}$/.test(normalized)) {
      return;
    }

    const { width, height } = this.resolveScreenSize(deviceId);
    const x = Math.max(1, Math.round(width / 2));
    const startY = Math.max(1, Math.round(height * 0.82));
    const endY = Math.max(1, Math.round(height * 0.25));

    try {
      this.emulator.runAdb([
        "-s",
        deviceId,
        "shell",
        "input",
        "swipe",
        String(x),
        String(startY),
        String(x),
        String(endY),
        "220",
      ]);
    } catch {
      // Best effort pull-up gesture to show PIN pad.
    }
    await sleep(140);

    for (const digit of normalized) {
      const keycode = String(Number(digit) + 7);
      try {
        this.emulator.runAdb(["-s", deviceId, "shell", "input", "keyevent", keycode]);
      } catch {
        // Best effort digit entry.
      }
      await sleep(60);
    }

    try {
      this.emulator.runAdb(["-s", deviceId, "shell", "input", "keyevent", "66"]);
    } catch {
      // Best effort confirm.
    }
    await sleep(220);
  }

  private async ensureInteractiveTargetReady(deviceId: string): Promise<void> {
    if (!this.shouldPrepareInteractiveTarget()) {
      return;
    }

    const interactive = this.isDisplayInteractive(deviceId);
    if (interactive !== true) {
      try {
        this.emulator.runAdb(["-s", deviceId, "shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
      } catch {
        // Best effort wake-up.
      }
      await sleep(280);
    }

    const keyguardBefore = this.isKeyguardShowing(deviceId);
    if (keyguardBefore === false) {
      return;
    }

    try {
      this.emulator.runAdb(["-s", deviceId, "shell", "wm", "dismiss-keyguard"]);
    } catch {
      // Best effort dismiss.
    }
    await sleep(180);

    const keyguardAfterDismiss = this.isKeyguardShowing(deviceId);
    if (keyguardAfterDismiss === false) {
      return;
    }

    const configuredPin = this.resolveConfiguredUnlockPin();
    for (let pinAttempt = 0; pinAttempt < PIN_UNLOCK_MAX_ATTEMPTS; pinAttempt += 1) {
      await this.attemptPinUnlock(deviceId, configuredPin);
      let keyguardAfterPin = this.isKeyguardShowing(deviceId);
      if (keyguardAfterPin === false) {
        return;
      }
      if (keyguardAfterPin !== true) {
        return;
      }
      if (pinAttempt < PIN_UNLOCK_MAX_ATTEMPTS - 1) {
        // Keyguard state may lag right after successful unlock.
        // Re-check after a short settle delay before entering PIN again.
        await sleep(PIN_UNLOCK_SETTLE_MS);
        keyguardAfterPin = this.isKeyguardShowing(deviceId);
        if (keyguardAfterPin === false) {
          return;
        }
        if (keyguardAfterPin !== true) {
          return;
        }
        // Give keyguard a short settle window before retrying PIN entry.
        await sleep(220);
      }
    }

    throw new Error(
      `Target device '${deviceId}' is locked. Please unlock and keep the screen on, then retry.`,
    );
  }

  private shouldPrepareForAction(action: AgentAction): boolean {
    switch (action.type) {
      case "tap":
      case "tap_element":
      case "swipe":
      case "drag":
      case "long_press_drag":
      case "type":
      case "keyevent":
      case "launch_app":
      case "shell":
        return true;
      default:
        return false;
    }
  }

  private normalizeClipboardText(text: string): string {
    return String(text || "")
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private verifyClipboardContains(deviceId: string, expected: string): "verified" | "unsupported" | "mismatch" {
    const sample = expected.trim().slice(0, 16);
    if (!sample) {
      return "verified";
    }
    try {
      const output = this.emulator.runAdb(["-s", deviceId, "shell", "cmd", "clipboard", "get", "text"]);
      if (looksLikeClipboardCommandError(output)) {
        return "unsupported";
      }
      const normalizedOutput = this.normalizeClipboardText(output).toLowerCase();
      const normalizedSample = this.normalizeClipboardText(sample).toLowerCase();
      if (!normalizedOutput || !normalizedSample) {
        return "mismatch";
      }
      if (normalizedOutput.includes(normalizedSample)) {
        return "verified";
      }
      const compactOutput = normalizedOutput.replace(/\s+/g, "");
      const compactSample = normalizedSample.replace(/\s+/g, "");
      if (compactOutput && compactSample && compactOutput.includes(compactSample)) {
        return "verified";
      }
      return "mismatch";
    } catch {
      return "unsupported";
    }
  }

  private inputByClipboardPaste(deviceId: string, text: string): string {
    const setOutput = this.emulator.runAdb(["-s", deviceId, "shell", "cmd", "clipboard", "set", "text", text]);
    if (looksLikeClipboardCommandError(setOutput)) {
      throw new Error(`clipboard set command failed: ${this.normalizeClipboardText(setOutput)}`);
    }
    const verification = this.verifyClipboardContains(deviceId, text);
    if (verification === "mismatch") {
      throw new Error("clipboard set could not be verified; skip paste to avoid stale clipboard content");
    }
    this.emulator.runAdb(["-s", deviceId, "shell", "input", "keyevent", "KEYCODE_PASTE"]);
    if (verification === "unsupported") {
      return `Typed text via clipboard paste (unverified) length=${text.length}`;
    }
    return `Typed text via clipboard paste length=${text.length}`;
  }

  private hasInputMethod(deviceId: string, imeId: string): boolean {
    try {
      const raw = this.emulator.runAdb(["-s", deviceId, "shell", "ime", "list", "-s"]);
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .includes(imeId);
    } catch {
      return false;
    }
  }

  private getDefaultInputMethod(deviceId: string): string | null {
    try {
      const raw = this.emulator.runAdb(["-s", deviceId, "shell", "settings", "get", "secure", "default_input_method"]);
      const imeId = raw.trim();
      if (!imeId || imeId.toLowerCase() === "null") {
        return null;
      }
      return imeId;
    } catch {
      return null;
    }
  }

  private inputByAdbKeyboard(deviceId: string, text: string): string {
    const adbIme = "com.android.adbkeyboard/.AdbIME";
    if (!this.hasInputMethod(deviceId, adbIme)) {
      throw new Error("adb keyboard IME is unavailable");
    }

    const previousIme = this.getDefaultInputMethod(deviceId);
    try {
      this.emulator.runAdb(["-s", deviceId, "shell", "ime", "enable", adbIme]);
      this.emulator.runAdb(["-s", deviceId, "shell", "ime", "set", adbIme]);

      const base64Text = Buffer.from(text, "utf8").toString("base64");
      const output = this.emulator.runAdb([
        "-s",
        deviceId,
        "shell",
        "am",
        "broadcast",
        "-a",
        "ADB_INPUT_B64",
        "--es",
        "msg",
        base64Text,
      ]);
      if (looksLikeBroadcastFailure(output)) {
        throw new Error(this.normalizeClipboardText(output));
      }
      return `Typed text via adb keyboard length=${text.length}`;
    } finally {
      if (previousIme && previousIme !== adbIme) {
        try {
          this.emulator.runAdb(["-s", deviceId, "shell", "ime", "set", previousIme]);
        } catch {
          // best effort restore
        }
      }
    }
  }

  resolveDeviceId(preferred?: string | null): string {
    const status = this.emulator.status();
    const expected = preferred ?? this.config.agent.deviceId;

    if (expected) {
      if (!status.devices.includes(expected)) {
        throw new Error(`Configured device '${expected}' is not online.`);
      }
      return expected;
    }

    if (status.bootedDevices.length > 0) {
      return status.bootedDevices[0];
    }
    if (status.devices.length > 0) {
      return status.devices[0];
    }

    throw new Error("No online target device found.");
  }

  queryLaunchablePackages(preferred?: string | null): string[] {
    const deviceId = this.resolveDeviceId(preferred);
    try {
      const raw = this.emulator.runAdb([
        "-s", deviceId, "shell",
        "pm", "query-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
      ]);
      const seen = new Set<string>();
      const result: string[] = [];
      for (const line of raw.split("\n")) {
        const m = line.match(/packageName=(\S+)/);
        if (m && m[1] && !seen.has(m[1])) {
          seen.add(m[1]);
          result.push(m[1]);
        }
      }
      return result.sort();
    } catch {
      return [];
    }
  }

  private resolveScreenSize(deviceId: string): { width: number; height: number } {
    const cached = this.screenSizeCache.get(deviceId);
    if (cached && Date.now() - cached.updatedAtMs < 30_000) {
      return {
        width: cached.width,
        height: cached.height,
      };
    }
    let output = "";
    try {
      output = this.emulator.runAdb(["-s", deviceId, "shell", "wm", "size"]);
    } catch {
      output = "";
    }
    const parsed = parseScreenSize(output);
    this.screenSizeCache.set(deviceId, {
      width: parsed.width,
      height: parsed.height,
      updatedAtMs: Date.now(),
    });
    return parsed;
  }

  private resolveCurrentApp(deviceId: string): string {
    const probes: Array<string[]> = [
      ["-s", deviceId, "shell", "dumpsys", "activity", "activities"],
      ["-s", deviceId, "shell", "dumpsys", "window", "windows"],
    ];
    for (const args of probes) {
      try {
        const dump = this.emulator.runAdb(args);
        const parsed = extractPackageName(dump);
        if (parsed && parsed !== "unknown") {
          return parsed;
        }
      } catch {
        // try next probe
      }
    }
    return "unknown";
  }

  async captureQuickObservation(preferred?: string | null, modelName?: string): Promise<{
    deviceId: string;
    currentApp: string;
    screenshotHash: string;
  }> {
    const deviceId = this.resolveDeviceId(preferred);
    await this.ensureInteractiveTargetReady(deviceId);
    const { data } = this.emulator.captureScreenshotBuffer(deviceId);
    const scaled = await scaleScreenshot(data, modelName);
    return {
      deviceId,
      currentApp: this.resolveCurrentApp(deviceId),
      screenshotHash: createHash("sha1").update(scaled.data).digest("hex").slice(0, 12),
    };
  }

  private cloneUiElements(uiElements: UiElementSnapshot[]): UiElementSnapshot[] {
    return uiElements.map((item) => ({
      ...item,
      bounds: { ...item.bounds },
      center: { ...item.center },
      scaledBounds: { ...item.scaledBounds },
      scaledCenter: { ...item.scaledCenter },
    }));
  }

  private shouldReuseUiDumpCache(
    entry: UiDumpCacheEntry | undefined,
    params: {
      currentApp: string;
      scaledWidth: number;
      scaledHeight: number;
      visualHash: string;
      nowMs: number;
    },
  ): { reuse: boolean; visualHashDistance: number | null } {
    if (!entry) {
      return { reuse: false, visualHashDistance: null };
    }

    const visualHashDistance = hammingDistanceHex(params.visualHash, entry.visualHash);
    if (entry.currentApp !== params.currentApp) {
      return { reuse: false, visualHashDistance };
    }
    if (entry.scaledWidth !== params.scaledWidth || entry.scaledHeight !== params.scaledHeight) {
      return { reuse: false, visualHashDistance };
    }
    if (params.nowMs - entry.updatedAtMs > UI_DUMP_CACHE_MAX_AGE_MS) {
      return { reuse: false, visualHashDistance };
    }
    if (entry.reuseCount >= UI_DUMP_CACHE_MAX_REUSE) {
      return { reuse: false, visualHashDistance };
    }
    if (visualHashDistance === null || visualHashDistance > UI_DUMP_MAX_HASH_DISTANCE) {
      return { reuse: false, visualHashDistance };
    }
    return { reuse: true, visualHashDistance };
  }

  async captureScreenSnapshot(preferred?: string | null, modelName?: string): Promise<ScreenSnapshot> {
    const captureStartedAtMs = Date.now();
    const metrics: ScreenSnapshotCaptureMetrics = {
      totalMs: 0,
      ensureReadyMs: 0,
      screencapMs: 0,
      screenSizeMs: 0,
      currentAppMs: 0,
      scaleMs: 0,
      uiDumpMs: 0,
      overlayMs: 0,
      uiElementsSource: "fresh_empty",
      uiElementsCount: 0,
      visualHash: "",
      visualHashHammingDistance: null,
      uiDumpTimedOut: false,
    };

    const deviceId = this.resolveDeviceId(preferred);
    const ensureReadyStartMs = Date.now();
    await this.ensureInteractiveTargetReady(deviceId);
    metrics.ensureReadyMs = Date.now() - ensureReadyStartMs;

    const screencapStartMs = Date.now();
    const { data } = this.emulator.captureScreenshotBuffer(deviceId);
    metrics.screencapMs = Date.now() - screencapStartMs;

    const currentAppStartMs = Date.now();
    const currentApp = this.resolveCurrentApp(deviceId);
    metrics.currentAppMs = Date.now() - currentAppStartMs;

    const scaleStartMs = Date.now();
    const scaled = await scaleScreenshot(data, modelName);
    metrics.scaleMs = Date.now() - scaleStartMs;

    let width = scaled.originalWidth;
    let height = scaled.originalHeight;
    const screenSizeStartMs = Date.now();
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      const fallbackSize = this.resolveScreenSize(deviceId);
      width = fallbackSize.width;
      height = fallbackSize.height;
    }
    metrics.screenSizeMs = Date.now() - screenSizeStartMs;

    const visualHash = await computeVisualHash(scaled.data, scaled.width, scaled.height);
    metrics.visualHash = visualHash;

    const nowMs = Date.now();
    const cached = this.uiDumpCache.get(deviceId);
    const cacheDecision = this.shouldReuseUiDumpCache(cached, {
      currentApp,
      scaledWidth: scaled.width,
      scaledHeight: scaled.height,
      visualHash,
      nowMs,
    });
    metrics.visualHashHammingDistance = cacheDecision.visualHashDistance;

    let uiElements: UiElementSnapshot[] = [];
    let uiElementsSource: ScreenSnapshotCaptureMetrics["uiElementsSource"] = "fresh_empty";
    let uiDumpTimedOut = false;

    const uiDumpStartMs = Date.now();
    if (cacheDecision.reuse && cached) {
      uiElements = this.cloneUiElements(cached.uiElements);
      cached.reuseCount += 1;
      cached.updatedAtMs = nowMs;
      uiElementsSource = "cache";
    } else {
      const freshCapture = this.captureUiElements(
        deviceId,
        width,
        height,
        scaled.width,
        scaled.height,
      );
      uiDumpTimedOut = freshCapture.timedOut;

      const canFallbackToCache = cached
        ? (
            cached.currentApp === currentApp
            && cached.scaledWidth === scaled.width
            && cached.scaledHeight === scaled.height
            && (nowMs - cached.updatedAtMs <= UI_DUMP_CACHE_MAX_AGE_MS)
            && (
              freshCapture.failed
              || (
                freshCapture.uiElements.length === 0
                && cacheDecision.visualHashDistance !== null
                && cacheDecision.visualHashDistance <= UI_DUMP_MAX_HASH_DISTANCE
              )
            )
          )
        : false;

      if (freshCapture.uiElements.length > 0) {
        uiElements = freshCapture.uiElements;
        uiElementsSource = "fresh";
        this.uiDumpCache.set(deviceId, {
          currentApp,
          scaledWidth: scaled.width,
          scaledHeight: scaled.height,
          visualHash,
          uiElements: this.cloneUiElements(freshCapture.uiElements),
          updatedAtMs: nowMs,
          reuseCount: 0,
        });
      } else if (canFallbackToCache && cached) {
        uiElements = this.cloneUiElements(cached.uiElements);
        cached.reuseCount = Math.min(cached.reuseCount + 1, UI_DUMP_CACHE_MAX_REUSE);
        cached.updatedAtMs = nowMs;
        uiElementsSource = "cache_fallback";
      } else {
        uiElementsSource = "fresh_empty";
        this.uiDumpCache.delete(deviceId);
      }
    }
    metrics.uiDumpMs = Date.now() - uiDumpStartMs;
    metrics.uiDumpTimedOut = uiDumpTimedOut;
    metrics.uiElementsSource = uiElementsSource;
    metrics.uiElementsCount = uiElements.length;

    let somScreenshotBase64: string | null = null;
    if (uiElements.length > 0) {
      const overlayStartMs = Date.now();
      const somBuffer = await drawSetOfMarkOverlay(
        scaled.data,
        uiElements.map((item) => ({
          id: item.id,
          bounds: item.scaledBounds,
        })),
      );
      metrics.overlayMs = Date.now() - overlayStartMs;
      somScreenshotBase64 = somBuffer.toString("base64");
    } else {
      metrics.overlayMs = 0;
    }
    metrics.totalMs = Date.now() - captureStartedAtMs;

    return {
      deviceId,
      currentApp,
      width,
      height,
      screenshotBase64: scaled.data.toString("base64"),
      somScreenshotBase64,
      capturedAt: nowIso(),
      scaleX: scaled.scaleX,
      scaleY: scaled.scaleY,
      scaledWidth: scaled.width,
      scaledHeight: scaled.height,
      uiElements,
      captureMetrics: metrics,
    };
  }

  private captureUiElements(
    deviceId: string,
    width: number,
    height: number,
    scaledWidth: number,
    scaledHeight: number,
  ): UiDumpCaptureResult {
    let raw = "";
    let timedOut = false;
    try {
      // Use exec-out so XML is streamed directly; shell /dev/tty is often empty
      // in non-interactive ADB sessions.
      raw = this.emulator.runAdb(
        ["-s", deviceId, "exec-out", "uiautomator", "dump", "/dev/tty"],
        UI_DUMP_TIMEOUT_MS,
      );
    } catch (error) {
      raw = "";
      timedOut = looksLikeAdbTimeout(error);
    }
    let xmlStart = raw.indexOf("<hierarchy");
    if (xmlStart < 0) {
      try {
        // Fallback: dump to device file then read via cat.
        this.emulator.runAdb(
          ["-s", deviceId, "shell", "uiautomator", "dump", "/sdcard/openpocket-ui.xml"],
          UI_DUMP_TIMEOUT_MS,
        );
        raw = this.emulator.runAdb(
          ["-s", deviceId, "shell", "cat", "/sdcard/openpocket-ui.xml"],
          UI_DUMP_TIMEOUT_MS,
        );
      } catch (error) {
        timedOut = timedOut || looksLikeAdbTimeout(error);
        return { uiElements: [], failed: true, timedOut };
      }
      xmlStart = raw.indexOf("<hierarchy");
    }
    if (xmlStart < 0) {
      return { uiElements: [], failed: true, timedOut };
    }
    const xml = raw.slice(xmlStart);
    const parsed = parseUiXmlNodes(xml)
      .map((node) => ({ node, score: uiNodeScore(node) }))
      .filter(({ score }) => score >= UI_NODE_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, 28);

    const scaleDownX = scaledWidth / Math.max(1, width);
    const scaleDownY = scaledHeight / Math.max(1, height);

    const mapped = parsed.map(({ node }, index) => {
      const centerX = Math.round((node.bounds.left + node.bounds.right) / 2);
      const centerY = Math.round((node.bounds.top + node.bounds.bottom) / 2);
      const scaledLeft = Math.max(0, Math.min(scaledWidth - 1, Math.round(node.bounds.left * scaleDownX)));
      const scaledTop = Math.max(0, Math.min(scaledHeight - 1, Math.round(node.bounds.top * scaleDownY)));
      const scaledRight = Math.max(0, Math.min(scaledWidth - 1, Math.round(node.bounds.right * scaleDownX)));
      const scaledBottom = Math.max(0, Math.min(scaledHeight - 1, Math.round(node.bounds.bottom * scaleDownY)));
      const scaledCenterX = Math.max(0, Math.min(scaledWidth - 1, Math.round(centerX * scaleDownX)));
      const scaledCenterY = Math.max(0, Math.min(scaledHeight - 1, Math.round(centerY * scaleDownY)));
      return {
        id: String(index + 1),
        text: node.text.trim(),
        contentDesc: node.contentDesc.trim(),
        resourceId: node.resourceId.trim(),
        className: node.className.trim(),
        clickable: node.clickable,
        enabled: node.enabled,
        bounds: node.bounds,
        center: { x: centerX, y: centerY },
        scaledBounds: {
          left: Math.min(scaledLeft, scaledRight),
          top: Math.min(scaledTop, scaledBottom),
          right: Math.max(scaledLeft, scaledRight),
          bottom: Math.max(scaledTop, scaledBottom),
        },
        scaledCenter: { x: scaledCenterX, y: scaledCenterY },
      };
    });
    const filtered = mapped
      .filter((item) => !isLikelyLowValueFullscreenSurface(item, scaledWidth, scaledHeight))
      .map((item, index) => ({
        ...item,
        id: String(index + 1),
      }));
    return { uiElements: filtered, failed: false, timedOut };
  }

  async executeAction(action: AgentAction, preferred?: string | null): Promise<string> {
    const deviceId = this.resolveDeviceId(preferred);
    if (this.shouldPrepareForAction(action)) {
      await this.ensureInteractiveTargetReady(deviceId);
    }

    switch (action.type) {
      case "tap": {
        const x = Math.max(0, Math.round(action.x));
        const y = Math.max(0, Math.round(action.y));
        this.emulator.runAdb(["-s", deviceId, "shell", "input", "tap", String(x), String(y)]);
        return `Tapped at (${x}, ${y})`;
      }
      case "tap_element": {
        return `tap_element(${action.elementId}) is resolved by AgentRuntime to tap coordinates.`;
      }
      case "swipe": {
        const durationMs = Math.max(100, Math.round(action.durationMs ?? 300));
        this.emulator.runAdb([
          "-s",
          deviceId,
          "shell",
          "input",
          "swipe",
          String(Math.round(action.x1)),
          String(Math.round(action.y1)),
          String(Math.round(action.x2)),
          String(Math.round(action.y2)),
          String(durationMs),
        ]);
        return `Swiped from (${action.x1}, ${action.y1}) to (${action.x2}, ${action.y2})`;
      }
      case "drag": {
        const durationMs = Math.max(100, Math.round(action.durationMs ?? 360));
        this.emulator.runAdb([
          "-s",
          deviceId,
          "shell",
          "input",
          "swipe",
          String(Math.round(action.x1)),
          String(Math.round(action.y1)),
          String(Math.round(action.x2)),
          String(Math.round(action.y2)),
          String(durationMs),
        ]);
        return `Dragged from (${action.x1}, ${action.y1}) to (${action.x2}, ${action.y2})`;
      }
      case "long_press_drag": {
        const holdMs = Math.max(120, Math.round(action.holdMs ?? 450));
        const moveDurationMs = Math.max(100, Math.round(action.durationMs ?? 300));
        const totalDurationMs = holdMs + moveDurationMs;
        this.emulator.runAdb([
          "-s",
          deviceId,
          "shell",
          "input",
          "swipe",
          String(Math.round(action.x1)),
          String(Math.round(action.y1)),
          String(Math.round(action.x2)),
          String(Math.round(action.y2)),
          String(totalDurationMs),
        ]);
        return `Long-press drag from (${action.x1}, ${action.y1}) to (${action.x2}, ${action.y2}) hold=${holdMs}ms move=${moveDurationMs}ms`;
      }
      case "type": {
        const encoded = encodeInputText(action.text);
        // On some emulator images, `input text` throws NPE for unicode text.
        // For unicode text, skip `input text` and use clipboard/ADB keyboard.
        if (hasNonAscii(action.text)) {
          try {
            return this.inputByClipboardPaste(deviceId, action.text);
          } catch (clipboardError) {
            try {
              return this.inputByAdbKeyboard(deviceId, action.text);
            } catch (imeError) {
              throw new Error(
                `Text input failed (clipboard + adb keyboard): clipboard=${errorMessage(clipboardError)}; adbKeyboard=${errorMessage(imeError)}`,
              );
            }
          }
        }
        try {
          this.emulator.runAdb(["-s", deviceId, "shell", "input", "text", encoded]);
          return `Typed text length=${action.text.length}`;
        } catch (inputTextError) {
          try {
            return this.inputByClipboardPaste(deviceId, action.text);
          } catch (clipboardError) {
            try {
              return this.inputByAdbKeyboard(deviceId, action.text);
            } catch (imeError) {
              throw new Error(
                `Text input failed (adb input + clipboard + adb keyboard): adbInput=${errorMessage(inputTextError)}; clipboard=${errorMessage(clipboardError)}; adbKeyboard=${errorMessage(imeError)}`,
              );
            }
          }
        }
      }
      case "keyevent": {
        this.emulator.runAdb(["-s", deviceId, "shell", "input", "keyevent", action.keycode]);
        return `Sent keyevent ${action.keycode}`;
      }
      case "launch_app": {
        this.emulator.runAdb([
          "-s",
          deviceId,
          "shell",
          "monkey",
          "-p",
          action.packageName,
          "-c",
          "android.intent.category.LAUNCHER",
          "1",
        ]);
        return `Launched package ${action.packageName}`;
      }
      case "shell": {
        const command = String(action.command ?? "").trim();
        if (!command) {
          return "Skipped empty shell command";
        }
        if (action.useShellWrap) {
          this.emulator.runAdb(["-s", deviceId, "shell", "sh", "-lc", command]);
          return `Executed shell command: ${action.command}`;
        }

        const wrapped = parseExplicitShellWrap(command);
        if (wrapped) {
          this.emulator.runAdb([
            "-s",
            deviceId,
            "shell",
            wrapped.shell,
            wrapped.mode,
            wrapped.script,
          ]);
          return `Executed shell command: ${action.command}`;
        }

        const parts = splitShellArgs(command);
        if (parts.length === 0) {
          return "Skipped empty shell command";
        }
        this.emulator.runAdb(["-s", deviceId, "shell", ...parts]);
        return `Executed shell command: ${action.command}`;
      }
      case "run_script": {
        return "run_script is handled by ScriptExecutor in AgentRuntime.";
      }
      case "read":
      case "write":
      case "edit":
      case "apply_patch":
      case "exec":
      case "process": {
        return `${action.type} is handled by CodingExecutor in AgentRuntime.`;
      }
      case "memory_search":
      case "memory_get": {
        return `${action.type} is handled by MemoryExecutor in AgentRuntime.`;
      }
      case "request_human_auth": {
        return `Human authorization requested: capability=${action.capability}`;
      }
      case "request_user_decision": {
        return "request_user_decision is handled by AgentRuntime via gateway callback.";
      }
      case "request_user_input": {
        return "request_user_input is handled by AgentRuntime via gateway callback.";
      }
      case "batch_actions": {
        return "batch_actions is handled by AgentRuntime.";
      }
      case "wait": {
        const durationMs = Math.max(100, Math.round(action.durationMs ?? 1000));
        await sleep(durationMs);
        return `Waited ${durationMs}ms`;
      }
      case "finish": {
        return `Finish: ${action.message}`;
      }
      default: {
        const exhaust: never = action;
        return `Unknown action: ${JSON.stringify(exhaust)}`;
      }
    }
  }
}
