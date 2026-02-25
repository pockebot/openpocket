import type { OpenPocketConfig } from "../types.js";
import { nowIso } from "../utils/paths.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import { extractPackageName } from "../device/adb-runtime.js";

export type HumanAuthTakeoverAction =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { type: "type"; text: string }
  | { type: "keyevent"; keycode: string };

export interface HumanAuthTakeoverFrame {
  deviceId: string;
  currentApp: string;
  width: number;
  height: number;
  screenshotBase64: string;
  capturedAt: string;
}

export interface HumanAuthTakeoverRuntime {
  captureFrame(): Promise<HumanAuthTakeoverFrame>;
  execute(action: HumanAuthTakeoverAction): Promise<string>;
}

function parseScreenSize(output: string): { width: number; height: number } {
  const match = output.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) {
    return { width: 1080, height: 1920 };
  }
  return {
    width: Number(match[1]) || 1080,
    height: Number(match[2]) || 1920,
  };
}

export class LocalHumanAuthTakeoverRuntime implements HumanAuthTakeoverRuntime {
  private readonly config: OpenPocketConfig;
  private readonly emulator: EmulatorManager;

  constructor(config: OpenPocketConfig) {
    this.config = config;
    this.emulator = new EmulatorManager(config);
  }

  private resolveDeviceId(): string {
    const preferred = this.config.agent.deviceId?.trim() || "";
    const status = this.emulator.status();
    if (preferred && status.devices.includes(preferred)) {
      return preferred;
    }
    if (status.bootedDevices.length > 0) {
      return status.bootedDevices[0];
    }
    if (status.devices.length > 0) {
      return status.devices[0];
    }
    throw new Error("No online target device found for takeover.");
  }

  async captureFrame(): Promise<HumanAuthTakeoverFrame> {
    const deviceId = this.resolveDeviceId();
    const { data } = this.emulator.captureScreenshotBuffer(deviceId);
    const sizeOutput = this.emulator.runAdb(["-s", deviceId, "shell", "wm", "size"], 15_000);
    const { width, height } = parseScreenSize(sizeOutput);

    let currentApp = "unknown";
    try {
      const windowDump = this.emulator.runAdb(["-s", deviceId, "shell", "dumpsys", "window", "windows"], 15_000);
      currentApp = extractPackageName(windowDump);
    } catch {
      currentApp = "unknown";
    }

    return {
      deviceId,
      currentApp,
      width,
      height,
      screenshotBase64: data.toString("base64"),
      capturedAt: nowIso(),
    };
  }

  async execute(action: HumanAuthTakeoverAction): Promise<string> {
    const deviceId = this.resolveDeviceId();

    if (action.type === "tap") {
      return this.emulator.tap(action.x, action.y, deviceId);
    }

    if (action.type === "swipe") {
      const durationMs = Math.max(80, Math.round(action.durationMs ?? 260));
      const args = [
        "-s",
        deviceId,
        "shell",
        "input",
        "swipe",
        String(Math.max(0, Math.round(action.x1))),
        String(Math.max(0, Math.round(action.y1))),
        String(Math.max(0, Math.round(action.x2))),
        String(Math.max(0, Math.round(action.y2))),
        String(durationMs),
      ];
      this.emulator.runAdb(args);
      return `Swipe sent to ${deviceId}.`;
    }

    if (action.type === "type") {
      const text = String(action.text || "");
      if (!text.trim()) {
        throw new Error("Text input is empty.");
      }
      return this.emulator.typeText(text, deviceId);
    }

    const keycode = String(action.keycode || "").trim();
    if (!keycode) {
      throw new Error("Keycode is required.");
    }
    this.emulator.runAdb(["-s", deviceId, "shell", "input", "keyevent", keycode]);
    return `Keyevent ${keycode} sent to ${deviceId}.`;
  }
}
