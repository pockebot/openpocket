#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";

import { AgentRuntime } from "./agent/agent-runtime.js";
import { loadConfig, saveConfig } from "./config/index.js";
import { EmulatorManager } from "./device/emulator-manager.js";
import { TelegramGateway } from "./gateway/telegram-gateway.js";
import { runGatewayLoop } from "./gateway/run-loop.js";
import { DashboardServer, type DashboardGatewayStatus } from "./dashboard/server.js";
import { HumanAuthBridge } from "./human-auth/bridge.js";
import { LocalHumanAuthStack } from "./human-auth/local-stack.js";
import { HumanAuthRelayServer } from "./human-auth/relay-server.js";
import { LocalHumanAuthTakeoverRuntime } from "./human-auth/takeover-runtime.js";
import { SkillLoader } from "./skills/skill-loader.js";
import { ScriptExecutor } from "./tools/script-executor.js";
import { runSetupWizard } from "./onboarding/setup-wizard.js";
import { installCliShortcut } from "./install/cli-shortcut.js";
import { ensureAndroidPrerequisites } from "./environment/android-prerequisites.js";
import { PermissionLabManager } from "./test/permission-lab.js";
import { createCliTheme, createOpenPocketBanner, type CliStepStatus, type CliTone } from "./utils/cli-theme.js";
import type { OpenPocketConfig } from "./types.js";
import {
  deviceTargetLabel,
  isDeviceTargetType,
  isEmulatorTarget,
  normalizeDeviceTargetType,
} from "./device/target-types.js";
import {
  adbConnectionLabel,
  filterOnlineTargetAdbDevices,
  type AdbConnectionType,
  parseAdbDevicesLongOutput,
} from "./device/adb-device-discovery.js";

const cliTheme = createCliTheme(output);
const DEFAULT_ONBOARD_AVD_DATA_PARTITION_SIZE_GB = 24;

function printRaw(message = ""): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

function printInfo(message: string): void {
  printRaw(cliTheme.info(message));
}

function printSuccess(message: string): void {
  printRaw(cliTheme.success(message));
}

function printWarn(message: string): void {
  printRaw(cliTheme.warn(message));
}

function printKeyValue(key: string, value: string, tone: CliTone = "plain"): void {
  printRaw(cliTheme.kv(key, value, tone));
}

function printStep(step: number, total: number, title: string, status: CliStepStatus, detail: string): void {
  printRaw(cliTheme.step(step, total, title, status, detail));
}

function shouldSuppressRuntimeLine(line: string): boolean {
  const normalized = line.toLowerCase();
  const isHeartbeat = normalized.includes("[heartbeat]");
  const isWarning = normalized.includes("[warn]");
  return isHeartbeat && !isWarning;
}

function printRuntimeLine(line: string): void {
  if (shouldSuppressRuntimeLine(line)) {
    return;
  }
  printRaw(cliTheme.classifyRuntimeLine(line));
}

function printHelp(): void {
  printRaw(`${cliTheme.emphasize("OpenPocket CLI (Node.js + TypeScript)", "accent")}\n
Usage:
  openpocket [--config <path>] install-cli
  openpocket [--config <path>] onboard [--force] [--target <type>]
  openpocket [--config <path>] config-show
  openpocket [--config <path>] target show
  openpocket [--config <path>] target set|set-target|config --type <emulator|physical-phone|android-tv|cloud> [--device <id>] [--adb-endpoint <host[:port]>] [--pin <4-digit>] [--wakeup-interval <sec>]
  openpocket [--config <path>] target pair [--host <ip>] [--pair-port <port>] [--connect-port <port>] [--code <pairing-code>] [--type <physical-phone|android-tv>] [--device <id|auto>] [--dry-run]
  openpocket [--config <path>] emulator status
  openpocket [--config <path>] emulator start
  openpocket [--config <path>] emulator stop
  openpocket [--config <path>] emulator hide
  openpocket [--config <path>] emulator show
  openpocket [--config <path>] emulator list-avds
  openpocket [--config <path>] emulator screenshot [--out <path>]
  openpocket [--config <path>] emulator tap --x <int> --y <int> [--device <id>]
  openpocket [--config <path>] emulator type --text <text> [--device <id>]
  openpocket [--config <path>] agent [--model <name>] <task>
  openpocket [--config <path>] skills list
  openpocket [--config <path>] script run [--file <path> | --text <script>] [--timeout <sec>]
  openpocket [--config <path>] telegram setup|whoami
  openpocket [--config <path>] gateway [start|telegram]
  openpocket [--config <path>] dashboard start [--host <host>] [--port <port>]
  openpocket [--config <path>] test permission-app [deploy|install|launch|reset|uninstall|task|run|cases] [--device <id>] [--clean] [--case <id>] [--send] [--chat <id>] [--model <name>]
  openpocket [--config <path>] human-auth-relay start [--host <host>] [--port <port>] [--public-base-url <url>] [--api-key <key>] [--state-file <path>]

Legacy aliases (deprecated):
  openpocket [--config <path>] init
  openpocket [--config <path>] setup

Examples:
  openpocket onboard
  openpocket onboard --target physical-phone
  openpocket onboard --force
  openpocket target set --type physical-phone --pin 1234
  openpocket target set-target --type physical-phone
  openpocket target set --type emulator --pin 1234
  openpocket target set --wakeup-interval 3
  openpocket target set --type physical-phone --adb-endpoint 192.168.1.25:5555
  openpocket target set --type physical-phone --device R5CX123456A --pin 1234
  openpocket target pair --host 192.168.1.66 --pair-port 37099 --code 123456 --type android-tv
  openpocket emulator start
  openpocket emulator tap --x 120 --y 300
  openpocket agent --model gpt-5.2-codex "Open Chrome and search weather"
  openpocket skills list
  openpocket script run --text "echo hello"
  openpocket telegram setup
  openpocket telegram whoami
  openpocket gateway start
  openpocket dashboard start
  openpocket test permission-app deploy
  openpocket test permission-app task
  openpocket test permission-app cases
  openpocket test permission-app task --case camera --send --chat <id>
  openpocket human-auth-relay start --port 8787
`);
}

type CliChildProcessError = Error & {
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
};

function formatCliError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const childError = error as CliChildProcessError;
  const toText = (value: unknown): string => {
    if (value === null || value === undefined) {
      return "";
    }
    if (Buffer.isBuffer(value)) {
      return value.toString("utf-8").trim().slice(0, 600);
    }
    if (typeof value === "string") {
      return value.trim().slice(0, 600);
    }
    return "";
  };
  const parts = [error.message];
  const stderr = toText(childError.stderr);
  const stdout = toText(childError.stdout);
  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }
  if (stdout) {
    parts.push(`stdout: ${stdout}`);
  }
  if (typeof childError.status === "number") {
    parts.push(`exitCode: ${String(childError.status)}`);
  }
  if (childError.signal) {
    parts.push(`signal: ${childError.signal}`);
  }
  return parts.join("\n");
}

function openUrlInBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawnSync("/usr/bin/open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "linux") {
    spawnSync("xdg-open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", shell: false });
  }
}

function findGatewayProcessPids(): number[] {
  if (process.env.OPENPOCKET_SKIP_GATEWAY_PID_CHECK === "1") {
    return [];
  }

  const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if ((ps.status ?? 1) !== 0 || !ps.stdout) {
    return [];
  }

  const currentPid = process.pid;
  const matches: number[] = [];
  for (const rawLine of ps.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid === currentPid) {
      continue;
    }
    const command = match[2].toLowerCase();
    if (!command.includes("gateway start")) {
      continue;
    }
    if (
      command.includes("openpocket")
      || command.includes("/dist/cli.js")
      || command.includes("/src/cli.ts")
    ) {
      matches.push(pid);
    }
  }

  return [...new Set(matches)].sort((a, b) => a - b);
}

function standaloneDashboardGatewayStatus(): DashboardGatewayStatus {
  const pids = findGatewayProcessPids();
  return {
    running: pids.length > 0,
    managed: false,
    note: pids.length > 0 ? `detected gateway pid(s): ${pids.join(", ")}` : "no gateway process detected",
  };
}

function takeOption(args: string[], name: string): { value: string | null; rest: string[] } {
  const out: string[] = [];
  let value: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      if (i + 1 >= args.length) {
        throw new Error(`Option ${name} requires a value.`);
      }
      value = args[i + 1];
      i += 1;
      continue;
    }
    out.push(args[i]);
  }

  return { value, rest: out };
}

async function runEmulatorCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const cfg = loadConfig(configPath);
  const emulatorConfig = JSON.parse(JSON.stringify(cfg)) as OpenPocketConfig;
  emulatorConfig.target.type = "emulator";
  emulatorConfig.target.adbEndpoint = "";
  const emulator = new EmulatorManager(emulatorConfig);
  const sub = args[0];

  if (!sub) {
    throw new Error("Missing emulator subcommand.");
  }

  if (sub === "status") {
    printRaw(cliTheme.section("Emulator Status"));
    printRaw(JSON.stringify(emulator.status(), null, 2));
    return 0;
  }
  if (sub === "start") {
    printSuccess(await emulator.start());
    return 0;
  }
  if (sub === "stop") {
    printSuccess(emulator.stop());
    return 0;
  }
  if (sub === "hide") {
    printInfo(await emulator.ensureHiddenBackground());
    return 0;
  }
  if (sub === "show") {
    printInfo(await emulator.ensureWindowVisible());
    return 0;
  }
  if (sub === "list-avds") {
    printRaw(cliTheme.section("Available AVDs"));
    for (const avd of emulator.listAvds()) {
      printRaw(`- ${avd}`);
    }
    return 0;
  }
  if (sub === "screenshot") {
    const { value: outPath, rest: afterOut } = takeOption(args.slice(1), "--out");
    const { value: deviceId, rest } = takeOption(afterOut, "--device");
    if (rest.length > 0) {
      throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
    }
    printSuccess(emulator.captureScreenshot(outPath ?? undefined, deviceId ?? undefined));
    return 0;
  }
  if (sub === "tap") {
    const { value: xRaw, rest: afterX } = takeOption(args.slice(1), "--x");
    const { value: yRaw, rest: afterY } = takeOption(afterX, "--y");
    const { value: deviceId, rest } = takeOption(afterY, "--device");
    if (rest.length > 0) {
      throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
    }
    if (xRaw === null || yRaw === null) {
      throw new Error("Usage: openpocket emulator tap --x <int> --y <int> [--device <id>]");
    }
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Tap coordinates must be numbers.");
    }
    printInfo(emulator.tap(Math.round(x), Math.round(y), deviceId ?? undefined));
    return 0;
  }
  if (sub === "type") {
    const { value: text, rest: afterText } = takeOption(args.slice(1), "--text");
    const { value: deviceId, rest } = takeOption(afterText, "--device");
    if (rest.length > 0) {
      throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
    }
    if (text === null) {
      throw new Error("Usage: openpocket emulator type --text <text> [--device <id>]");
    }
    printInfo(emulator.typeText(text, deviceId ?? undefined));
    return 0;
  }

  throw new Error(`Unknown emulator subcommand: ${sub}`);
}

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

