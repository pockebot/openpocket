#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";

import { AgentRuntime } from "./agent/agent-runtime.js";
import { loadConfig, saveConfig } from "./config/index.js";
import { EmulatorManager } from "./device/emulator-manager.js";
import { TelegramGateway } from "./gateway/telegram-gateway.js";
import { createGateway } from "./gateway/gateway-factory.js";
import type { GatewayCore } from "./gateway/gateway-core.js";
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
  openpocket [--config <path>] target set --type <emulator|physical-phone|android-tv|cloud> [--device <id>] [--adb-endpoint <host[:port]>]
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
  openpocket [--config <path>] channels login --channel <name>
  openpocket [--config <path>] channels whoami [--channel <name>]
  openpocket [--config <path>] channels list
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
  openpocket target set --type physical-phone
  openpocket target set --type physical-phone --adb-endpoint 192.168.1.25:5555
  openpocket target set --type physical-phone --device R5CX123456A
  openpocket emulator start
  openpocket emulator tap --x 120 --y 300
  openpocket agent --model gpt-5.2-codex "Open Chrome and search weather"
  openpocket skills list
  openpocket script run --text "echo hello"
  openpocket channels login --channel whatsapp
  openpocket channels whoami --channel telegram
  openpocket channels list
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

function printTargetSummary(cfg: OpenPocketConfig): void {
  printRaw(cliTheme.section("Deployment Target"));
  printKeyValue("Type", `${cfg.target.type} (${deviceTargetLabel(cfg.target.type)})`, "accent");
  printKeyValue("Preferred device", cfg.agent.deviceId?.trim() || "(auto)");
  printKeyValue("ADB endpoint", cfg.target.adbEndpoint.trim() || "(none)");
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
  let status: { devices: string[] };
  try {
    status = emulator.status();
  } catch (error) {
    printWarn(`Unable to query adb device list: ${(error as Error).message}`);
    return [];
  }
  return status.devices.map((deviceId) => {
    const manufacturer = adbDeviceProp(emulator, deviceId, "ro.product.manufacturer");
    const model = adbDeviceProp(emulator, deviceId, "ro.product.model");
    const release = adbDeviceProp(emulator, deviceId, "ro.build.version.release");
    const pieces = [manufacturer, model].map((v) => v.trim()).filter(Boolean);
    const modelText = pieces.length > 0 ? pieces.join(" ") : "Unknown model";
    const versionText = release ? `Android ${release}` : "Android (unknown)";
    return {
      deviceId,
      hint: `${modelText} | ${versionText}`,
    };
  });
}

