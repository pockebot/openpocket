import type { AgentAction, OpenPocketConfig, ScreenSnapshot } from "../types";
import { nowIso } from "../utils/paths";
import { scaleScreenshot } from "../utils/image-scale";
import { sleep } from "../utils/time";
import { EmulatorManager } from "./emulator-manager";

function extractPackageName(input: string): string {
  const patterns = [
    /mCurrentFocus=.*\s([A-Za-z0-9._$]+)\/[A-Za-z0-9._$]+/,
    /mFocusedApp=.*\s([A-Za-z0-9._$]+)\/[A-Za-z0-9._$]+/,
    /topResumedActivity=.*\s([A-Za-z0-9._$]+)\/[A-Za-z0-9._$]+/,
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

function encodeInputText(text: string): string {
  // Keep unicode chars as-is; only normalize spaces for adb input parser.
  // URL-encoding unicode (e.g. %E6%97...) will be typed literally on many devices.
  return text
    .replace(/ /g, "%s")
    .replace(/\n/g, "%s");
}

function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

function looksLikeClipboardCommandError(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(^|\s)(error|unknown|usage|exception|not found|unsupported)(\s|:|$)/i.test(normalized);
}

export class AdbRuntime {
  private readonly config: OpenPocketConfig;
  private readonly emulator: EmulatorManager;

  constructor(config: OpenPocketConfig, emulator: EmulatorManager) {
    this.config = config;
    this.emulator = emulator;
  }

  private normalizeClipboardText(text: string): string {
    return String(text || "")
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private verifyClipboardContains(deviceId: string, expected: string): boolean {
    const sample = expected.trim().slice(0, 16);
    if (!sample) {
      return true;
    }
    try {
      const output = this.emulator.runAdb(["-s", deviceId, "shell", "cmd", "clipboard", "get", "text"]);
      if (looksLikeClipboardCommandError(output)) {
        return false;
      }
      const normalizedOutput = this.normalizeClipboardText(output).toLowerCase();
      const normalizedSample = this.normalizeClipboardText(sample).toLowerCase();
      if (!normalizedOutput || !normalizedSample) {
        return false;
      }
      return normalizedOutput.includes(normalizedSample);
    } catch {
      return false;
    }
  }

  private inputByClipboardPaste(deviceId: string, text: string): string {
    const setOutput = this.emulator.runAdb(["-s", deviceId, "shell", "cmd", "clipboard", "set", "text", text]);
    if (looksLikeClipboardCommandError(setOutput)) {
      throw new Error(`clipboard set command failed: ${this.normalizeClipboardText(setOutput)}`);
    }
    if (!this.verifyClipboardContains(deviceId, text)) {
      throw new Error("clipboard set could not be verified; skip paste to avoid stale clipboard content");
    }
    this.emulator.runAdb(["-s", deviceId, "shell", "input", "keyevent", "KEYCODE_PASTE"]);
    return `Typed text via clipboard paste length=${text.length}`;
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

    throw new Error("No running emulator device found.");
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

  async captureScreenSnapshot(preferred?: string | null, modelName?: string): Promise<ScreenSnapshot> {
    const deviceId = this.resolveDeviceId(preferred);

    const { data } = this.emulator.captureScreenshotBuffer(deviceId);
    const screenSizeOutput = this.emulator.runAdb(["-s", deviceId, "shell", "wm", "size"]);
    const { width, height } = parseScreenSize(screenSizeOutput);

    let currentApp = "unknown";
    try {
      const windowDump = this.emulator.runAdb(["-s", deviceId, "shell", "dumpsys", "window", "windows"]);
      currentApp = extractPackageName(windowDump);
    } catch {
      currentApp = "unknown";
    }

    const scaled = await scaleScreenshot(data, modelName);

    return {
      deviceId,
      currentApp,
      width,
      height,
      screenshotBase64: scaled.data.toString("base64"),
      capturedAt: nowIso(),
      scaleX: scaled.scaleX,
      scaleY: scaled.scaleY,
      scaledWidth: scaled.width,
      scaledHeight: scaled.height,
    };
  }

  async executeAction(action: AgentAction, preferred?: string | null): Promise<string> {
    const deviceId = this.resolveDeviceId(preferred);

    switch (action.type) {
      case "tap": {
        const x = Math.max(0, Math.round(action.x));
        const y = Math.max(0, Math.round(action.y));
        this.emulator.runAdb(["-s", deviceId, "shell", "input", "tap", String(x), String(y)]);
        return `Tapped at (${x}, ${y})`;
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
      case "type": {
        const encoded = encodeInputText(action.text);
        // On some emulator images, `input text` throws NPE for unicode text.
        // Try clipboard paste first for non-ASCII; verify write before paste.
        if (hasNonAscii(action.text)) {
          try {
            return this.inputByClipboardPaste(deviceId, action.text);
          } catch {
            this.emulator.runAdb(["-s", deviceId, "shell", "input", "text", encoded]);
            return `Typed text length=${action.text.length}`;
          }
        }
        try {
          this.emulator.runAdb(["-s", deviceId, "shell", "input", "text", encoded]);
          return `Typed text length=${action.text.length}`;
        } catch {
          return this.inputByClipboardPaste(deviceId, action.text);
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
        const parts = action.command.trim().split(/\s+/);
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
