import type { DeviceTargetType } from "../types.js";

export const DEVICE_TARGET_TYPES: DeviceTargetType[] = [
  "emulator",
  "physical-phone",
  "android-tv",
  "cloud",
];

export function isDeviceTargetType(value: string): value is DeviceTargetType {
  return DEVICE_TARGET_TYPES.includes(value as DeviceTargetType);
}

export function normalizeDeviceTargetType(value: unknown): DeviceTargetType {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (isDeviceTargetType(normalized)) {
    return normalized;
  }
  return "emulator";
}

export function deviceTargetLabel(type: DeviceTargetType): string {
  switch (type) {
    case "emulator":
      return "Emulator";
    case "physical-phone":
      return "Physical Phone";
    case "android-tv":
      return "Android TV";
    case "cloud":
      return "Cloud";
    default:
      return "Unknown";
  }
}

export function isEmulatorTarget(type: DeviceTargetType): boolean {
  return type === "emulator";
}

export function isEmulatorSerial(deviceId: string): boolean {
  return deviceId.startsWith("emulator-");
}

export function shouldIncludeDeviceForTarget(type: DeviceTargetType, deviceId: string): boolean {
  if (type === "emulator") {
    return isEmulatorSerial(deviceId);
  }
  if (type === "cloud") {
    return true;
  }
  return !isEmulatorSerial(deviceId);
}