function normalizeFourDigitPin(raw: string, optionName: string): string {
  const normalized = raw.trim();
  if (!/^\d{4}$/.test(normalized)) {
    throw new Error(`${optionName} expects exactly 4 digits.`);
  }
  return normalized;
}

function normalizeWakeupIntervalSec(raw: string, optionName: string): number {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`${optionName} expects a number in seconds.`);
  }
  const normalized = Math.round(parsed);
  if (normalized < 1 || normalized > 3600) {
    throw new Error(`${optionName} must be within 1-3600 seconds.`);
  }
  return normalized;
}

function maskFourDigitPin(raw: string): string {
  const normalized = raw.trim();
  if (!/^\d{4}$/.test(normalized)) {
    return "(unset)";
  }
  return "**** (configured)";
}

function printTargetSummary(cfg: OpenPocketConfig): void {
  printRaw(cliTheme.section("Deployment Target"));
  printKeyValue("Type", `${cfg.target.type} (${deviceTargetLabel(cfg.target.type)})`, "accent");
  printKeyValue("Preferred device", cfg.agent.deviceId?.trim() || "(auto)");
  printKeyValue("ADB endpoint", cfg.target.adbEndpoint.trim() || "(none)");
  printKeyValue("Phone PIN", maskFourDigitPin(cfg.target.pin), "warn");
  printKeyValue("Wakeup interval", `${Math.max(1, Math.round(cfg.target.wakeupIntervalSec))}s`);
  printKeyValue("Cloud provider", cfg.target.cloudProvider.trim() || "(none)");
}

function ensureGatewayStoppedForTargetSwitch(): void {
  const pids = findGatewayProcessPids();
  if (pids.length > 0) {
    throw new Error(
      `Gateway is running (pid: ${pids.join(", ")}). Stop it before switching deployment target.`,
    );
  }
}

type ConnectedTargetDevice = {
  deviceId: string;
  hint: string;
  connectionType: AdbConnectionType;
  endpoint: string | null;
};

type HostAndPort = {
  host: string;
  port: number;
};

function adbDeviceProp(
  emulator: EmulatorManager,
  deviceId: string,
  prop: string,
): string {
  try {
    return String(
      emulator.runAdb(["-s", deviceId, "shell", "getprop", prop], 4_000),
    ).trim();
  } catch {
    return "";
  }
}

function discoverConnectedTargetDevices(cfg: OpenPocketConfig): ConnectedTargetDevice[] {
  const runtimeConfig = JSON.parse(JSON.stringify(cfg)) as OpenPocketConfig;
  const emulator = new EmulatorManager(runtimeConfig);
  let rawDevices = "";
  try {
    rawDevices = emulator.runAdb(["devices", "-l"], 10_000);
  } catch (error) {
    printWarn(`Unable to query adb device list: ${(error as Error).message}`);
    return [];
  }
  const targetType = normalizeDeviceTargetType(cfg.target.type);
  const descriptors = filterOnlineTargetAdbDevices(
    parseAdbDevicesLongOutput(rawDevices),
    targetType,
  );
  const toOrder = (connectionType: AdbConnectionType): number => {
    if (connectionType === "usb") return 0;
    if (connectionType === "wifi") return 1;
    if (connectionType === "unknown") return 2;
    return 3;
  };
  return descriptors
    .map((descriptor) => {
      const deviceId = descriptor.deviceId;
      const manufacturer = adbDeviceProp(emulator, deviceId, "ro.product.manufacturer");
      const model = adbDeviceProp(emulator, deviceId, "ro.product.model") || descriptor.model;
      const release = adbDeviceProp(emulator, deviceId, "ro.build.version.release");
      const pieces = [manufacturer, model].map((v) => v.trim()).filter(Boolean);
      const modelText = pieces.length > 0 ? pieces.join(" ") : "Unknown model";
      const versionText = release ? `Android ${release}` : "Android (unknown)";
      return {
        deviceId,
        hint: `${adbConnectionLabel(descriptor.connectionType)} | ${modelText} | ${versionText}`,
        connectionType: descriptor.connectionType,
        endpoint: descriptor.endpoint,
      };
    })
    .sort((a, b) => {
      const byTransport = toOrder(a.connectionType) - toOrder(b.connectionType);
      if (byTransport !== 0) {
        return byTransport;
      }
      return a.deviceId.localeCompare(b.deviceId);
    });
}

async function chooseTargetDeviceId(
  candidates: ConnectedTargetDevice[],
  configuredDeviceId: string | null,
): Promise<ConnectedTargetDevice | null> {
  const configured = configuredDeviceId?.trim() || "";
  const configuredFallback = configured
    ? {
      deviceId: configured,
      hint: "Configured serial (not currently online)",
      connectionType: "unknown" as AdbConnectionType,
      endpoint: null,
    }
    : null;
  if (candidates.length === 0) {
    printWarn("No online adb device detected for this target. Keep preferred device as auto mode.");
    return configuredFallback;
  }
  if (candidates.length === 1) {
    const only = candidates[0];
    printInfo(`Detected one device and selected it automatically: ${only.deviceId} (${only.hint})`);
    return only;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printWarn(
      `Detected ${candidates.length} devices, but current shell is non-interactive; keep preferred device as auto mode.`,
    );
    return candidates.find((item) => item.deviceId === configured) ?? configuredFallback;
  }

  const autoValue = "__auto__";
  const options: CliSelectOption<string>[] = [
    {
      value: autoValue,
      label: "Auto-select device at runtime",
      hint: "No fixed serial in config",
    },
    ...candidates.map((item) => ({
      value: item.deviceId,
      label: `[${adbConnectionLabel(item.connectionType)}] ${item.deviceId}`,
      hint: item.hint,
    })),
  ];
  const initial = candidates.some((item) => item.deviceId === configured)
    ? configured
    : autoValue;

  const rl = createInterface({ input, output });
  try {
    const selected = await selectByArrowKeys(
      rl,
      "Choose preferred target device",
      options,
      initial,
    );
    if (selected === autoValue) {
      return null;
    }
    return candidates.find((item) => item.deviceId === selected) ?? null;
  } finally {
    if (input.setRawMode) {
      try {
        input.setRawMode(false);
      } catch {
        // Ignore raw mode reset errors.
      }
    }
    input.pause();
    rl.close();
  }
}

function normalizePort(raw: string, optionName: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`${optionName} expects a numeric TCP port.`);
  }
  const port = Math.round(value);
  if (port < 1 || port > 65535) {
    throw new Error(`${optionName} must be between 1 and 65535.`);
  }
  return port;
}

function parseHostAndPort(raw: string, optionName: string): HostAndPort {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new Error(`${optionName} cannot be empty.`);
  }

  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6?.[1] && ipv6[2]) {
    return {
      host: ipv6[1],
      port: normalizePort(ipv6[2], optionName),
    };
  }

  const index = value.lastIndexOf(":");
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`${optionName} must be in host:port format.`);
  }
  const host = value.slice(0, index).trim();
  const portRaw = value.slice(index + 1).trim();
  if (!host) {
    throw new Error(`${optionName} host is empty.`);
  }
  return {
    host,
    port: normalizePort(portRaw, optionName),
  };
}

function normalizeHost(raw: string, optionName: string): string {
  const host = raw.trim();
  if (!host) {
    throw new Error(`${optionName} cannot be empty.`);
  }
  if (/\s/.test(host)) {
    throw new Error(`${optionName} cannot include spaces.`);
  }
  return host;
}

async function promptTextInput(
  rl: Interface,
  message: string,
  initialValue = "",
  required = false,
): Promise<string> {
  while (true) {
    const suffix = initialValue.trim() ? ` [${initialValue.trim()}]` : "";
    const answer = String(
      await rl.question(
        `${cliTheme.paint("[INPUT]", "warn")} ${message}${suffix}: `,
      ),
    ).trim();
    const value = answer || initialValue.trim();
    if (!required || value) {
      return value;
    }
    printWarn("Input cannot be empty.");
  }
}

