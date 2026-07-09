import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OpenPocketConfig } from "../types.js";
import { normalizeDeviceTargetType } from "../device/target-types.js";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function openPocketHome(): string {
  const configured = String(process.env.OPENPOCKET_HOME ?? "").trim();
  return path.resolve(expandHome(configured || path.join(os.homedir(), ".openpocket")));
}

function defaultConfigPath(): string {
  return path.join(openPocketHome(), "config.json");
}

function defaultPhoneConfig(configPath: string): JsonObject {
  const home = path.dirname(configPath);
  return {
    projectName: "OpenPocket",
    stateDir: path.join(home, "state"),
    target: {
      type: "emulator",
      adbEndpoint: "",
      pin: "1234",
      wakeupIntervalSec: 3,
      cloudProvider: "",
    },
    emulator: {
      avdName: "OpenPocket_AVD",
      androidSdkRoot: process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "",
      headless: false,
      bootTimeoutSec: 180,
      dataPartitionSizeGb: 24,
      extraArgs: [],
    },
    agent: {
      deviceId: null,
    },
  };
}

function readConfig(configPath: string): JsonObject {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    const initial = defaultPhoneConfig(configPath);
    fs.writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    return initial;
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenPocket config must contain a JSON object: ${configPath}`);
  }
  return parsed as JsonObject;
}

export function loadPhoneRuntimeConfig(configPath?: string): OpenPocketConfig {
  const resolvedConfigPath = path.resolve(expandHome(configPath || defaultConfigPath()));
  const raw = readConfig(resolvedConfigPath);
  const target = objectValue(raw.target);
  const emulator = objectValue(raw.emulator);
  const agent = objectValue(raw.agent);
  const defaultStateDir = path.join(path.dirname(resolvedConfigPath), "state");

  const normalized = {
    ...raw,
    configPath: resolvedConfigPath,
    stateDir: path.resolve(expandHome(stringValue(raw.stateDir, defaultStateDir))),
    target: {
      ...target,
      type: normalizeDeviceTargetType(target.type),
      adbEndpoint: stringValue(target.adbEndpoint, ""),
      pin: stringValue(target.pin, "1234"),
      wakeupIntervalSec: numberValue(target.wakeupIntervalSec, 3),
      cloudProvider: stringValue(target.cloudProvider, ""),
    },
    emulator: {
      ...emulator,
      avdName: stringValue(emulator.avdName, "OpenPocket_AVD"),
      androidSdkRoot: stringValue(
        emulator.androidSdkRoot,
        process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "",
      ),
      headless: booleanValue(emulator.headless, false),
      bootTimeoutSec: numberValue(emulator.bootTimeoutSec, 180),
      dataPartitionSizeGb: numberValue(emulator.dataPartitionSizeGb, 24),
      extraArgs: Array.isArray(emulator.extraArgs)
        ? emulator.extraArgs.map((value) => String(value))
        : [],
    },
    agent: {
      ...agent,
      deviceId: typeof agent.deviceId === "string" && agent.deviceId.trim()
        ? agent.deviceId.trim()
        : null,
    },
  };

  fs.mkdirSync(normalized.stateDir, { recursive: true });
  return normalized as unknown as OpenPocketConfig;
}
