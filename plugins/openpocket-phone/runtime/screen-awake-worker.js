#!/usr/bin/env node

// src/device/screen-awake-worker.ts
import { execFileSync } from "node:child_process";
var timer = null;
function parseParams(argv) {
  const raw = String(argv[2] ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const adbPath = String(parsed.adbPath ?? "").trim();
    if (!adbPath) {
      return null;
    }
    const intervalMs = Math.max(1e3, Math.round(Number(parsed.intervalMs ?? 3e3)));
    const preferredDeviceIdRaw = String(parsed.preferredDeviceId ?? "").trim();
    const adbEndpointRaw = String(parsed.adbEndpoint ?? "").trim();
    return {
      adbPath,
      preferredDeviceId: preferredDeviceIdRaw ? preferredDeviceIdRaw : null,
      adbEndpoint: adbEndpointRaw ? adbEndpointRaw : null,
      targetType: String(parsed.targetType ?? ""),
      intervalMs
    };
  } catch {
    return null;
  }
}
function runAdb(adbPath, args, timeoutMs = 8e3) {
  try {
    return execFileSync(adbPath, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch {
    return "";
  }
}
function listOnlineDevices(adbPath) {
  const output = runAdb(adbPath, ["devices"], 6e3);
  if (!output.trim()) {
    return [];
  }
  const devices = [];
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
function ensureEndpointConnected(params) {
  if (!params.adbEndpoint || params.targetType === "emulator") {
    return;
  }
  runAdb(params.adbPath, ["connect", params.adbEndpoint], 8e3);
}
function resolveDeviceId(params) {
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
function pulseScreenAwake(params) {
  const deviceId = resolveDeviceId(params);
  if (!deviceId) {
    return;
  }
  runAdb(params.adbPath, ["-s", deviceId, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], 8e3);
}
function shutdown(code = 0) {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  process.exit(code);
}
function main() {
  const params = parseParams(process.argv);
  if (!params) {
    shutdown(1);
    return;
  }
  pulseScreenAwake(params);
  timer = setInterval(() => {
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