async function runTargetPairCommand(configPath: string | undefined, args: string[]): Promise<number> {
  ensureGatewayStoppedForTargetSwitch();

  const dryRun = args.includes("--dry-run");
  const withoutDryRun = args.filter((item) => item !== "--dry-run");
  const { value: pairEndpointRaw, rest: afterPairEndpoint } = takeOption(withoutDryRun, "--pair-endpoint");
  const { value: connectEndpointRaw, rest: afterConnectEndpoint } = takeOption(afterPairEndpoint, "--connect-endpoint");
  const { value: hostRaw, rest: afterHost } = takeOption(afterConnectEndpoint, "--host");
  const { value: pairPortRaw, rest: afterPairPort } = takeOption(afterHost, "--pair-port");
  const { value: connectPortRaw, rest: afterConnectPort } = takeOption(afterPairPort, "--connect-port");
  const { value: codeRaw, rest: afterCode } = takeOption(afterConnectPort, "--code");
  const { value: typeRaw, rest: afterType } = takeOption(afterCode, "--type");
  const { value: deviceRaw, rest } = takeOption(afterType, "--device");
  if (rest.length > 0) {
    throw new Error(`Unexpected target pair arguments: ${rest.join(" ")}`);
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let host = hostRaw ? normalizeHost(hostRaw, "--host") : "";
  let pairingPort = pairPortRaw ? normalizePort(pairPortRaw, "--pair-port") : 0;
  let connectPort = connectPortRaw ? normalizePort(connectPortRaw, "--connect-port") : 5555;
  let code = String(codeRaw ?? "").trim();

  if (pairEndpointRaw !== null) {
    const parsed = parseHostAndPort(pairEndpointRaw, "--pair-endpoint");
    host = parsed.host;
    pairingPort = parsed.port;
  }
  if (connectEndpointRaw !== null) {
    const parsed = parseHostAndPort(connectEndpointRaw, "--connect-endpoint");
    host = parsed.host;
    connectPort = parsed.port;
  }

  if ((!host || !pairingPort || !code) && interactive) {
    const rl = createInterface({ input, output });
    try {
      if (!host) {
        host = normalizeHost(
          await promptTextInput(rl, "ADB host/IP (for example 192.168.1.25)", "", true),
          "--host",
        );
      }
      if (!pairingPort) {
        pairingPort = normalizePort(
          await promptTextInput(rl, "ADB pairing port from TV/phone (for example 37099)", "", true),
          "--pair-port",
        );
      }
      connectPort = normalizePort(
        await promptTextInput(rl, "ADB connect port", String(connectPort || 5555), true),
        "--connect-port",
      );
      if (!code) {
        code = await promptTextInput(rl, "Pairing code", "", true);
      }
    } finally {
      rl.close();
    }
  }

  if (!host) {
    throw new Error("Missing host. Use --host <ip> or --pair-endpoint <host:port>.");
  }
  if (!pairingPort) {
    throw new Error("Missing pairing port. Use --pair-port <port> or --pair-endpoint <host:port>.");
  }
  if (!code) {
    throw new Error("Missing pairing code. Use --code <code>.");
  }

  const cfg = loadConfig(configPath);
  if (typeRaw !== null) {
    const normalized = normalizeDeviceTargetType(typeRaw);
    if (normalized !== "physical-phone" && normalized !== "android-tv") {
      throw new Error("target pair --type only supports: physical-phone | android-tv");
    }
    cfg.target.type = normalized;
  } else if (cfg.target.type !== "physical-phone" && cfg.target.type !== "android-tv") {
    cfg.target.type = "physical-phone";
  }

  const pairEndpoint = `${host}:${pairingPort}`;
  const connectEndpoint = `${host}:${connectPort}`;
  const runtimeConfig = JSON.parse(JSON.stringify(cfg)) as OpenPocketConfig;
  const emulator = new EmulatorManager(runtimeConfig);

  if (dryRun) {
    printWarn(`[dry-run] skip: adb pair ${pairEndpoint} <code>`);
    printWarn(`[dry-run] skip: adb connect ${connectEndpoint}`);
  } else {
    printInfo(`Pairing with ${pairEndpoint}...`);
    const pairOutput = emulator.runAdb(["pair", pairEndpoint, code], 20_000).trim();
    printInfo(pairOutput || "adb pair completed.");
    printInfo(`Connecting to ${connectEndpoint}...`);
    const connectOutput = emulator.runAdb(["connect", connectEndpoint], 20_000).trim();
    printInfo(connectOutput || "adb connect completed.");
  }

  cfg.target.adbEndpoint = connectEndpoint;
  if (deviceRaw !== null) {
    const normalized = deviceRaw.trim().toLowerCase();
    if (!normalized || normalized === "auto") {
      cfg.agent.deviceId = null;
    } else {
      cfg.agent.deviceId = deviceRaw.trim();
    }
  } else {
    cfg.agent.deviceId = connectEndpoint;
  }
  saveConfig(cfg);

  printSuccess("ADB pairing flow completed.");
  printTargetSummary(cfg);
  return 0;
}

async function runTargetCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const rawSub = (args[0] ?? "show").trim();
  const sub = rawSub === "set-target" || rawSub === "config" ? "set" : rawSub;
  if (rawSub === "pair") {
    return runTargetPairCommand(configPath, args.slice(1));
  }
  if (sub !== "show" && sub !== "set") {
    throw new Error(`Unknown target subcommand: ${rawSub}. Use: target show|set|set-target|config|pair`);
  }

  const cfg = loadConfig(configPath);
  if (sub === "show") {
    printTargetSummary(cfg);
    return 0;
  }

  ensureGatewayStoppedForTargetSwitch();

  const clearDevice = args.includes("--clear-device");
  const clearAdbEndpoint = args.includes("--clear-adb-endpoint");
  const clearPin = args.includes("--clear-pin");
  const clearWakeupInterval = args.includes("--clear-wakeup-interval");
  // Backward-compatible aliases for older CLI flags.
  const clearVirtualPin = args.includes("--clear-virtual-pin");
  const clearPhysicalPin = args.includes("--clear-physical-pin");
  const withoutFlags = args.filter(
    (item) =>
      item !== "--clear-device"
      && item !== "--clear-adb-endpoint"
      && item !== "--clear-pin"
      && item !== "--clear-wakeup-interval"
      && item !== "--clear-virtual-pin"
      && item !== "--clear-physical-pin",
  );

  const { value: typeRaw, rest: afterType } = takeOption(withoutFlags.slice(1), "--type");
  const { value: deviceIdRaw, rest: afterDevice } = takeOption(afterType, "--device");
  const { value: adbEndpointRaw, rest: afterEndpoint } = takeOption(afterDevice, "--adb-endpoint");
  const { value: cloudProviderRaw, rest: afterCloudProvider } = takeOption(afterEndpoint, "--cloud-provider");
  const { value: pinRaw, rest: afterPin } = takeOption(afterCloudProvider, "--pin");
  const { value: wakeupIntervalRaw, rest: afterWakeupInterval } = takeOption(afterPin, "--wakeup-interval");
  // Backward-compatible aliases for older CLI flags.
  const { value: virtualPinRaw, rest: afterVirtualPin } = takeOption(afterWakeupInterval, "--virtual-pin");
  const { value: physicalPinRaw, rest } = takeOption(afterVirtualPin, "--physical-pin");
  if (rest.length > 0) {
    throw new Error(`Unexpected target arguments: ${rest.join(" ")}`);
  }
  const aliasPinRaw = physicalPinRaw ?? virtualPinRaw;
  if (pinRaw !== null && aliasPinRaw !== null && pinRaw.trim() !== aliasPinRaw.trim()) {
    throw new Error("Conflicting PIN flags: use only one of --pin/--virtual-pin/--physical-pin.");
  }
  const effectivePinRaw = pinRaw ?? aliasPinRaw;

  if (
    !typeRaw
    && !deviceIdRaw
    && !adbEndpointRaw
    && !cloudProviderRaw
    && !effectivePinRaw
    && !wakeupIntervalRaw
    && !clearDevice
    && !clearAdbEndpoint
    && !clearPin
    && !clearWakeupInterval
    && !clearVirtualPin
    && !clearPhysicalPin
  ) {
    throw new Error(
      "No target update provided. Use --type/--device/--adb-endpoint/--cloud-provider/--pin/--wakeup-interval or --clear-device/--clear-adb-endpoint/--clear-pin/--clear-wakeup-interval.",
    );
  }

  if (typeRaw) {
    const raw = typeRaw.trim().toLowerCase();
    if (!isDeviceTargetType(raw)) {
      throw new Error(`Unknown target type: ${typeRaw}`);
    }
    const normalized = normalizeDeviceTargetType(raw);
    cfg.target.type = normalized;
  }
  if (deviceIdRaw !== null) {
    const normalized = deviceIdRaw.trim();
    cfg.agent.deviceId = normalized ? normalized : null;
  }
  if (clearDevice) {
    cfg.agent.deviceId = null;
  }
  if (adbEndpointRaw !== null) {
    cfg.target.adbEndpoint = normalizeAdbEndpoint(adbEndpointRaw);
  }
  if (clearAdbEndpoint) {
    cfg.target.adbEndpoint = "";
  }
  if (cloudProviderRaw !== null) {
    cfg.target.cloudProvider = cloudProviderRaw.trim();
  }
  if (effectivePinRaw !== null) {
    cfg.target.pin = normalizeFourDigitPin(effectivePinRaw, "--pin");
  }
  if (clearPin || clearVirtualPin || clearPhysicalPin) {
    cfg.target.pin = "1234";
  }
  if (wakeupIntervalRaw !== null) {
    cfg.target.wakeupIntervalSec = normalizeWakeupIntervalSec(wakeupIntervalRaw, "--wakeup-interval");
  }
  if (clearWakeupInterval) {
    cfg.target.wakeupIntervalSec = 3;
  }

  if (isEmulatorTarget(cfg.target.type)) {
    cfg.target.adbEndpoint = "";
  }

  const shouldPromptDeviceSelection =
    deviceIdRaw === null
    && !clearDevice
    && (cfg.target.type === "physical-phone" || cfg.target.type === "android-tv")
    && (typeRaw !== null || adbEndpointRaw !== null || clearAdbEndpoint);
  if (shouldPromptDeviceSelection) {
    const candidates = discoverConnectedTargetDevices(cfg);
    const selected = await chooseTargetDeviceId(candidates, cfg.agent.deviceId);
    cfg.agent.deviceId = selected?.deviceId ?? null;
    if (adbEndpointRaw === null && !clearAdbEndpoint && selected) {
      if (selected.connectionType === "wifi" && selected.endpoint) {
        cfg.target.adbEndpoint = normalizeAdbEndpoint(selected.endpoint);
        printInfo(`Selected WiFi device; updated adb endpoint: ${cfg.target.adbEndpoint}`);
      } else if (selected.connectionType === "usb" && cfg.target.adbEndpoint.trim()) {
        cfg.target.adbEndpoint = "";
        printInfo("Selected USB device; cleared adb endpoint.");
      }
    }
  }

  saveConfig(cfg);

  printSuccess("Deployment target updated.");
  printTargetSummary(cfg);
  return 0;
}

