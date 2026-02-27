import type { DeviceTargetType } from "../types.js";
import { shouldIncludeDeviceForTarget } from "./target-types.js";

export type AdbConnectionType = "usb" | "wifi" | "emulator" | "unknown";

export type AdbDeviceDescriptor = {
  deviceId: string;
  state: string;
  attributes: Record<string, string>;
  connectionType: AdbConnectionType;
  endpoint: string | null;
  model: string;
  product: string;
  device: string;
  transportId: string;
};

function parseAdbAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /(?:^|\s)([A-Za-z0-9._-]+):([^\s]+)/g;
  let matched = attrRe.exec(raw);
  while (matched) {
    const key = String(matched[1] ?? "").trim();
    const value = String(matched[2] ?? "").trim();
    if (key) {
      attrs[key] = value;
    }
    matched = attrRe.exec(raw);
  }
  return attrs;
}

function looksLikeNetworkSerial(deviceId: string): boolean {
  if (!deviceId.includes(":")) {
    return false;
  }
  if (/^\[[0-9a-fA-F:]+\]:\d+$/.test(deviceId)) {
    return true;
  }
  if (/^[^:\s]+:\d+$/.test(deviceId)) {
    return true;
  }
  return false;
}

function detectConnectionType(deviceId: string, attrs: Record<string, string>): AdbConnectionType {
  if (deviceId.startsWith("emulator-")) {
    return "emulator";
  }
  if (typeof attrs.usb === "string" && attrs.usb.trim().length > 0) {
    return "usb";
  }
  if (looksLikeNetworkSerial(deviceId)) {
    return "wifi";
  }
  return "unknown";
}

function normalizeEndpoint(deviceId: string, connectionType: AdbConnectionType): string | null {
  if (connectionType !== "wifi") {
    return null;
  }
  if (!deviceId.includes(":")) {
    return `${deviceId}:5555`;
  }
  return deviceId;
}

export function parseAdbDevicesLongOutput(output: string): AdbDeviceDescriptor[] {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const devices: AdbDeviceDescriptor[] = [];
  for (const line of lines) {
    if (line.toLowerCase().startsWith("list of devices attached")) {
      continue;
    }
    if (line.startsWith("*")) {
      continue;
    }
    const matched = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!matched?.[1] || !matched[2]) {
      continue;
    }
    const deviceId = matched[1];
    const state = matched[2];
    const attrs = parseAdbAttributes(matched[3] ?? "");
    const connectionType = detectConnectionType(deviceId, attrs);
    devices.push({
      deviceId,
      state,
      attributes: attrs,
      connectionType,
      endpoint: normalizeEndpoint(deviceId, connectionType),
      model: String(attrs.model ?? ""),
      product: String(attrs.product ?? ""),
      device: String(attrs.device ?? ""),
      transportId: String(attrs.transport_id ?? ""),
    });
  }
  return devices;
}

export function filterOnlineTargetAdbDevices(
  devices: AdbDeviceDescriptor[],
  targetType: DeviceTargetType,
): AdbDeviceDescriptor[] {
  return devices.filter(
    (item) => item.state === "device" && shouldIncludeDeviceForTarget(targetType, item.deviceId),
  );
}

export function adbConnectionLabel(connectionType: AdbConnectionType): string {
  switch (connectionType) {
    case "usb":
      return "USB ADB";
    case "wifi":
      return "WiFi ADB";
    case "emulator":
      return "Emulator ADB";
    default:
      return "ADB";
  }
}

