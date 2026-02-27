#!/usr/bin/env node

import { execFileSync } from "node:child_process";

type ScreenAwakeWorkerParams = {
  adbPath: string;
  preferredDeviceId: string | null;
  adbEndpoint: string | null;
  targetType: string;
  intervalMs: number;
};

let timer: ReturnType<typeof setInterval> | null = null;

function parseParams(argv: string[]): ScreenAwakeWorkerParams | null {
  const raw = String(argv[2] ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ScreenAwakeWorkerParams>;
    const adbPath = String(parsed.adbPath ?? "").trim();
    if (!adbPath) {
      return null;
    }
    const intervalMs = Math.max(1_000, Math.round(Number(parsed.intervalMs ?? 3_000)));
    const preferredDeviceIdRaw = String(parsed.preferredDeviceId ?? "").trim();
    const adbEndpointRaw = String(parsed.adbEndpoint ?? "").trim();
    return {
      adbPath,
      preferredDeviceId: preferredDeviceIdRaw ? preferredDeviceIdRaw : null,
      adbEndpoint: adbEndpointRaw ? adbEndpointRaw : null,
      targetType: String(parsed.targetType ?? ""),
      intervalMs,
    };
  } catch {
    return null;
  }
}

function runAdb(adbPath: string, args: string[], timeoutMs = 8_000): string {
  try {
    return execFileSync(adbPath, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function listOnlineDevices(adbPath: string): string[] {
  const output = runAdb(adbPath, ["devices"], 6_000);
  if (!output.trim()) {
    return [];
  }
  const devices: string[] = [];
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(1)) {
    const [serial, state] = line.split(/\s+/);
    if (!serial || state !== "device") {
      continue;
    }
    devices.push(serial);
  }
  return devices;
}

function ensureEndpointConnected(params: ScreenAwakeWorkerParams): void {
  if (!params.adbEndpoint || params.targetType === "emulator") {
    return;
  }
  runAdb(params.adbPath, ["connect", params.adbEndpoint], 8_000);
}

function resolveDeviceId(params: ScreenAwakeWorkerParams): string | null {
  ensureEndpointConnected(params);
  const devices = listOnlineDevices(params.adbPath);
  if (devices.length === 0) {
    return null;
  }
  if (params.preferredDeviceId && devices.includes(params.preferredDeviceId)) {
    return params.preferredDeviceId;
  }
  return devices[0] ?? null;
}

function pulseScreenAwake(params: ScreenAwakeWorkerParams): void {
  const deviceId = resolveDeviceId(params);
  if (!deviceId) {
    return;
  }
  runAdb(params.adbPath, ["-s", deviceId, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], 8_000);
}

function shutdown(code = 0): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  process.exit(code);
}

function main(): void {
  const params = parseParams(process.argv);
  if (!params) {
    shutdown(1);
    return;
  }

  pulseScreenAwake(params);
  timer = setInterval(() => {
    // Parent process is gone; stop worker to avoid orphan keep-alive process.
    if (process.ppid === 1) {
      shutdown(0);
      return;
    }
    pulseScreenAwake(params);
  }, params.intervalMs);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
process.on("uncaughtException", () => shutdown(1));

main();