async function runAgentCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const { value: model, rest } = takeOption(args, "--model");
  const task = rest.join(" ").trim();
  if (!task) {
    throw new Error("Missing task. Usage: openpocket agent [--model <name>] <task>");
  }

  const cfg = loadConfig(configPath);
  const agent = new AgentRuntime(cfg);
  agent.startScreenAwakeHeartbeat(Math.max(1, Math.round(cfg.target.wakeupIntervalSec)) * 1000);
  let result: Awaited<ReturnType<AgentRuntime["runTask"]>>;
  try {
    result = await agent.runTask(task, model ?? undefined);
  } finally {
    agent.stopScreenAwakeHeartbeat();
  }
  if (result.ok) {
    printSuccess(result.message);
  } else {
    printWarn(result.message);
  }
  printRaw(`Session: ${result.sessionPath}`);
  return result.ok ? 0 : 1;
}

async function runGatewayCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = (args[0] ?? "start").trim();
  if (sub !== "start" && sub !== "telegram") {
    throw new Error(`Unknown gateway subcommand: ${sub}. Use: gateway start`);
  }

  const tokenSourceLabel = (cfg: ReturnType<typeof loadConfig>): string => {
    const envName = cfg.telegram.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
    const hasConfigToken = cfg.telegram.botToken.trim().length > 0;
    const hasEnvToken = Boolean(process.env[envName]?.trim());
    if (hasConfigToken) {
      return "config.json";
    }
    if (hasEnvToken) {
      return `env:${envName}`;
    }
    return `missing (${envName})`;
  };

  const printStartupHeader = (cfg: ReturnType<typeof loadConfig>): void => {
    const tokenSource = tokenSourceLabel(cfg);
    printRaw(createOpenPocketBanner({ subtitle: "GATEWAY STARTUP", stream: output }));
    printRaw(cliTheme.section("Gateway Startup"));
    printKeyValue("Config", cfg.configPath);
    printKeyValue("Project", cfg.projectName, "accent");
    printKeyValue("Model", cfg.defaultModel, "accent");
    printKeyValue("Target", `${cfg.target.type} (${deviceTargetLabel(cfg.target.type)})`, "accent");
    printKeyValue("Device", cfg.agent.deviceId?.trim() || "(auto)");
    printKeyValue("Telegram token", tokenSource, tokenSource.startsWith("missing") ? "warn" : "success");
    printKeyValue("Human auth", cfg.humanAuth.enabled ? "enabled" : "disabled");
    printRaw("");
  };

  const printStartupStep = (
    step: number,
    total: number,
    title: string,
    status: CliStepStatus,
    detail: string,
  ): void => {
    printStep(step, total, title, status, detail);
  };

  await runGatewayLoop({
    log: (line) => {
      printRuntimeLine(line);
    },
    start: async () => {
      const cfg = loadConfig(configPath);
      const shortcut = installCliShortcut();
      const envName = cfg.telegram.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
      const hasToken = Boolean(cfg.telegram.botToken.trim() || process.env[envName]?.trim());
      const totalSteps = 6;
      let gateway: TelegramGateway | null = null;
      let dashboard: DashboardServer | null = null;

      printStartupHeader(cfg);
      printStartupStep(1, totalSteps, "Load config", "ok", "loaded");
      if (shortcut.shellRcUpdated.length > 0 || !shortcut.binDirAlreadyInPath) {
        printSuccess(`CLI launcher ensured: ${shortcut.commandPath}`);
        if (shortcut.preferredPathCommandPath) {
          printKeyValue("Current-shell", shortcut.preferredPathCommandPath, "accent");
        }
        if (shortcut.shellRcUpdated.length > 0) {
          printKeyValue("Updated shell rc", shortcut.shellRcUpdated.join(", "), "accent");
        }
        printWarn(
          "Reload shell profile (or open a new terminal) before using `openpocket` without `./`.",
        );
      }
      if (!hasToken) {
        printStartupStep(2, totalSteps, "Validate Telegram token", "failed", "token missing");
        throw new Error(
          `Telegram bot token is empty. Set config.telegram.botToken or env ${envName}.`,
        );
      }
      printStartupStep(2, totalSteps, "Validate Telegram token", "ok", tokenSourceLabel(cfg));

      const emulator = new EmulatorManager(cfg);
      const bootstrapWindowed = process.platform === "darwin";
      const targetIsEmulator = isEmulatorTarget(cfg.target.type);

      if (targetIsEmulator) {
        const emulatorStatus = emulator.status();
        if (emulatorStatus.bootedDevices.length > 0) {
          let detail = `ok (${emulatorStatus.bootedDevices.join(", ")})`;
          if (bootstrapWindowed) {
            const showMessage = await emulator.ensureWindowVisible();
            const hideMessage = await emulator.hideWindowInPlace();
            detail = `${detail}; ${showMessage}; ${hideMessage}`;
          }
          printStartupStep(
            3,
            totalSteps,
            "Ensure emulator is running",
            "ok",
            detail,
          );
        } else {
          printStartupStep(3, totalSteps, "Ensure emulator is running", "running", "booting emulator");
          const startMessage = await emulator.start(bootstrapWindowed ? false : true);
          if (bootstrapWindowed) {
            const hideMessage = await emulator.hideWindowInPlace();
            printStartupStep(3, totalSteps, "Ensure emulator is running", "ok", `${startMessage}; ${hideMessage}`);
          } else {
            printStartupStep(3, totalSteps, "Ensure emulator is running", "ok", startMessage);
          }
        }
        const readyStatus = emulator.status();
        if (readyStatus.bootedDevices.length === 0) {
          throw new Error(
            "Emulator is online but not boot-complete yet. Retry after boot or increase emulator.bootTimeoutSec.",
          );
        }
      } else {
        printStartupStep(3, totalSteps, "Ensure target device is online", "running", "probing adb target");
        const message = await emulator.start();
        const readyStatus = emulator.status();
        if (readyStatus.devices.length === 0) {
          throw new Error("No online target device found. Connect USB device or configure target.adbEndpoint.");
        }
        printStartupStep(3, totalSteps, "Ensure target device is online", "ok", message);
      }

      if (cfg.dashboard.enabled) {
        printStartupStep(4, totalSteps, "Ensure local dashboard", "running", "starting");
        const createDashboard = (port: number): DashboardServer =>
          new DashboardServer({
            config: cfg,
            mode: "integrated",
            host: cfg.dashboard.host,
            port,
            getGatewayStatus: () => ({
              running: gateway?.isRunning() ?? false,
              managed: true,
              note:
                gateway?.isRunning()
                  ? "managed by current gateway process"
                  : "gateway initializing",
            }),
          });

        try {
          dashboard = createDashboard(cfg.dashboard.port);
          await dashboard.start();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EADDRINUSE") {
            dashboard = createDashboard(0);
            await dashboard.start();
          } else {
            throw error;
          }
        }

        printStartupStep(4, totalSteps, "Ensure local dashboard", "ok", dashboard.address);
        if (cfg.dashboard.autoOpenBrowser) {
          openUrlInBrowser(dashboard.address);
          printInfo(`Dashboard opened in browser: ${dashboard.address}`);
        }
      } else {
        printStartupStep(4, totalSteps, "Ensure local dashboard", "skipped", "disabled in config");
      }

      printStartupStep(5, totalSteps, "Initialize gateway runtime", "running", "initializing");
      gateway = new TelegramGateway(cfg, {
        logger: (line) => {
          printRuntimeLine(line);
        },
        onLogLine: (line) => {
          dashboard?.ingestExternalLogLine(line);
        },
      });
      printStartupStep(5, totalSteps, "Initialize gateway runtime", "ok", "ready");
      printStartupStep(6, totalSteps, "Start services", "running", "starting polling and services");
      await gateway.start();
      printStartupStep(6, totalSteps, "Start services", "ok", "all services online");
      printRaw("");
      printRaw(cliTheme.section("Runtime Ready"));
      printSuccess("Gateway is running. Press Ctrl+C to stop.");
      if (dashboard) {
        const parsed = new URL(dashboard.address);
        const dashboardPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
        printKeyValue("Dashboard port", dashboardPort, "success");
        printKeyValue("Dashboard URL", dashboard.address, "success");
      }
      if (cfg.humanAuth.enabled) {
        const relayBaseUrl = cfg.humanAuth.relayBaseUrl.trim();
        const publicBaseUrl = cfg.humanAuth.publicBaseUrl.trim();
        if (relayBaseUrl) {
          printKeyValue("Relay URL", relayBaseUrl, "accent");
        }
        if (publicBaseUrl) {
          const tone = /^https:\/\//i.test(publicBaseUrl) ? "success" : "warn";
          printKeyValue("Public URL", publicBaseUrl, tone);
        }
      }
      return {
        stop: async (reason?: string) => {
          printWarn(`Stopping gateway (${reason ?? "run-loop-stop"})`);
          await gateway?.stop(reason ?? "run-loop-stop");
          if (dashboard) {
            await dashboard.stop();
          }
          printInfo("Gateway stopped.");
        },
      };
    },
  });
  return 0;
}

