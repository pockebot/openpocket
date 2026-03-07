import type { OpenPocketConfig } from "../types.js";
import { normalizeDeviceTargetType } from "../device/target-types.js";

function normalizeAdbEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes(":")) {
    return trimmed;
  }
  return `${trimmed}:5555`;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export function computeTargetFingerprint(config: OpenPocketConfig): string {
  const targetType = normalizeDeviceTargetType(config.target.type);
  if (targetType === "emulator") {
    const avdName = firstNonEmpty(config.emulator.avdName, "OpenPocket_AVD");
    return `emulator:${avdName}`;
  }

  if (targetType === "cloud") {
    const identity = firstNonEmpty(
      config.target.cloudProvider,
      config.agent.deviceId,
      normalizeAdbEndpoint(config.target.adbEndpoint),
    );
    if (!identity) {
      return "cloud:unassigned";
    }
    return `cloud:${identity}`;
  }

  const deviceId = firstNonEmpty(config.agent.deviceId);
  if (deviceId) {
    return `${targetType}:${deviceId}`;
  }

  const endpoint = normalizeAdbEndpoint(config.target.adbEndpoint);
  if (endpoint) {
    return `${targetType}:adb:${endpoint}`;
  }

  return `${targetType}:unassigned`;
}