async function chooseTargetDeviceId(
  candidates: ConnectedTargetDevice[],
  configuredDeviceId: string | null,
): Promise<string | null> {
  if (candidates.length === 0) {
    printWarn("No online adb device detected for this target. Keep preferred device as auto mode.");
    return configuredDeviceId?.trim() ? configuredDeviceId : null;
  }
  if (candidates.length === 1) {
    const only = candidates[0];
    printInfo(`Detected one device and selected it automatically: ${only.deviceId} (${only.hint})`);
    return only.deviceId;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printWarn(
      `Detected ${candidates.length} devices, but current shell is non-interactive; keep preferred device as auto mode.`,
    );
    return configuredDeviceId?.trim() ? configuredDeviceId : null;
  }

  const autoValue = "__auto__";
  const configured = configuredDeviceId?.trim() || "";
  const options: CliSelectOption<string>[] = [
    {
      value: autoValue,
      label: "Auto-select device at runtime",
      hint: "No fixed serial in config",
    },
    ...candidates.map((item) => ({
      value: item.deviceId,
      label: item.deviceId,
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
    return selected;
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

async function runTargetCommand(configPath: string | undefined, args: string[]): Promise<number> {
  const sub = (args[0] ?? "show").trim();
  if (sub !== "show" && sub !== "set") {
    throw new Error(`Unknown target subcommand: ${sub}. Use: target show|set`);
  }

  const cfg = loadConfig(configPath);
  if (sub === "show") {
    printTargetSummary(cfg);
    return 0;
  }

  ensureGatewayStoppedForTargetSwitch();

  const clearDevice = args.includes("--clear-device");
  const clearAdbEndpoint = args.includes("--clear-adb-endpoint");
  const withoutFlags = args.filter((item) => item !== "--clear-device" && item !== "--clear-adb-endpoint");

  const { value: typeRaw, rest: afterType } = takeOption(withoutFlags.slice(1), "--type");
  const { value: deviceIdRaw, rest: afterDevice } = takeOption(afterType, "--device");
  const { value: adbEndpointRaw, rest: afterEndpoint } = takeOption(afterDevice, "--adb-endpoint");
  const { value: cloudProviderRaw, rest } = takeOption(afterEndpoint, "--cloud-provider");
  if (rest.length > 0) {
    throw new Error(`Unexpected target arguments: ${rest.join(" ")}`);
  }

  if (!typeRaw && !deviceIdRaw && !adbEndpointRaw && !cloudProviderRaw && !clearDevice && !clearAdbEndpoint) {
    throw new Error(
      "No target update provided. Use --type/--device/--adb-endpoint/--cloud-provider or --clear-device/--clear-adb-endpoint.",
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
    cfg.agent.deviceId = await chooseTargetDeviceId(candidates, cfg.agent.deviceId);
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
  const result = await agent.runTask(task, model ?? undefined);
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
    const tg = cfg.channels?.telegram;
    const envName = tg?.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
    const hasConfigToken = (tg?.botToken ?? "").trim().length > 0;
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
    printRaw(createOpenPocketBanner({ subtitle: "GATEWAY STARTUP", stream: output }));
    printRaw(cliTheme.section("Gateway Startup"));
    printKeyValue("Config", cfg.configPath);
    printKeyValue("Project", cfg.projectName, "accent");
    printKeyValue("Model", cfg.defaultModel, "accent");
    printKeyValue("Target", `${cfg.target.type} (${deviceTargetLabel(cfg.target.type)})`, "accent");
    printKeyValue("Device", cfg.agent.deviceId?.trim() || "(auto)");

    const tgSource = tokenSourceLabel(cfg);
    printKeyValue("Telegram", tgSource, tgSource.startsWith("missing") ? "warn" : "success");
    if (cfg.channels?.discord && cfg.channels.discord.enabled !== false) {
      printKeyValue("Discord", "configured", "success");
    }
    if (cfg.channels?.whatsapp && cfg.channels.whatsapp.enabled !== false) {
      printKeyValue("WhatsApp", "configured", "success");
    }
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
      const tgCfg = cfg.channels?.telegram;
      const envName = tgCfg?.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
      const hasToken = Boolean((tgCfg?.botToken ?? "").trim() || process.env[envName]?.trim());
      const hasWhatsApp = cfg.channels?.whatsapp?.enabled !== false && !!cfg.channels?.whatsapp;
      const hasDiscord = (() => {
        const dc = cfg.channels?.discord;
        if (!dc || dc.enabled === false) return false;
        const t = dc.token?.trim() || (dc.tokenEnv ? process.env[dc.tokenEnv]?.trim() : "") || "";
        return t.length > 0;
      })();
      const channelList = [
        hasToken ? "telegram" : null,
        hasDiscord ? "discord" : null,
        hasWhatsApp ? "whatsapp" : null,
      ].filter(Boolean);
      const totalSteps = 6;
      let gateway: GatewayCore | null = null;
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
      if (channelList.length === 0) {
        printStartupStep(2, totalSteps, "Validate channels", "failed", "no channels configured");
        throw new Error(
          "No messaging channels configured. Run `openpocket onboard` to set up Telegram, Discord, or WhatsApp.",
        );
      }
      printStartupStep(2, totalSteps, "Validate channels", "ok", channelList.join(", "));

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
      const logLine = (line: string) => {
        printRuntimeLine(line);
        dashboard?.ingestExternalLogLine(line);
      };
      const { core } = createGateway(cfg, {
        logger: logLine,
      });
      gateway = core;
      printStartupStep(5, totalSteps, "Initialize gateway runtime", "ok", `ready (${channelList.join(", ")})`);
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
  const tg = cfg.channels?.telegram;
  const envName = tg?.botTokenEnv?.trim() || "TELEGRAM_BOT_TOKEN";
  const configToken = (tg?.botToken ?? "").trim();
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
  const legacyIds = cfg.telegram?.allowedChatIds ?? [];
  const channelAllowFrom = (cfg.channels?.telegram?.allowFrom ?? []).map(Number).filter(Number.isFinite);
  const chatIds = channelAllowFrom.length > 0 ? channelAllowFrom : legacyIds;
  if (chatIds.length === 1) {
    return chatIds[0];
  }
  if (chatIds.length > 1) {
    throw new Error(
      `Multiple allowed chat IDs configured (${chatIds.join(", ")}). Use --chat <id>.`,
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
  const tg = cfg.channels?.telegram;
  const allowFrom = tg?.allowFrom ?? [];
  const dmPolicy = tg?.dmPolicy ?? "pairing";
  const groupPolicy = tg?.groupPolicy ?? "open";

  printRaw(cliTheme.section("Telegram Identity"));
  printKeyValue("Token source", tokenInfo.source, tokenInfo.token ? "success" : "warn");
  printKeyValue("DM policy", dmPolicy);
  printKeyValue("Group policy", groupPolicy);
  printKeyValue(
    "Allow from",
    allowFrom.length > 0 ? allowFrom.join(", ") : "empty (owner claim on first message)",
  );

  const pairingDir = cfg.pairing?.stateDir ?? path.join(cfg.stateDir, "pairing");
  const tgAllowFile = path.join(pairingDir, "telegram-allowFrom.json");
  if (fs.existsSync(tgAllowFile)) {
    try {
      const raw = fs.readFileSync(tgAllowFile, "utf-8").trim();
      const entries = JSON.parse(raw);
      if (Array.isArray(entries) && entries.length > 0) {
        printRaw(cliTheme.section("Approved Senders (via pairing)"));
        for (const e of entries) {
          const id = typeof e === "string" ? e : e.senderId;
          const at = typeof e === "object" && e.approvedAt ? ` (${e.approvedAt})` : "";
          printRaw(`  - ${id}${at}`);
        }
      }
    } catch { /* ignore */ }
  }

  if (!tokenInfo.token) {
    printWarn(`Telegram token is not configured. Set channels.telegram.botToken in config or env ${tokenInfo.envName}.`);
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
      printInfo("Send one message to your bot in Telegram, then run `openpocket channels whoami --channel telegram` again.");
      return 0;
    }

    printRaw(cliTheme.section("Discovered Chat IDs"));
    for (const chat of seen.values()) {
      const allowed = allowFrom.length === 0 || allowFrom.includes(String(chat.id));
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

async function runPairingCommand(
  configPath: string | undefined,
  args: string[],
): Promise<number> {
  const sub = (args[0] ?? "").trim();
  if (!sub || !["list", "approve", "reject", "approved", "add"].includes(sub)) {
    printRaw(cliTheme.section("Pairing Commands"));
    printRaw("  openpocket pairing list [channel]           List pending pairing requests");
    printRaw("  openpocket pairing approved [channel]       List approved (paired) senders");
    printRaw("  openpocket pairing approve <channel> <code> Approve a pairing request");
    printRaw("  openpocket pairing reject <channel> <code>  Reject a pairing request");
    printRaw("  openpocket pairing add <channel> <senderId> Manually add sender to allowlist");
    printRaw("");
    printInfo("Channels: telegram, whatsapp, discord");
    return 0;
  }

  const cfg = loadConfig(configPath);
  const { FilePairingStore } = await import("./channel/pairing.js");
  const pairingStore = new FilePairingStore({
    stateDir: cfg.pairing?.stateDir ?? path.join(cfg.stateDir, "pairing"),
    codeLength: cfg.pairing?.codeLength,
    expiresAfterSec: cfg.pairing?.expiresAfterSec,
    maxPendingPerChannel: cfg.pairing?.maxPendingPerChannel,
  });

  if (sub === "list") {
    const channelFilter = args[1]?.trim() as import("./channel/types.js").ChannelType | undefined;
    const pending = pairingStore.listPending(channelFilter);
    if (pending.length === 0) {
      printInfo(channelFilter
        ? `No pending pairing requests for ${channelFilter}.`
        : "No pending pairing requests.");
      return 0;
    }
    printRaw(cliTheme.section(`Pending Pairings (${pending.length})`));
    for (const p of pending) {
      printRaw(`  [${p.channelType}] code=${p.code}  sender=${p.senderId} (${p.senderName ?? "unknown"})  expires=${p.expiresAt}`);
    }
    return 0;
  }

  if (sub === "approved") {
    const channels: import("./channel/types.js").ChannelType[] = args[1]?.trim()
      ? [args[1].trim() as import("./channel/types.js").ChannelType]
      : ["telegram", "discord", "whatsapp"];
    let total = 0;
    for (const ch of channels) {
      const approved = pairingStore.listApproved(ch);
      if (approved.length > 0) {
        printRaw(cliTheme.section(`Approved Senders — ${ch} (${approved.length})`));
        for (const id of approved) {
          printRaw(`  ${id}`);
        }
        total += approved.length;
      }
    }
    if (total === 0) {
      printInfo("No approved senders found. The first person to message the bot will be auto-registered as owner.");
    }
    return 0;
  }

  if (sub === "approve" || sub === "reject") {
    const channel = args[1]?.trim();
    const code = args[2]?.trim();
    if (!channel || !code) {
      printWarn(`Usage: openpocket pairing ${sub} <channel> <code>`);
      return 1;
    }
    const ok = sub === "approve"
      ? pairingStore.approvePairing(channel as import("./channel/types.js").ChannelType, code)
      : pairingStore.rejectPairing(channel as import("./channel/types.js").ChannelType, code);
    if (ok) {
      printSuccess(`Pairing ${code} ${sub === "approve" ? "approved" : "rejected"} on ${channel}.`);
    } else {
      printWarn(`Pairing code not found: ${code} (channel: ${channel})`);
    }
    return ok ? 0 : 1;
  }

  if (sub === "add") {
    const channel = args[1]?.trim();
    const senderId = args[2]?.trim();
    if (!channel || !senderId) {
      printWarn("Usage: openpocket pairing add <channel> <senderId>");
      return 1;
    }
    pairingStore.addToAllowlist(channel as import("./channel/types.js").ChannelType, senderId);
    printSuccess(`Sender ${senderId} added to ${channel} allowlist.`);
    return 0;
  }

  return 0;
}

async function runWhatsAppWhoamiCommand(cfg: ReturnType<typeof loadConfig>): Promise<number> {
  const wa = cfg.channels?.whatsapp;
  const dmPolicy = wa?.dmPolicy ?? "pairing";
  const groupPolicy = wa?.groupPolicy ?? "open";
  const allowFrom = wa?.allowFrom ?? [];
  const allowGroups = wa?.allowGroups ?? [];
  const authDir = path.join(cfg.stateDir, "whatsapp-auth");

  printRaw(cliTheme.section("WhatsApp Identity"));
  printKeyValue("Enabled", wa?.enabled !== false && !!wa ? "yes" : "no");
  printKeyValue("DM policy", dmPolicy);
  printKeyValue("Group policy", groupPolicy);
  printKeyValue(
    "Allow from",
    allowFrom.length > 0 ? allowFrom.join(", ") : "empty (owner claim on first message)",
  );
  if (allowGroups.length > 0) {
    printKeyValue("Allow groups", allowGroups.join(", "));
  }
  printKeyValue("Text chunk limit", String(wa?.textChunkLimit ?? 4000));
  printKeyValue("Chunk mode", wa?.chunkMode ?? "newline");
  printKeyValue("Read receipts", wa?.sendReadReceipts !== false ? "yes" : "no");
  if (wa?.proxyUrl) {
    printKeyValue("Proxy", wa.proxyUrl);
  }

  const hasSession = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
  printKeyValue("Session", hasSession ? "linked (auth files present)" : "not linked", hasSession ? "success" : "warn");

  if (!hasSession) {
    printInfo("Run `openpocket channels login --channel whatsapp` to scan QR code and link your phone.");
  }

  const waPairingDir = cfg.pairing?.stateDir ?? path.join(cfg.stateDir, "pairing");
  const waAllowFile = path.join(waPairingDir, "whatsapp-allowFrom.json");
  if (fs.existsSync(waAllowFile)) {
    try {
      const raw = fs.readFileSync(waAllowFile, "utf-8").trim();
      const entries = JSON.parse(raw);
      if (Array.isArray(entries) && entries.length > 0) {
        printRaw(cliTheme.section("Approved Senders (via pairing)"));
        for (const e of entries) {
          const id = typeof e === "string" ? e : e.senderId;
          const at = typeof e === "object" && e.approvedAt ? ` (${e.approvedAt})` : "";
          printRaw(`  - ${id}${at}`);
        }
      }
    } catch { /* ignore */ }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Discord whoami
// ---------------------------------------------------------------------------

async function runDiscordWhoamiCommand(cfg: ReturnType<typeof loadConfig>): Promise<number> {
  const dc = cfg.channels?.discord;
  const dmPolicy = dc?.dmPolicy ?? "pairing";
  const groupPolicy = dc?.groupPolicy ?? "open";
  const allowFrom = dc?.allowFrom ?? [];

  printRaw(cliTheme.section("Discord Identity"));
  printKeyValue("Enabled", dc?.enabled !== false && !!dc ? "yes" : "no");
  printKeyValue("DM policy", dmPolicy);
  printKeyValue("Group policy", groupPolicy);
  printKeyValue(
    "Allow from",
    allowFrom.length > 0 ? allowFrom.join(", ") : "empty (owner claim on first message)",
  );

  const hasToken = Boolean(
    dc?.token?.trim()
    || (dc?.tokenEnv ? process.env[dc.tokenEnv]?.trim() : "")
    || process.env.DISCORD_BOT_TOKEN?.trim(),
  );
  printKeyValue("Bot token", hasToken ? "configured" : "missing", hasToken ? "success" : "warn");
  printKeyValue("Ack reaction", dc?.ackReaction ?? "(disabled)");
  printKeyValue("Slash commands", dc?.slashCommands !== false ? "enabled" : "disabled");

  const guilds = dc?.guilds;
  if (guilds && Object.keys(guilds).length > 0) {
    printRaw(cliTheme.section("Guild Allowlist"));
    for (const [guildId, guildCfg] of Object.entries(guilds)) {
      const users = guildCfg.users ?? [];
      const roles = guildCfg.roles ?? [];
      const mention = guildCfg.requireMention ?? true;
      const channels = guildCfg.channels ? Object.keys(guildCfg.channels).join(", ") : "all";
      printRaw(`  Guild ${guildId}:`);
      printRaw(`    requireMention: ${mention}`);
      printRaw(`    users: ${users.length > 0 ? users.join(", ") : "(any)"}`);
      printRaw(`    roles: ${roles.length > 0 ? roles.join(", ") : "(none)"}`);
      printRaw(`    channels: ${channels}`);
    }
  }

  const dcPairingDir = cfg.pairing?.stateDir ?? path.join(cfg.stateDir, "pairing");
  const dcAllowFile = path.join(dcPairingDir, "discord-allowFrom.json");
  if (fs.existsSync(dcAllowFile)) {
    try {
      const raw = fs.readFileSync(dcAllowFile, "utf-8").trim();
      const entries = JSON.parse(raw);
      if (Array.isArray(entries) && entries.length > 0) {
        printRaw(cliTheme.section("Approved Senders (via pairing)"));
        for (const e of entries) {
          const id = typeof e === "string" ? e : e.senderId;
          const at = typeof e === "object" && e.approvedAt ? ` (${e.approvedAt})` : "";
          printRaw(`  - ${id}${at}`);
        }
      }
    } catch { /* ignore */ }
  }

  if (!hasToken) {
    printInfo("Set token: channels.discord.token in config, or env DISCORD_BOT_TOKEN");
  }

  return 0;
}

// ---------------------------------------------------------------------------
// iMessage whoami (macOS-only)
// ---------------------------------------------------------------------------

async function runIMessageWhoamiCommand(cfg: ReturnType<typeof loadConfig>): Promise<number> {
  const im = cfg.channels?.imessage;
  const dmPolicy = im?.dmPolicy ?? "pairing";
  const groupPolicy = im?.groupPolicy ?? "open";
  const allowFrom = im?.allowFrom ?? [];
  const chatDbPath = im?.chatDbPath ?? path.join(os.homedir(), "Library", "Messages", "chat.db");

  printRaw(cliTheme.section("iMessage Identity"));
  printKeyValue("Platform", process.platform === "darwin" ? "macOS (supported)" : `${process.platform} (not supported)`);
  printKeyValue("Enabled", im?.enabled !== false && !!im ? "yes" : "no");
  printKeyValue("DM policy", dmPolicy);
  printKeyValue("Group policy", groupPolicy);
  printKeyValue(
    "Allow from",
    allowFrom.length > 0 ? allowFrom.join(", ") : "empty (owner claim on first message)",
  );
  printKeyValue("Poll interval", `${im?.pollIntervalSec ?? 3}s`);

  const chatDbExists = fs.existsSync(chatDbPath);
  printKeyValue("chat.db", chatDbExists ? `found (${chatDbPath})` : `not found (${chatDbPath})`, chatDbExists ? "success" : "warn");

  const imsgInstalled = (() => {
    try { return spawnSync("which", ["imsg"], { timeout: 3000 }).status === 0; } catch { return false; }
  })();
  printKeyValue("imsg CLI", imsgInstalled ? "installed" : "not found — brew install steipete/tap/imsg", imsgInstalled ? "success" : "warn");

  if (!chatDbExists && process.platform === "darwin") {
    printInfo("Grant Full Disk Access to your terminal in System Settings > Privacy & Security.");
  }
  if (!imsgInstalled) {
    printInfo("Install imsg for iMessage support: brew install steipete/tap/imsg");
  }
  if (process.platform !== "darwin") {
    printWarn("iMessage is only available on macOS.");
    return 0;
  }

  const imPairingDir = cfg.pairing?.stateDir ?? path.join(cfg.stateDir, "pairing");
  const imAllowFile = path.join(imPairingDir, "imessage-allowFrom.json");
  if (fs.existsSync(imAllowFile)) {
    try {
      const raw = fs.readFileSync(imAllowFile, "utf-8").trim();
      const entries = JSON.parse(raw);
      if (Array.isArray(entries) && entries.length > 0) {
        printRaw(cliTheme.section("Approved Senders (via pairing)"));
        for (const e of entries) {
          const id = typeof e === "string" ? e : e.senderId;
          const at = typeof e === "object" && e.approvedAt ? ` (${e.approvedAt})` : "";
          printRaw(`  - ${id}${at}`);
        }
      }
    } catch { /* ignore */ }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Unified `channels` command (OpenClaw-aligned)
// ---------------------------------------------------------------------------

async function runChannelsCommand(
  configPath: string | undefined,
  args: string[],
): Promise<number> {
  const sub = (args[0] ?? "").trim();

  if (sub === "login") {
    const channel = extractChannelFlag(args);
    if (!channel) {
      printRaw(cliTheme.section("Channels Login"));
      printRaw("Usage: openpocket channels login --channel <name>");
      printRaw("");
      printInfo("Available channels: whatsapp, telegram, imessage");
      printRaw("  --channel whatsapp    Scan QR code to link WhatsApp");
      printRaw("  --channel telegram    Verify Telegram bot token");
      printRaw("  --channel imessage    Verify iMessage (macOS) setup");
      return 0;
    }
    if (channel === "whatsapp") {
      return runWhatsAppLoginCommand(configPath);
    }
    if (channel === "telegram") {
      const cfg = loadConfig(configPath);
      return runTelegramWhoamiCommand(cfg);
    }
    if (channel === "imessage") {
      const cfg = loadConfig(configPath);
      return runIMessageWhoamiCommand(cfg);
    }
    if (channel === "discord") {
      const cfg = loadConfig(configPath);
      return runDiscordWhoamiCommand(cfg);
    }
    throw new Error(`Unsupported channel for login: ${channel}. Available: whatsapp, telegram, imessage, discord`);
  }

  if (sub === "whoami") {
    const channel = extractChannelFlag(args);
    const cfg = loadConfig(configPath);
    if (!channel) {
      let printed = false;
      if (cfg.channels?.telegram) {
        await runTelegramWhoamiCommand(cfg);
        printed = true;
      }
      if (cfg.channels?.discord) {
        if (printed) printRaw("");
        await runDiscordWhoamiCommand(cfg);
        printed = true;
      }
      if (cfg.channels?.whatsapp) {
        if (printed) printRaw("");
        await runWhatsAppWhoamiCommand(cfg);
        printed = true;
      }
      if (cfg.channels?.imessage) {
        if (printed) printRaw("");
        await runIMessageWhoamiCommand(cfg);
        printed = true;
      }
      if (!printed) {
        printWarn("No channels configured. Run `openpocket onboard` first.");
      }
      return 0;
    }
    if (channel === "whatsapp") {
      return runWhatsAppWhoamiCommand(cfg);
    }
    if (channel === "telegram") {
      return runTelegramWhoamiCommand(cfg);
    }
    if (channel === "imessage") {
      return runIMessageWhoamiCommand(cfg);
    }
    if (channel === "discord") {
      return runDiscordWhoamiCommand(cfg);
    }
    throw new Error(`Unsupported channel for whoami: ${channel}. Available: whatsapp, telegram, imessage, discord`);
  }

  if (sub === "list") {
    const cfg = loadConfig(configPath);
    printRaw(cliTheme.section("Configured Channels"));
    const tg = cfg.channels?.telegram;
    const wa = cfg.channels?.whatsapp;
    const dc = cfg.channels?.discord;
    if (tg && tg.enabled !== false) {
      printKeyValue("telegram", `dmPolicy=${tg.dmPolicy ?? "pairing"}`, "success");
    }
    if (wa && wa.enabled !== false) {
      const authDir = path.join(cfg.stateDir, "whatsapp-auth");
      const linked = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
      printKeyValue("whatsapp", `dmPolicy=${wa.dmPolicy ?? "pairing"} session=${linked ? "linked" : "not linked"}`, linked ? "success" : "warn");
    }
    if (dc && dc.enabled !== false) {
      printKeyValue("discord", `dmPolicy=${dc.dmPolicy ?? "pairing"}`, "success");
    }
    const im = cfg.channels?.imessage;
    if (im && im.enabled !== false) {
      const chatDbExists = fs.existsSync(im.chatDbPath ?? path.join(os.homedir(), "Library", "Messages", "chat.db"));
      printKeyValue("imessage", `dmPolicy=${im.dmPolicy ?? "pairing"} chatDb=${chatDbExists ? "found" : "not found"}`, chatDbExists ? "success" : "warn");
    }
    if (!tg && !wa && !dc && !im) {
      printWarn("No channels configured.");
    }
    return 0;
  }

  printRaw(cliTheme.section("Channels Commands"));
  printRaw("  openpocket channels login  --channel <name>   Login / link a channel");
  printRaw("  openpocket channels whoami [--channel <name>]  Show channel identity & config");
  printRaw("  openpocket channels list                       List configured channels");
  printRaw("");
  printInfo("Available channels: telegram, whatsapp, discord, imessage");
  return 0;
}

function extractChannelFlag(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channel" && args[i + 1]) {
      return args[i + 1].trim().toLowerCase();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WhatsApp login (extracted from old runWhatsAppCommand)
// ---------------------------------------------------------------------------

async function runWhatsAppLoginCommand(
  configPath: string | undefined,
): Promise<number> {
  const cfg = loadConfig(configPath);
  const waConfig = cfg.channels?.whatsapp;
  if (!waConfig) {
    throw new Error(
      "WhatsApp channel is not configured. Run `openpocket onboard` first and enable WhatsApp.",
    );
  }

  const authDir = path.join(cfg.stateDir, "whatsapp-auth");

  printRaw(cliTheme.section("WhatsApp Link"));
  printInfo("Clearing old session and generating a new QR code...");

  if (fs.existsSync(authDir)) {
    const files = fs.readdirSync(authDir);
    for (const file of files) {
      fs.unlinkSync(path.join(authDir, file));
    }
    printInfo("Old session files removed.");
  }
  fs.mkdirSync(authDir, { recursive: true });

  const baileys = await import("baileys");
  const makeWASocket = baileys.default;
  const { useMultiFileAuthState, fetchLatestWaWebVersion, Browsers, DisconnectReason } = baileys;
  const { Boom } = await import("@hapi/boom");
  const { default: pino } = await import("pino");
  const QRCode = await import("qrcode");

  let waVersion: [number, number, number] | undefined;
  try {
    const { version } = await fetchLatestWaWebVersion({});
    waVersion = version;
    printInfo(`Using WA Web version: ${version.join(".")}`);
  } catch {
    printInfo("Could not fetch latest WA version, using default.");
  }

  const proxyUrl = waConfig.proxyUrl
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || null;

  let proxyAgent: any = null;
  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      proxyAgent = new HttpsProxyAgent(proxyUrl);
      printInfo(`Using proxy: ${proxyUrl}`);
    } catch { /* ignore */ }
  }

  const silentLogger = pino({ level: "silent" });
  const maxRetries = 5;
  let retryCount = 0;
  let settled = false;

  return new Promise<number>((resolve) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      printWarn("Timed out waiting for QR scan (120s). Run `openpocket channels login --channel whatsapp` to try again.");
      resolve(1);
    }, 120_000);

    async function startSocket(): Promise<void> {
      if (settled) return;

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const socketOpts: any = {
        auth: state,
        browser: Browsers.macOS("Chrome"),
        logger: silentLogger,
        ...(waVersion ? { version: waVersion } : {}),
      };
      if (proxyAgent) {
        socketOpts.agent = proxyAgent;
      }

      const sock = makeWASocket(socketOpts);
      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async (update) => {
        if (settled) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          printRaw("");
          printInfo("Scan this QR code with your phone:");
          printInfo("  WhatsApp > Settings > Linked Devices > Link a Device");
          printRaw("");
          try {
            const qrArt = await QRCode.toString(qr, { type: "utf8", errorCorrectionLevel: "L", margin: 2 });
            printRaw(qrArt.trimEnd());
          } catch {
            printInfo(`QR data: ${qr}`);
          }
          printRaw("");
        }

        if (connection === "open") {
          settled = true;
          clearTimeout(timeout);
          printSuccess("WhatsApp linked successfully! Session saved.");
          printInfo("You can now start the gateway with: openpocket gateway start");
          try { sock.ws.close(); sock.end(undefined); } catch { /* ignore */ }
          setTimeout(() => process.exit(0), 500);
          resolve(0);
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          if (isLoggedOut) {
            settled = true;
            clearTimeout(timeout);
            printWarn("WhatsApp rejected the session (logged out). Run `openpocket channels login --channel whatsapp` to try again.");
            resolve(1);
            return;
          }

          retryCount++;
          if (retryCount > maxRetries) {
            settled = true;
            clearTimeout(timeout);
            printWarn(`Connection failed after ${maxRetries} retries. Run \`openpocket channels login --channel whatsapp\` to try again.`);
            resolve(1);
            return;
          }

          printInfo(`Connection interrupted (status=${statusCode ?? "unknown"}), reconnecting (${retryCount}/${maxRetries})...`);
          setTimeout(() => { void startSocket(); }, 2000);
        }
      });
    }

    void startSocket();
  });
}

async function runTelegramCommand(
  configPath: string | undefined,
  args: string[],
): Promise<number> {
  const sub = (args[0] ?? "").trim();
  if (sub === "whoami") {
    printWarn("`openpocket telegram whoami` is deprecated. Use `openpocket channels whoami --channel telegram`.");
    const cfg = loadConfig(configPath);
    return runTelegramWhoamiCommand(cfg);
  }

  printRaw(cliTheme.section("Telegram Commands (deprecated — use `openpocket channels`)"));
  printRaw("  openpocket channels whoami --channel telegram    Show Telegram identity");
  printRaw("  openpocket channels login  --channel telegram    Verify bot token");
  printRaw("");
  printInfo("To configure Telegram, edit ~/.openpocket/config.json:");
  printRaw('  channels.telegram.botToken = "YOUR_TOKEN"');
  printRaw("  or set env: export TELEGRAM_BOT_TOKEN=YOUR_TOKEN");
  printRaw("");
  printInfo("Then start the gateway: openpocket gateway start");
  return 0;
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
    throw new Error(`Telegram bot token is empty. Set channels.telegram.botToken in config or env ${tokenInfo.envName}.`);
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

  if (command === "channels") {
    return runChannelsCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "telegram") {
    return runTelegramCommand(configPath ?? undefined, rest.slice(1));
  }

  if (command === "whatsapp") {
    const sub = (rest[1] ?? "").trim();
    if (sub === "link") {
      printWarn("`openpocket whatsapp link` is deprecated. Use `openpocket channels login --channel whatsapp`.");
      return runWhatsAppLoginCommand(configPath ?? undefined);
    }
    if (sub === "whoami") {
      printWarn("`openpocket whatsapp whoami` is deprecated. Use `openpocket channels whoami --channel whatsapp`.");
      const cfg = loadConfig(configPath ?? undefined);
      return runWhatsAppWhoamiCommand(cfg);
    }
    printWarn("`openpocket whatsapp` is deprecated. Use `openpocket channels` instead.");
    return runChannelsCommand(configPath ?? undefined, []);
  }

  if (command === "pairing") {
    return runPairingCommand(configPath ?? undefined, rest.slice(1));
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