async function runBootstrapCommand(
  configPath: string | undefined,
  options: { promptDataPartitionSize?: boolean } = {},
): Promise<ReturnType<typeof loadConfig>> {
  const cfg = loadConfig(configPath);
  if (options.promptDataPartitionSize && isEmulatorTarget(cfg.target.type)) {
    const currentSizeGb = Number(cfg.emulator.dataPartitionSizeGb);
    const targetSizeGb =
      Number.isFinite(currentSizeGb) &&
      Number.isInteger(currentSizeGb) &&
      currentSizeGb >= 8 &&
      currentSizeGb <= 512
        ? currentSizeGb
        : DEFAULT_ONBOARD_AVD_DATA_PARTITION_SIZE_GB;
    cfg.emulator.dataPartitionSizeGb = targetSizeGb;
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const rl = createInterface({ input, output });
      try {
        printRaw(cliTheme.section("Agent Phone Storage"));
        printInfo("How much disk space do you want to allocate to your Agent Phone?");
        printInfo(`Press Enter to keep ${targetSizeGb}G, or enter a custom size in GB (8-512).`);
        printInfo("Tip: type `skip` to keep the current value.");
        while (true) {
          const raw = (
            await rl.question(
              `${cliTheme.paint("[INPUT]", "warn")} Agent Phone disk size (GB) [${targetSizeGb}]: `,
            )
          ).trim();
          if (!raw || raw.toLowerCase() === "skip") {
            cfg.emulator.dataPartitionSizeGb = targetSizeGb;
            break;
          }
          const normalized = raw.toLowerCase().endsWith("g") ? raw.slice(0, -1).trim() : raw;
          const parsed = Number(normalized);
          if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
            printWarn("Please input an integer size in GB, for example: 24 or 32.");
            continue;
          }
          if (parsed < 8 || parsed > 512) {
            printWarn("Please choose a size between 8 and 512 GB.");
            continue;
          }
          cfg.emulator.dataPartitionSizeGb = parsed;
          break;
        }
      } finally {
        if (input.setRawMode) {
          try {
            input.setRawMode(false);
          } catch {
            // Ignore raw mode reset errors.
          }
        }
        input.pause();
        rl.close();
      }
    }
    saveConfig(cfg);
    printInfo(`[OpenPocket][onboard] AVD data partition target: ${cfg.emulator.dataPartitionSizeGb}G`);
  }
  printRaw(cliTheme.section("Environment Bootstrap"));

  if (!isEmulatorTarget(cfg.target.type)) {
    if (process.env.OPENPOCKET_SKIP_ENV_SETUP === "1") {
      printInfo("[OpenPocket][env] OPENPOCKET_SKIP_ENV_SETUP=1 -> skip adb prerequisite checks.");
      saveConfig(cfg);
      printSuccess("Environment bootstrap completed.");
      return cfg;
    }
    const deviceManager = new EmulatorManager(cfg);
    try {
      const adb = deviceManager.adbBinary();
      printInfo(`[OpenPocket][env] target=${cfg.target.type}; adb ready at ${adb}`);
      printInfo("[OpenPocket][env] Skipping emulator/AVD bootstrap for non-emulator target.");
    } catch (error) {
      throw new Error(
        `adb not found for target=${cfg.target.type}. Install Android platform-tools first. ${(error as Error).message}`,
      );
    }
    saveConfig(cfg);
    printSuccess("Environment bootstrap completed.");
    return cfg;
  }

  await ensureAndroidPrerequisites(cfg, {
    autoInstall: true,
    logger: (line) => {
      printRuntimeLine(`[OpenPocket][env] ${line}`);
    },
  });
  saveConfig(cfg);
  printSuccess("Environment bootstrap completed.");
  return cfg;
}

function shortcutMarkerPath(cfg: ReturnType<typeof loadConfig>): string {
  return path.join(cfg.stateDir, "cli-shortcut.json");
}

function installCliShortcutOnFirstOnboard(cfg: ReturnType<typeof loadConfig>): void {
  const markerPath = shortcutMarkerPath(cfg);
  if (fs.existsSync(markerPath)) {
    return;
  }

  const shortcut = installCliShortcut();
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        installedAt: new Date().toISOString(),
        commandPath: shortcut.commandPath,
        binDir: shortcut.binDir,
        shellRcUpdated: shortcut.shellRcUpdated,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  printSuccess(`[OpenPocket][onboard] CLI launcher installed: ${shortcut.commandPath}`);
  if (shortcut.preferredPathCommandPath) {
    printInfo(`[OpenPocket][onboard] Current-shell launcher: ${shortcut.preferredPathCommandPath}`);
  }
  if (shortcut.shellRcUpdated.length > 0) {
    printInfo(`[OpenPocket][onboard] Updated shell rc: ${shortcut.shellRcUpdated.join(", ")}`);
  }
  if (!shortcut.binDirAlreadyInPath || shortcut.shellRcUpdated.length > 0) {
    printWarn("[OpenPocket][onboard] Reload shell profile (or open a new terminal) to use `openpocket` directly.");
  }
}

async function runOnboardCommand(configPath: string | undefined, args: string[] = []): Promise<number> {
  const { value: targetTypeRaw, rest: afterTarget } = takeOption(args, "--target");
  const hasForce = afterTarget.includes("--force");
  const unknownArgs = afterTarget.filter((item) => item !== "--force");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown onboard option(s): ${unknownArgs.join(" ")}`);
  }

  if (targetTypeRaw) {
    const raw = targetTypeRaw.trim().toLowerCase();
    if (!isDeviceTargetType(raw)) {
      throw new Error(
        `Unknown target type '${targetTypeRaw}'. Use one of: emulator, physical-phone, android-tv, cloud.`,
      );
    }
  }

  if (hasForce) {
    const existing = loadConfig(configPath);
    fs.rmSync(existing.configPath, { force: true });
    fs.rmSync(path.join(existing.stateDir, "onboarding.json"), { force: true });
    printWarn(`[OpenPocket][onboard] --force enabled: cleared previous config at ${existing.configPath}`);
  }

  if (targetTypeRaw) {
    const cfg = loadConfig(configPath);
    cfg.target.type = normalizeDeviceTargetType(targetTypeRaw);
    if (isEmulatorTarget(cfg.target.type)) {
      cfg.target.adbEndpoint = "";
    }
    saveConfig(cfg);
    printInfo(`[OpenPocket][onboard] target preset: ${cfg.target.type} (${deviceTargetLabel(cfg.target.type)})`);
  }

  const cfg = await runBootstrapCommand(configPath, { promptDataPartitionSize: true });
  installCliShortcutOnFirstOnboard(cfg);
  await runSetupWizard(cfg);
  return 0;
}

async function runInstallCliCommand(): Promise<number> {
  const shortcut = installCliShortcut();
  printSuccess(`CLI launcher installed: ${shortcut.commandPath}`);
  if (shortcut.preferredPathCommandPath) {
    printInfo(`Current-shell launcher: ${shortcut.preferredPathCommandPath}`);
  }
  if (shortcut.shellRcUpdated.length > 0) {
    printInfo(`Updated shell rc: ${shortcut.shellRcUpdated.join(", ")}`);
  }
  if (!shortcut.binDirAlreadyInPath || shortcut.shellRcUpdated.length > 0) {
    printWarn("Reload shell profile (or open a new terminal) to use `openpocket` directly.");
  }
  return 0;
}

async function runSkillsCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "list") {
    throw new Error(`Unknown skills subcommand: ${sub ?? "(missing)"}`);
  }

  const cfg = loadConfig(configPath);
  const loader = new SkillLoader(cfg);
  const skills = loader.loadAll();
  if (skills.length === 0) {
    printWarn("No skills loaded.");
    return 0;
  }

  printRaw(cliTheme.section("Loaded Skills"));
  for (const skill of skills) {
    printRaw(cliTheme.emphasize(`[${skill.source}] ${skill.name} (${skill.id})`, "accent"));
    printRaw(`  ${skill.description}`);
    printRaw(`  ${skill.path}`);
  }
  return 0;
}

async function runScriptCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "run") {
    throw new Error(`Unknown script subcommand: ${sub ?? "(missing)"}`);
  }

  const cfg = loadConfig(configPath);
  const { value: filePath, rest: afterFile } = takeOption(args.slice(1), "--file");
  const { value: textScript, rest: afterText } = takeOption(afterFile, "--text");
  const { value: timeout, rest } = takeOption(afterText, "--timeout");
  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }

  let script = "";
  if (filePath) {
    script = fs.readFileSync(filePath, "utf-8");
  } else if (textScript) {
    script = textScript;
  } else {
    throw new Error("Missing script input. Use --file <path> or --text <script>.");
  }

  const executor = new ScriptExecutor(cfg);
  const result = await executor.execute(
    script,
    timeout && Number.isFinite(Number(timeout)) ? Number(timeout) : undefined,
  );

  printRaw(cliTheme.section("Script Execution"));
  if (result.ok) {
    printSuccess(`ok=${result.ok} exitCode=${result.exitCode} timedOut=${result.timedOut}`);
  } else {
    printWarn(`ok=${result.ok} exitCode=${result.exitCode} timedOut=${result.timedOut}`);
  }
  printKeyValue("runDir", result.runDir, "accent");
  if (result.stdout.trim()) {
    printRaw(cliTheme.label("STDOUT", "info"));
    printRaw(result.stdout);
  }
  if (result.stderr.trim()) {
    printRaw(cliTheme.label("STDERR", "warn"));
    printRaw(result.stderr);
  }
  return result.ok ? 0 : 1;
}

function parseAllowedChatIds(raw: string): number[] {
  const parts = raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  const values = parts.map((item) => Number(item));
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Allowed chat IDs must be numbers.");
  }
  return values.map((value) => Math.trunc(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTelegramTokenSource(cfg: ReturnType<typeof loadConfig>): {
  envName: string;
  token: string;
  source: string;
} {
  const envName = cfg.telegram.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
  const configToken = cfg.telegram.botToken.trim();
  const envToken = process.env[envName]?.trim() ?? "";
  if (configToken) {
    return { envName, token: configToken, source: "config.json" };
  }
  if (envToken) {
    return { envName, token: envToken, source: `env:${envName}` };
  }
  return { envName, token: "", source: `missing (${envName})` };
}

function resolveTelegramChatId(cfg: OpenPocketConfig, chatIdRaw: string | null): number {
  if (chatIdRaw !== null) {
    const parsed = Number(chatIdRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error("Chat ID must be a number.");
    }
    return Math.trunc(parsed);
  }
  if (cfg.telegram.allowedChatIds.length === 1) {
    return cfg.telegram.allowedChatIds[0];
  }
  if (cfg.telegram.allowedChatIds.length > 1) {
    throw new Error(
      `Multiple allowed chat IDs configured (${cfg.telegram.allowedChatIds.join(", ")}). Use --chat <id>.`,
    );
  }
  throw new Error("No default chat ID found. Use --chat <id> or configure telegram.allowedChatIds.");
}

type TelegramSendMessageParams = {
  chat_id: number;
  text: string;
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; url?: string }>>;
  };
};

async function sendTelegramMessage(token: string, payload: TelegramSendMessageParams): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram send failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }
  let apiPayload: { ok?: boolean; description?: string } = {};
  try {
    apiPayload = JSON.parse(bodyText) as { ok?: boolean; description?: string };
  } catch {
    apiPayload = {};
  }
  if (apiPayload.ok === false) {
    throw new Error(`Telegram send failed: ${apiPayload.description ?? "unknown error"}`);
  }
}

function normalizeUrlForCompare(value: string): string {
  let url = value.trim();
  if (!url) {
    return "";
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  try {
    const parsed = new URL(url);
    const host =
      parsed.hostname === "localhost" || parsed.hostname === "::" || parsed.hostname === "0.0.0.0"
        ? "127.0.0.1"
        : parsed.hostname.toLowerCase();
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${host}:${port}`;
  } catch {
    return "";
  }
}

async function isRelayHealthy(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/healthz`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverNgrokPublicUrlForTarget(apiBaseUrl: string, relayBaseUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/api/tunnels`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const parsed = (await response.json()) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.tunnels)) {
      return null;
    }
    const target = normalizeUrlForCompare(relayBaseUrl);
    const tunnels = parsed.tunnels
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => {
        const cfg = isRecord(item.config) ? item.config : null;
        return {
          publicUrl: String(item.public_url ?? ""),
          proto: String(item.proto ?? ""),
          addr: cfg ? String(cfg.addr ?? "") : String(item.addr ?? ""),
        };
      })
      .filter((item) => item.publicUrl.startsWith("https://"));
    if (tunnels.length === 0) {
      return null;
    }
    const matched = tunnels.find((item) => normalizeUrlForCompare(item.addr) === target);
    if (matched) {
      return matched.publicUrl.replace(/\/+$/, "");
    }
    if (tunnels.length === 1) {
      return tunnels[0].publicUrl.replace(/\/+$/, "");
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type TelegramChatCandidate = {
  id: number;
  type: string;
  title: string;
  source: string;
};

function extractChatCandidate(value: unknown, source: string): TelegramChatCandidate | null {
  if (!isRecord(value)) {
    return null;
  }
  const idRaw = value.id;
  const id = typeof idRaw === "number" ? Math.trunc(idRaw) : Number.NaN;
  if (!Number.isFinite(id)) {
    return null;
  }
  const type = String(value.type ?? "unknown");
  const title = String(
    value.title ??
      [value.first_name, value.last_name].filter((item) => typeof item === "string" && item.trim()).join(" ") ??
      value.username ??
      "",
  ).trim();
  return {
    id,
    type,
    title: title || "(untitled)",
    source,
  };
}

function collectTelegramChatCandidates(update: unknown): TelegramChatCandidate[] {
  const row = isRecord(update) ? update : null;
  if (!row) {
    return [];
  }
  const out: TelegramChatCandidate[] = [];
  const push = (chat: unknown, source: string) => {
    const parsed = extractChatCandidate(chat, source);
    if (parsed) {
      out.push(parsed);
    }
  };

  if (isRecord(row.message)) {
    push(row.message.chat, "message");
  }
  if (isRecord(row.edited_message)) {
    push(row.edited_message.chat, "edited_message");
  }
  if (isRecord(row.channel_post)) {
    push(row.channel_post.chat, "channel_post");
  }
  if (isRecord(row.edited_channel_post)) {
    push(row.edited_channel_post.chat, "edited_channel_post");
  }
  if (isRecord(row.callback_query) && isRecord(row.callback_query.message)) {
    push(row.callback_query.message.chat, "callback_query.message");
  }
  if (isRecord(row.my_chat_member)) {
    push(row.my_chat_member.chat, "my_chat_member");
  }
  if (isRecord(row.chat_member)) {
    push(row.chat_member.chat, "chat_member");
  }

  return out;
}

async function runTelegramWhoamiCommand(cfg: ReturnType<typeof loadConfig>): Promise<number> {
  const tokenInfo = resolveTelegramTokenSource(cfg);
  const allow = cfg.telegram.allowedChatIds;
  const allowPolicy = allow.length > 0 ? "allow_only_listed" : "allow_all";

  printRaw(cliTheme.section("Telegram Identity"));
  printKeyValue("Token source", tokenInfo.source, tokenInfo.token ? "success" : "warn");
  printKeyValue("Allow policy", allowPolicy);
  printKeyValue(
    "Allowlist",
    allow.length > 0 ? allow.map((id) => String(id)).join(", ") : "empty (all chats allowed)",
  );

  if (!tokenInfo.token) {
    printWarn(`Telegram token is not configured. Set config.telegram.botToken or env ${tokenInfo.envName}.`);
    return 0;
  }

  const apiBase = `https://api.telegram.org/bot${tokenInfo.token}`;
  let botName = "(unknown)";
  try {
    const getMeResp = await fetch(`${apiBase}/getMe`);
    const getMeText = await getMeResp.text();
    if (getMeResp.ok) {
      const getMeJson = JSON.parse(getMeText) as unknown;
      if (isRecord(getMeJson) && getMeJson.ok === true && isRecord(getMeJson.result)) {
        const username = String(getMeJson.result.username ?? "").trim();
        const id = Number(getMeJson.result.id ?? Number.NaN);
        botName = `${username ? `@${username}` : "(no username)"}${Number.isFinite(id) ? ` (id=${id})` : ""}`;
      }
    }
  } catch {
    // Ignore getMe failure and continue with updates probe.
  }

  printKeyValue("Bot", botName, "accent");

  try {
    const updatesResp = await fetch(`${apiBase}/getUpdates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeout: 0,
        limit: 30,
        allowed_updates: [
          "message",
          "edited_message",
          "channel_post",
          "edited_channel_post",
          "callback_query",
          "my_chat_member",
          "chat_member",
        ],
      }),
    });
    const updatesText = await updatesResp.text();
    if (!updatesResp.ok) {
      throw new Error(`HTTP ${updatesResp.status}: ${updatesText.slice(0, 300)}`);
    }

    const updatesJson = JSON.parse(updatesText) as unknown;
    if (!isRecord(updatesJson) || updatesJson.ok !== true || !Array.isArray(updatesJson.result)) {
      throw new Error("Unexpected getUpdates response.");
    }

    const seen = new Map<number, TelegramChatCandidate>();
    for (const row of updatesJson.result) {
      for (const chat of collectTelegramChatCandidates(row)) {
        if (!seen.has(chat.id)) {
          seen.set(chat.id, chat);
        }
      }
    }

    if (seen.size === 0) {
      printWarn("No chat IDs discovered from recent updates.");
      printInfo("Send one message to your bot in Telegram, then run `openpocket telegram whoami` again.");
      return 0;
    }

    printRaw(cliTheme.section("Discovered Chat IDs"));
    for (const chat of seen.values()) {
      const allowed = allow.length === 0 || allow.includes(chat.id);
      printRaw(
        `  - ${chat.id} | type=${chat.type} | title=${chat.title} | source=${chat.source} | allowed=${allowed}`,
      );
    }
    return 0;
  } catch (error) {
    const message = (error as Error).message || "unknown error";
    printWarn(`Unable to query recent Telegram updates: ${message}`);
    printInfo("If gateway is running, polling conflict can happen. Stop gateway and retry this command.");
    return 0;
  }
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeEnvVarName(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!ENV_VAR_NAME_RE.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function truncateForTerminal(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return ".".repeat(maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

type CliSelectOption<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

async function selectByArrowKeys<T extends string>(
  rl: Interface,
  message: string,
  options: CliSelectOption<T>[],
  initialValue?: T,
): Promise<T> {
  if (options.length === 0) {
    throw new Error("Select prompt requires at least one option.");
  }
  const initialIndex =
    initialValue !== undefined ? Math.max(0, options.findIndex((opt) => opt.value === initialValue)) : 0;
  let index = initialIndex >= 0 && initialIndex < options.length ? initialIndex : 0;

  if (!input.isTTY || !output.isTTY) {
    return options[index].value;
  }

  rl.pause();
  readline.emitKeypressEvents(input);

  const previousRaw = Boolean((input as NodeJS.ReadStream).isRaw);
  if (input.setRawMode) {
    input.setRawMode(true);
  }
  input.resume();

  let renderedLines = 0;
  const columns = Math.max(60, output.columns ?? 120);
  const render = () => {
    if (renderedLines > 0) {
      readline.moveCursor(output, 0, -renderedLines);
      readline.clearScreenDown(output);
    }
    const lines: string[] = [];
    lines.push("");
    lines.push(cliTheme.paint(truncateForTerminal(`[SELECT] ${message}`, columns - 1), "accent"));
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      const selected = i === index;
      const prefix = selected ? ">>" : "  ";
      const hint = option.hint ? ` (${option.hint})` : "";
      const rawLine = `  ${prefix} ${option.label}${hint}`;
      const clipped = truncateForTerminal(rawLine, columns - 1);
      lines.push(selected ? cliTheme.paint(clipped, "success") : clipped);
    }
    lines.push(cliTheme.paint(truncateForTerminal("[INPUT] Use Up/Down arrows and Enter to select.", columns - 1), "warn"));
    output.write(`${lines.join("\n")}\n`);
    renderedLines = lines.length;
  };

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      if (input.setRawMode) {
        try {
          input.setRawMode(previousRaw);
        } catch {
          // Ignore raw mode restore errors.
        }
      }
      rl.resume();
    };

    const onKeypress = (_char: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        reject(new Error("Setup cancelled by user."));
        return;
      }
      if (key.name === "up") {
        index = (index - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key.name === "down") {
        index = (index + 1) % options.length;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolve(options[index].value);
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

async function runTelegramSetupCommand(
  configPath: string | undefined,
  args: string[],
): Promise<number> {
  const sub = (args[0] ?? "setup").trim();
  if (sub !== "setup" && sub !== "whoami") {
    throw new Error(`Unknown telegram subcommand: ${sub}. Use: telegram setup|whoami`);
  }

  const cfg = loadConfig(configPath);
  if (sub === "whoami") {
    return runTelegramWhoamiCommand(cfg);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`telegram setup` requires an interactive terminal (TTY).");
  }

  const rl = createInterface({ input, output });
  try {
    printRaw(cliTheme.section("Telegram Setup"));
    printInfo("Create your bot in Telegram with @BotFather before continuing.");

    const fallbackEnv = "TELEGRAM_BOT_TOKEN";
    const configuredEnv = cfg.telegram.botTokenEnv || fallbackEnv;
    const currentEnv = normalizeEnvVarName(configuredEnv, fallbackEnv);
    if (currentEnv !== configuredEnv) {
      cfg.telegram.botTokenEnv = currentEnv;
      printWarn(
        `[OpenPocket] Invalid botTokenEnv value detected (${configuredEnv}). Reset to ${currentEnv}.`,
      );
    }
    const envToken = process.env[currentEnv]?.trim() ?? "";
    const tokenChoice = await selectByArrowKeys(
      rl,
      "Telegram bot token source",
      [
        {
          value: "env",
          label: `Use environment variable (${currentEnv})`,
          hint: envToken ? `detected, length ${envToken.length}` : "not detected",
        },
        {
          value: "config",
          label: "Save token in local config.json",
        },
        {
          value: "keep",
          label: "Keep current token settings",
          hint: cfg.telegram.botToken.trim() ? "config token exists" : "no config token",
        },
      ],
      "env",
    );

    if (tokenChoice === "env") {
      const envNameRaw = await rl.question(
        `Environment variable name for Telegram token [${currentEnv}]: `,
      );
      const envName = envNameRaw.trim() || currentEnv;
      cfg.telegram.botTokenEnv = envName;
      cfg.telegram.botToken = "";
      const selectedEnvToken = process.env[envName]?.trim() ?? "";
      if (!selectedEnvToken) {
        printWarn(
          `[OpenPocket] Warning: ${envName} is not set in this shell. Gateway start will fail until you export it.`,
        );
      }
    } else if (tokenChoice === "config") {
      const token = (await rl.question("Enter Telegram bot token: ")).trim();
      if (!token) {
        throw new Error("Telegram bot token cannot be empty.");
      }
      cfg.telegram.botToken = token;
    }

    const currentAllow =
      cfg.telegram.allowedChatIds.length > 0
        ? cfg.telegram.allowedChatIds.join(", ")
        : "empty (all chats allowed)";
    const allowChoice = await selectByArrowKeys(
      rl,
      "Telegram chat allowlist policy",
      [
        {
          value: "keep",
          label: "Keep current allowlist",
          hint: currentAllow,
        },
        {
          value: "open",
          label: "Allow all chats (clear allowlist)",
        },
        {
          value: "set",
          label: "Set allowlist manually (chat IDs)",
        },
      ],
      "keep",
    );

    if (allowChoice === "open") {
      cfg.telegram.allowedChatIds = [];
    } else if (allowChoice === "set") {
      const allowedInput = await rl.question(
        "Enter allowed chat IDs (comma or space separated): ",
      );
      cfg.telegram.allowedChatIds = parseAllowedChatIds(allowedInput);
    }

    saveConfig(cfg);
    printSuccess("Telegram setup saved.");
    printInfo("Next: run `openpocket gateway start`.");
    return 0;
  } finally {
    if (input.setRawMode) {
      try {
        input.setRawMode(false);
      } catch {
        // Ignore raw mode reset errors.
      }
    }
    input.pause();
    rl.close();
  }
}

async function runDashboardCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = (args[0] ?? "start").trim();
  if (sub !== "start") {
    throw new Error(`Unknown dashboard subcommand: ${sub}. Use: dashboard start`);
  }

  const { value: hostOption, rest: afterHost } = takeOption(args.slice(1), "--host");
  const { value: portOption, rest } = takeOption(afterHost, "--port");
  if (rest.length > 0) {
    throw new Error(`Unexpected dashboard arguments: ${rest.join(" ")}`);
  }

  const cfg = loadConfig(configPath);
  const parsedPort = Number(portOption ?? String(cfg.dashboard.port));
  const port = Number.isFinite(parsedPort)
    ? Math.max(1, Math.min(65535, Math.round(parsedPort)))
    : cfg.dashboard.port;
  const host = hostOption?.trim() || cfg.dashboard.host || "127.0.0.1";

  const dashboard = new DashboardServer({
    config: cfg,
    mode: "standalone",
    host,
    port,
    getGatewayStatus: standaloneDashboardGatewayStatus,
  });

  await dashboard.start();
  printRaw(cliTheme.section("Dashboard"));
  printSuccess(`[OpenPocket][dashboard] started at ${dashboard.address}`);
  printInfo("[OpenPocket][dashboard] press Ctrl+C to stop");

  if (cfg.dashboard.autoOpenBrowser) {
    openUrlInBrowser(dashboard.address);
    printInfo(`[OpenPocket][dashboard] opened browser: ${dashboard.address}`);
  }

  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

  await dashboard.stop();
  printSuccess("[OpenPocket][dashboard] stopped");
  return 0;
}

async function runHumanAuthRelayCommand(
  configPath: string | undefined,
  args: string[],
): Promise<number> {
  const sub = (args[0] ?? "start").trim();
  if (sub !== "start") {
    throw new Error(`Unknown human-auth-relay subcommand: ${sub}. Use: human-auth-relay start`);
  }

  const { value: host, rest: afterHost } = takeOption(args.slice(1), "--host");
  const { value: portRaw, rest: afterPort } = takeOption(afterHost, "--port");
  const { value: publicBaseUrl, rest: afterPublicBaseUrl } = takeOption(
    afterPort,
    "--public-base-url",
  );
  const { value: apiKey, rest: afterApiKey } = takeOption(afterPublicBaseUrl, "--api-key");
  const { value: stateFile, rest } = takeOption(afterApiKey, "--state-file");

  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }

  const cfg = loadConfig(configPath);
  const parsedPort = Number(portRaw ?? String(cfg.humanAuth.localRelayPort));
  const defaultPort = cfg.humanAuth.localRelayPort;
  const port = Number.isFinite(parsedPort)
    ? Math.max(1, Math.min(65535, Math.round(parsedPort)))
    : defaultPort;

  const relay = new HumanAuthRelayServer({
    host: (host ?? cfg.humanAuth.localRelayHost ?? "0.0.0.0").trim(),
    port,
    publicBaseUrl: (publicBaseUrl ?? cfg.humanAuth.publicBaseUrl ?? "").trim(),
    apiKey: (apiKey ?? cfg.humanAuth.apiKey ?? "").trim(),
    apiKeyEnv: cfg.humanAuth.apiKeyEnv,
    stateFile:
      stateFile?.trim() ||
      cfg.humanAuth.localRelayStateFile,
    takeoverRuntime: new LocalHumanAuthTakeoverRuntime(cfg),
  });

  await relay.start();
  const relayAddress = relay.address || `http://${host ?? "0.0.0.0"}:${port}`;
  printRaw(cliTheme.section("Human Auth Relay"));
  printSuccess(`[OpenPocket][human-auth-relay] started at ${relayAddress}`);
  printInfo("[OpenPocket][human-auth-relay] press Ctrl+C to stop");
  printKeyValue("Relay URL", relayAddress, "success");
  if (relayAddress.startsWith("http://")) {
    const parsed = new URL(relayAddress);
    const relayPort = parsed.port || "80";
    printKeyValue("Relay port", relayPort, "accent");
  }
  if (relayAddress.startsWith("https://")) {
    const parsed = new URL(relayAddress);
    const relayPort = parsed.port || "443";
    printKeyValue("Relay port", relayPort, "accent");
  }

  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

  await relay.stop();
  printSuccess("[OpenPocket][human-auth-relay] stopped");
  return 0;
}

async function runPermissionLabScenario(params: {
  config: OpenPocketConfig;
  scenarioId: string | null;
  deviceId: string | null;
  chatIdRaw: string | null;
  modelName: string | null;
  clean: boolean;
}): Promise<number> {
  const tokenInfo = resolveTelegramTokenSource(params.config);
  if (!tokenInfo.token) {
    throw new Error(`Telegram bot token is empty. Set config.telegram.botToken or env ${tokenInfo.envName}.`);
  }
  const chatId = resolveTelegramChatId(params.config, params.chatIdRaw);

  if (!params.config.humanAuth.enabled) {
    throw new Error("Human auth is disabled. Enable config.humanAuth.enabled before running permission-app scenarios.");
  }

  const runtimeConfig = JSON.parse(JSON.stringify(params.config)) as OpenPocketConfig;
  const scenarioManager = new PermissionLabManager(runtimeConfig);
  const scenario = scenarioManager.resolveScenario(params.scenarioId);
  if (params.deviceId?.trim()) {
    runtimeConfig.agent.deviceId = params.deviceId.trim();
  }

  const permissionLab = new PermissionLabManager(runtimeConfig);
  const agent = new AgentRuntime(runtimeConfig);
  const humanAuth = new HumanAuthBridge(runtimeConfig);
  const localStack = new LocalHumanAuthStack(runtimeConfig, (line) => {
    printRuntimeLine(line);
  });
  let localStackStarted = false;

  try {
    if (runtimeConfig.humanAuth.useLocalRelay) {
      const configuredRelayBaseUrl = `http://${runtimeConfig.humanAuth.localRelayHost}:${runtimeConfig.humanAuth.localRelayPort}`;
      const existingRelayHealthy = await isRelayHealthy(configuredRelayBaseUrl);
      if (existingRelayHealthy) {
        runtimeConfig.humanAuth.relayBaseUrl = configuredRelayBaseUrl;
        const discoveredPublicUrl = await discoverNgrokPublicUrlForTarget(
          runtimeConfig.humanAuth.tunnel.ngrok.apiBaseUrl,
          configuredRelayBaseUrl,
        );
        runtimeConfig.humanAuth.publicBaseUrl = (
          runtimeConfig.humanAuth.publicBaseUrl.trim() ||
          discoveredPublicUrl ||
          configuredRelayBaseUrl
        ).replace(/\/+$/, "");
        printInfo(`[OpenPocket][test] Reusing running human-auth relay: ${runtimeConfig.humanAuth.relayBaseUrl}`);
        printInfo(`[OpenPocket][test] Reusing public auth URL: ${runtimeConfig.humanAuth.publicBaseUrl}`);
      } else {
        printInfo("[OpenPocket][test] Starting local human-auth relay stack...");
        const started = await localStack.start();
        runtimeConfig.humanAuth.relayBaseUrl = started.relayBaseUrl;
        runtimeConfig.humanAuth.publicBaseUrl = started.publicBaseUrl;
        localStackStarted = true;
        printSuccess(`[OpenPocket][test] Human-auth relay: ${started.relayBaseUrl}`);
        printSuccess(`[OpenPocket][test] Human-auth public URL: ${started.publicBaseUrl}`);
      }
    } else if (!runtimeConfig.humanAuth.relayBaseUrl.trim()) {
      throw new Error(
        "Human auth relay URL is empty. Set config.humanAuth.relayBaseUrl or enable config.humanAuth.useLocalRelay.",
      );
    }

    if (
      runtimeConfig.humanAuth.tunnel.provider === "ngrok" &&
      runtimeConfig.humanAuth.tunnel.ngrok.enabled &&
      normalizeUrlForCompare(runtimeConfig.humanAuth.publicBaseUrl) ===
        normalizeUrlForCompare(runtimeConfig.humanAuth.relayBaseUrl)
    ) {
      throw new Error(
        "Ngrok public URL is not available. A relay is running but no public tunnel was found for it. Stop duplicate ngrok/gateway sessions, then retry.",
      );
    }

    printRaw(cliTheme.section("PermissionLab Scenario"));
    printInfo(`[OpenPocket][test] Scenario: ${scenario.id} (${scenario.title})`);
    printInfo("[OpenPocket][test] Building and deploying PermissionLab for scenario run...");
    const deployed = await permissionLab.deploy({
      deviceId: params.deviceId ?? undefined,
      launch: false,
      clean: params.clean,
    });
    runtimeConfig.agent.deviceId = deployed.deviceId;
    printKeyValue("Device", deployed.deviceId, "accent");
    printKeyValue("Install", deployed.installOutput || "ok", "success");
    printKeyValue("Reset", permissionLab.reset(deployed.deviceId));
    printKeyValue("Launch", permissionLab.launch(deployed.deviceId, scenario.id));

    const task = permissionLab.agentTaskForScenario(scenario.id);
    await sendTelegramMessage(tokenInfo.token, {
      chat_id: chatId,
      text: [
        `[PermissionLab] Case started: ${scenario.id}`,
        `Button: ${scenario.buttonLabel}`,
        "Agent is now running in emulator. You will receive a link only when human authorization is required.",
      ].join("\n"),
    });

    const result = await agent.runTask(
      task,
      params.modelName?.trim() ? params.modelName.trim() : undefined,
      undefined,
      async (request) => {
        const timeoutSec = Math.max(30, Math.round(request.timeoutSec));
        return humanAuth.requestAndWait(
          {
            chatId,
            task,
            request: { ...request, timeoutSec },
          },
          async (opened) => {
            const lines = [
              `[PermissionLab] Human authorization required (${request.capability})`,
              `Case: ${scenario.id}`,
              `Request ID: ${opened.requestId}`,
              `Current app: ${request.currentApp}`,
              `Instruction: ${request.instruction}`,
              `Reason: ${request.reason || "no reason provided"}`,
              `Expires at: ${opened.expiresAt}`,
            ];
            const payload: TelegramSendMessageParams = {
              chat_id: chatId,
              text: lines.join("\n"),
            };
            if (opened.openUrl) {
              payload.reply_markup = {
                inline_keyboard: [[{ text: "Open Human Auth", url: opened.openUrl }]],
              };
            } else {
              payload.text += "\nWeb link unavailable. Check human-auth relay configuration.";
            }
            await sendTelegramMessage(tokenInfo.token, payload);
          },
        );
      },
    );

    await sendTelegramMessage(tokenInfo.token, {
      chat_id: chatId,
      text: result.ok
        ? `[PermissionLab] Case ${scenario.id} completed.\nResult: ${result.message || "Completed."}`
        : `[PermissionLab] Case ${scenario.id} failed.\nReason: ${result.message || "Unknown error."}`,
    });
    if (result.ok) {
      printSuccess(`[OpenPocket][test] Scenario completed. ok=${result.ok}`);
    } else {
      printWarn(`[OpenPocket][test] Scenario completed. ok=${result.ok}`);
    }
    printInfo(`[OpenPocket][test] Result: ${result.message}`);
    printRaw(`[OpenPocket][test] Session: ${result.sessionPath}`);
    return result.ok ? 0 : 1;
  } finally {
    if (localStackStarted) {
      await localStack.stop();
      printInfo("[OpenPocket][test] Local human-auth relay stack stopped.");
    }
  }
}

async function runTestCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const target = (args[0] ?? "").trim();
  if (target !== "permission-app") {
    throw new Error(
      "Unknown test target. Use: test permission-app [deploy|install|launch|reset|uninstall|task|run|cases] [--device <id>] [--clean]",
    );
  }

  const hasClean = args.includes("--clean");
  const sendToTelegram = args.includes("--send");
  const withoutFlags = args.filter((item) => item !== "--clean" && item !== "--send");
  const { value: deviceId, rest: afterDevice } = takeOption(withoutFlags.slice(1), "--device");
  const { value: chatIdRaw, rest: afterChat } = takeOption(afterDevice, "--chat");
  const { value: scenarioIdRaw, rest: afterScenario } = takeOption(afterChat, "--case");
  const { value: modelNameRaw, rest } = takeOption(afterScenario, "--model");
  if (rest.length > 1) {
    throw new Error(`Unexpected test arguments: ${rest.slice(1).join(" ")}`);
  }
  const action = (rest[0] ?? "deploy").trim();

  const cfg = loadConfig(configPath);
  const permissionLab = new PermissionLabManager(cfg);
  const scenarioId = scenarioIdRaw?.trim() || null;
  const modelName = modelNameRaw?.trim() || null;

  if (action === "cases") {
    const scenarios = permissionLab.listScenarios();
    printRaw(cliTheme.section("Permission-app Scenarios"));
    for (const scenario of scenarios) {
      printRaw(`- ${scenario.id}: ${scenario.title} | button="${scenario.buttonLabel}" | ${scenario.summary}`);
    }
    return 0;
  }

  if (action === "task") {
    const taskText = permissionLab.recommendedTelegramTask(scenarioId);
    if (!sendToTelegram) {
      printRaw(cliTheme.section("Recommended Task"));
      printRaw(taskText);
      printInfo("Tip: add `--send` to run this scenario end-to-end (agent auto-click + Telegram human-auth link).");
      return 0;
    }

    return runPermissionLabScenario({
      config: cfg,
      scenarioId,
      deviceId: deviceId ?? null,
      chatIdRaw,
      modelName,
      clean: hasClean,
    });
  }

  if (action === "run") {
    return runPermissionLabScenario({
      config: cfg,
      scenarioId,
      deviceId: deviceId ?? null,
      chatIdRaw,
      modelName,
      clean: hasClean,
    });
  }

  if (action === "deploy" || action === "install") {
    const shouldLaunch = action === "deploy";
    printRaw(cliTheme.section("PermissionLab Deploy"));
    printInfo("[OpenPocket][test] Building and deploying Android PermissionLab...");
    const deployed = await permissionLab.deploy({
      deviceId: deviceId ?? undefined,
      launch: shouldLaunch,
      clean: hasClean,
    });
    printKeyValue("APK", deployed.apkPath, "accent");
    printKeyValue("Device", deployed.deviceId, "accent");
    printKeyValue("SDK", deployed.sdkRoot);
    printKeyValue("Build-tools", `${deployed.buildToolsVersion} | Platform: ${deployed.platformVersion}`);
    printKeyValue("Install", deployed.installOutput || "ok", "success");
    if (deployed.launchOutput) {
      printKeyValue("Launch", deployed.launchOutput);
    }
    printRaw(cliTheme.label("SUGGESTED TASK", "accent"));
    printRaw(permissionLab.recommendedTelegramTask(scenarioId));
    return 0;
  }

  if (action === "launch") {
    printInfo(permissionLab.launch(deviceId ?? undefined));
    return 0;
  }

  if (action === "reset") {
    printInfo(permissionLab.reset(deviceId ?? undefined));
    return 0;
  }

  if (action === "uninstall") {
    printInfo(permissionLab.uninstall(deviceId ?? undefined));
    return 0;
  }

  throw new Error(
    `Unknown permission-app action: ${action}. Use deploy|install|launch|reset|uninstall|task|run|cases`,
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { value: configPath, rest } = takeOption(argv, "--config");

  if (rest.length === 0 || rest[0] === "-h" || rest[0] === "--help") {
    printHelp();
    return 0;
  }

  const command = rest[0];

  if (command === "init") {
    printWarn("[OpenPocket] `init` is deprecated. Use `openpocket onboard`.");
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (interactive) {
      return runOnboardCommand(configPath ?? undefined);
    }
    const cfg = await runBootstrapCommand(configPath ?? undefined);
    printSuccess(`OpenPocket bootstrap completed.\nConfig: ${cfg.configPath}`);
    printInfo("Run `openpocket onboard` in an interactive terminal to complete consent/model/API key onboarding.");
    return 0;
  }

  if (command === "install-cli") {
    return runInstallCliCommand();
  }

  if (command === "config-show") {
    const cfg = loadConfig(configPath ?? undefined);
    printRaw(fs.readFileSync(cfg.configPath, "utf-8").trim());
    return 0;
  }

  if (command === "target") {
    return runTargetCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "emulator") {
    return runEmulatorCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "agent") {
    return runAgentCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "gateway") {
    return runGatewayCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "telegram") {
    return runTelegramSetupCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "dashboard") {
    return runDashboardCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "human-auth-relay") {
    return runHumanAuthRelayCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "test") {
    return runTestCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "skills") {
    return runSkillsCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "script") {
    return runScriptCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "setup") {
    printWarn("[OpenPocket] `setup` is deprecated. Use `openpocket onboard`.");
    return runOnboardCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "onboard") {
    return runOnboardCommand(configPath ?? undefined, rest.slice(1));
  }

  throw new Error(`Unknown command: ${command}`);
}

const isMainEntry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMainEntry) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(cliTheme.error(`OpenPocket error: ${formatCliError(error)}`));
      process.exitCode = 1;
    });
}
