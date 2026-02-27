import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

import type { EmulatorStatus, ModelProfile, OpenPocketConfig } from "../types.js";
import { saveConfig } from "../config/index.js";
import { readCodexCliCredential } from "../config/codex-cli.js";
import { ensureDir, nowIso } from "../utils/paths.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import {
  deviceTargetLabel,
  isEmulatorTarget,
  normalizeDeviceTargetType,
} from "../device/target-types.js";

const require = createRequire(import.meta.url);
const pkgJson = require("../../package.json") as { version: string; license: string };

const OPENPOCKET_ASCII = [
  "  ██████╗  ██████╗  ███████╗ ███╗   ██╗ ██████╗   ██████╗   ██████╗ ██╗  ██╗  ███████╗ ████████╗",
  " ██╔═══██╗ ██╔══██╗ ██╔════╝ ████╗  ██║ ██╔══██╗ ██╔═══██╗ ██╔════╝ ██║ ██╔╝  ██╔════╝ ╚══██╔══╝",
  " ██║   ██║ ██████╔╝ █████╗   ██╔██╗ ██║ ██████╔╝ ██║   ██║ ██║      █████╔╝   █████╗      ██║   ",
  " ██║   ██║ ██╔═══╝  ██╔══╝   ██║╚██╗██║ ██╔═══╝  ██║   ██║ ██║      ██╔═██╗   ██╔══╝      ██║   ",
  " ╚██████╔╝ ██║      ███████╗ ██║ ╚████║ ██║      ╚██████╔╝ ╚██████╗ ██║  ██╗  ███████╗    ██║   ",
  "  ╚═════╝  ╚═╝      ╚══════╝ ╚═╝  ╚═══╝ ╚═╝       ╚═════╝   ╚═════╝ ╚═╝  ╚═╝  ╚══════╝    ╚═╝   ",
];

const SETUP_WIZARD_ASCII = "                             🤖  SETUP WIZARD                             ";

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD_WHITE = "\u001b[1;37m";
const ANSI_BOLD_CYAN = "\u001b[1;36m";
const ANSI_BOLD_GREEN = "\u001b[1;32m";
const ANSI_BOLD_YELLOW = "\u001b[1;33m";
const ANSI_DIM = "\u001b[2m";
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface SetupState {
  updatedAt: string;
  consentAcceptedAt?: string;
  targetType?: string;
  targetConfiguredAt?: string;
  targetAdbEndpoint?: string;
  targetCloudProvider?: string;
  targetConnectionMode?: "usb" | "wifi";
  modelProfile?: string;
  modelProvider?: string;
  modelConfiguredAt?: string;
  apiKeyEnv?: string;
  apiKeySource?: "env" | "config" | "codex-cli" | "skipped";
  apiKeyConfiguredAt?: string;
  emulatorStartedAt?: string;
  gmailLoginConfirmedAt?: string;
  playStoreDetected?: boolean | null;
  telegramConfiguredAt?: string;
  telegramTokenSource?: "env" | "config" | "skip";
  telegramAllowedChatMode?: "keep" | "open" | "set";
  channelsConfiguredAt?: string;
  enabledChannels?: string[];
  discordConfiguredAt?: string;
  discordTokenSource?: "env" | "config" | "skip";
  whatsappConfiguredAt?: string;
  humanAuthEnabledAt?: string;
  humanAuthMode?: "disabled" | "lan" | "ngrok";
  ngrokConfiguredAt?: string;
}

type ModelAuthMode = "api-key" | "codex-cli";

type ModelSelectionResult = {
  profileKey: string;
  authMode: ModelAuthMode;
};

type ApiKeyChoice = "env" | "config" | "skip" | "config-existing";
type TokenChoice = "env" | "config" | "skip" | "config-existing";

type SelectOption<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

type Keypress = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
};

type SetupPrompter = {
  intro: (title: string) => Promise<void>;
  note: (title: string, body: string) => Promise<void>;
  select: <T extends string>(message: string, options: SelectOption<T>[], initialValue?: T) => Promise<T>;
  confirm: (message: string, initialValue?: boolean) => Promise<boolean>;
  text: (message: string, initialValue?: string, validate?: (value: string) => string | null) => Promise<string>;
  secret: (message: string, validate?: (value: string) => string | null) => Promise<string>;
  pause: (message: string) => Promise<void>;
  outro: (message: string) => Promise<void>;
  close: () => Promise<void>;
};

type SetupEmulator = {
  start: (headless?: boolean) => Promise<string>;
  showWindow: () => string;
  status: () => EmulatorStatus;
  runAdb: (args: string[], timeoutMs?: number) => string;
};

export type RunSetupOptions = {
  prompter?: SetupPrompter;
  emulator?: SetupEmulator;
  skipTtyCheck?: boolean;
  printHeader?: boolean;
  codexCliLoginRunner?: () => Promise<CodexCliLoginResult>;
};

function shouldUseColor(stream: NodeJS.WriteStream = output): boolean {
  if (!stream.isTTY) {
    return false;
  }
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR?.trim() === "0") {
    return false;
  }
  return true;
}

function colorize(text: string, ansiCode: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  return `${ansiCode}${text}${ANSI_RESET}`;
}

function printHeader(): void {
  const useColor = shouldUseColor(output);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const meta = [
    colorize(`  Version: ${pkgJson.version}  |  Author: Sergio  |  License: ${pkgJson.license}`, ANSI_DIM, useColor),
    colorize(`  ${timestamp}`, ANSI_DIM, useColor),
    "",
  ];
  const header = OPENPOCKET_ASCII.map((line) => colorize(line, ANSI_BOLD_WHITE, useColor));
  // eslint-disable-next-line no-console
  console.log(
    [
      ...header,
      colorize(SETUP_WIZARD_ASCII, ANSI_BOLD_YELLOW, useColor),
      "",
      ...meta,
    ].join("\n"),
  );
}

function onboardingStatePath(config: OpenPocketConfig): string {
  ensureDir(config.stateDir);
  return path.join(config.stateDir, "onboarding.json");
}

function loadState(config: OpenPocketConfig): SetupState {
  const statePath = onboardingStatePath(config);
  if (!fs.existsSync(statePath)) {
    return { updatedAt: nowIso() };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as SetupState;
    return parsed && typeof parsed === "object" ? parsed : { updatedAt: nowIso() };
  } catch {
    return { updatedAt: nowIso() };
  }
}

function saveState(config: OpenPocketConfig, state: SetupState): void {
  const statePath = onboardingStatePath(config);
  state.updatedAt = nowIso();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function providerFromBaseUrl(baseUrl: string): string {
  const lower = baseUrl.toLowerCase();
  if (lower.includes("api.openai.com")) {
    return "OpenAI";
  }
  if (lower.includes("openrouter.ai")) {
    return "OpenRouter";
  }
  if (lower.includes("api.z.ai")) {
    return "AutoGLM";
  }
  try {
    const host = new URL(baseUrl).host;
    return host || "custom";
  } catch {
    return "custom";
  }
}

function providerKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return baseUrl.toLowerCase().trim();
  }
}

function applyProviderApiKey(config: OpenPocketConfig, targetModelKey: string, apiKey: string): string[] {
  const target = config.models[targetModelKey];
  if (!target) {
    return [];
  }
  const targetProvider = providerKey(target.baseUrl);
  const updated: string[] = [];
  for (const [name, profile] of Object.entries(config.models)) {
    const sameProvider =
      providerKey(profile.baseUrl) === targetProvider || profile.apiKeyEnv === target.apiKeyEnv;
    if (sameProvider) {
      profile.apiKey = apiKey;
      profile.apiKeyEnv = target.apiKeyEnv;
      updated.push(name);
    }
  }
  return updated;
}

function modelOptionLabel(profileKey: string, profile: ModelProfile): string {
  if (profileKey === "gpt-5.2-codex") {
    return "GPT-5.2 Codex (OpenAI)";
  }
  if (profileKey === "gpt-5.3-codex") {
    return "GPT-5.3 Codex (OpenAI)";
  }
  if (profileKey === "claude-sonnet-4.6") {
    return "Claude Sonnet 4.6 (OpenRouter)";
  }
  if (profileKey === "claude-opus-4.6") {
    return "Claude Opus 4.6 (OpenRouter)";
  }
  if (profileKey === "autoglm-phone") {
    return "AutoGLM Phone (Z.ai)";
  }
  return `${profile.model} (${providerFromBaseUrl(profile.baseUrl)})`;
}

function isOpenAiLikeHost(baseUrl: string): boolean {
  const lower = baseUrl.toLowerCase();
  return lower.includes("openai.com") || lower.includes("chatgpt.com");
}

function isCodexCliCapableModel(profile: ModelProfile): boolean {
  return profile.model.toLowerCase().includes("codex") && isOpenAiLikeHost(profile.baseUrl);
}

function modelSelectionValue(profileKey: string, authMode: ModelAuthMode): string {
  return authMode === "codex-cli" ? `${profileKey}::codex-cli` : profileKey;
}

function parseModelSelectionValue(value: string): ModelSelectionResult {
  const marker = "::codex-cli";
  if (value.endsWith(marker)) {
    return {
      profileKey: value.slice(0, -marker.length),
      authMode: "codex-cli",
    };
  }
  return {
    profileKey: value,
    authMode: "api-key",
  };
}

function resolveCodexHomeForDisplay(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? raw : "~/.codex";
}

export type CodexCliLoginCommandOptions = {
  spawnProcess?: typeof spawn;
  signalSource?: Pick<NodeJS.Process, "on" | "removeListener">;
  timeoutMs?: number;
};

export type CodexCliLoginResult = {
  ok: boolean;
  detail: string;
  cancelled?: boolean;
};

export async function runCodexCliLoginCommand(
  options: CodexCliLoginCommandOptions = {},
): Promise<CodexCliLoginResult> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const signalSource = options.signalSource ?? process;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Number(options.timeoutMs)
    : 15 * 60 * 1000;

  return new Promise((resolve) => {
    let settled = false;
    let cancelledByUser = false;
    let timedOut = false;

    let timeoutTimer: NodeJS.Timeout | null = null;
    let terminateTimer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (terminateTimer) {
        clearTimeout(terminateTimer);
        terminateTimer = null;
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };

    const settle = (result: CodexCliLoginResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      signalSource.removeListener("SIGINT", onInterrupt);
      signalSource.removeListener("SIGTERM", onInterrupt);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnProcess("codex", ["login"], {
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch (error) {
      const castError = error as NodeJS.ErrnoException;
      if (castError.code === "ENOENT") {
        settle({
          ok: false,
          detail: "`codex` command not found in PATH",
        });
      } else {
        settle({
          ok: false,
          detail: castError.message || "codex login failed to start",
        });
      }
      return;
    }

    const terminateChildWithEscalation = () => {
      if (child.exitCode !== null) {
        return;
      }
      try {
        child.kill("SIGINT");
      } catch {
        // Ignore terminate errors while cleaning up.
      }
      if (!terminateTimer) {
        terminateTimer = setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill("SIGTERM");
            } catch {
              // Ignore terminate errors while cleaning up.
            }
          }
        }, 1_000);
      }
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore terminate errors while cleaning up.
            }
          }
        }, 3_000);
      }
    };

    const onInterrupt = () => {
      cancelledByUser = true;
      terminateChildWithEscalation();
    };

    signalSource.on("SIGINT", onInterrupt);
    signalSource.on("SIGTERM", onInterrupt);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChildWithEscalation();
    }, timeoutMs);

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle({
          ok: false,
          detail: "`codex` command not found in PATH",
        });
        return;
      }
      settle({
        ok: false,
        detail: error.message || "codex login failed to start",
      });
    });

    child.once("exit", (code, signal) => {
      if (cancelledByUser) {
        settle({
          ok: false,
          detail: "codex login cancelled by user",
          cancelled: true,
        });
        return;
      }
      if (timedOut) {
        settle({
          ok: false,
          detail: `codex login timed out after ${Math.ceil(timeoutMs / 1000)}s`,
        });
        return;
      }
      if ((code ?? 1) === 0) {
        settle({ ok: true, detail: "codex login completed" });
        return;
      }
      if (signal) {
        settle({
          ok: false,
          detail: `codex login terminated by signal ${signal}`,
        });
        return;
      }
      settle({
        ok: false,
        detail: `codex login exited with status ${code ?? "unknown"}`,
      });
    });
  });
}

function detectPlayStore(emulator: SetupEmulator, preferredDeviceId: string | null): boolean | null {
  const status = emulator.status();
  const deviceId =
    preferredDeviceId && status.devices.includes(preferredDeviceId)
      ? preferredDeviceId
      : status.bootedDevices[0] ?? status.devices[0] ?? null;
  if (!deviceId) {
    return null;
  }
  try {
    const outputText = emulator.runAdb(["-s", deviceId, "shell", "pm", "path", "com.android.vending"]);
    return outputText.includes("package:");
  } catch {
    return false;
  }
}

function parseAllowedChatIdsInput(inputText: string): number[] {
  const chunks = inputText
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (chunks.length === 0) {
    return [];
  }

  const values = chunks.map((item) => Number(item));
  if (values.some((v) => !Number.isFinite(v))) {
    throw new Error("allowed chat id list contains non-numeric values.");
  }
  return values.map((v) => Math.trunc(v));
}

function isValidEnvVarName(value: string): boolean {
  return ENV_VAR_NAME_RE.test(value.trim());
}

function normalizeEnvVarName(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!isValidEnvVarName(trimmed)) {
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

function setTerminalEcho(enabled: boolean): boolean {
  if (process.platform === "win32") {
    return false;
  }
  const fd = (input as NodeJS.ReadStream & { fd?: number }).fd;
  if (typeof fd !== "number" || fd < 0) {
    return false;
  }
  try {
    const result = spawnSync("stty", [enabled ? "echo" : "-echo"], {
      stdio: [fd, "ignore", "ignore"],
      timeout: 1000,
    });
    return (result.status ?? 1) === 0;
  } catch {
    return false;
  }
}

function suspendKeypressListeners(stream: NodeJS.ReadStream): () => void {
  const listeners = stream.listeners("keypress") as Array<(...args: unknown[]) => void>;
  for (const listener of listeners) {
    stream.removeListener("keypress", listener);
  }
  return () => {
    for (const listener of listeners) {
      stream.on("keypress", listener);
    }
  };
}

async function promptSecretWithRetryOrSkip(
  prompter: SetupPrompter,
  message: string,
  valueLabel: string,
): Promise<string | null> {
  while (true) {
    const raw = await prompter.secret(message);
    const trimmed = raw.trim();
    if (trimmed) {
      return trimmed;
    }
    const choice = await prompter.select(
      `${valueLabel} cannot be empty. What do you want to do?`,
      [
        { value: "retry", label: "Retry input" },
        { value: "skip", label: "Skip for now" },
      ],
      "retry",
    );
    if (choice === "skip") {
      return null;
    }
  }
}

function makeConsolePrompter(): SetupPrompter {
  const rl = createInterface({ input, output });
  const useColor = shouldUseColor(output);
  let activeKeypressHandler: ((char: string, key: Keypress) => void) | null = null;
  let rawModeEnabledBySelect = false;

  async function ask(message: string): Promise<string> {
    return rl.question(message);
  }

  async function askSecret(message: string): Promise<string> {
    if (!input.isTTY || !output.isTTY) {
      return ask(message);
    }

    const mutableRl = rl as Interface & { _writeToOutput?: (text: string) => void };
    const previousWriteToOutput = mutableRl._writeToOutput;
    rl.pause();
    readline.emitKeypressEvents(input);
    const restoreKeypressListeners = suspendKeypressListeners(input);

    const previousRaw = Boolean((input as NodeJS.ReadStream).isRaw);
    if (input.setRawMode) {
      input.setRawMode(true);
    }
    const echoDisabled = setTerminalEcho(false);
    if (previousWriteToOutput) {
      mutableRl._writeToOutput = () => {};
    }
    input.resume();
    output.write(message);

    return new Promise<string>((resolve, reject) => {
      let raw = "";
      let cleanupDone = false;

      const cleanup = () => {
        if (cleanupDone) {
          return;
        }
        cleanupDone = true;
        if (activeKeypressHandler) {
          input.removeListener("keypress", activeKeypressHandler);
          activeKeypressHandler = null;
        } else {
          input.removeListener("keypress", onKeypress);
        }
        if (input.setRawMode && rawModeEnabledBySelect) {
          try {
            input.setRawMode(previousRaw);
          } catch {
            // Ignore raw mode restore errors on shutdown paths.
          }
        }
        if (echoDisabled) {
          setTerminalEcho(true);
        }
        if (previousWriteToOutput) {
          mutableRl._writeToOutput = previousWriteToOutput;
        }
        restoreKeypressListeners();
        rawModeEnabledBySelect = false;
        rl.resume();
      };

      const onKeypress = (char: string, key: Keypress) => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          output.write("^C\n");
          reject(new Error("Setup cancelled by user."));
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          cleanup();
          output.write("\n");
          resolve(raw);
          return;
        }
        if (key.name === "backspace") {
          if (raw.length > 0) {
            raw = raw.slice(0, -1);
            output.write("\b \b");
          }
          return;
        }
        if (key.ctrl || key.name === "tab") {
          return;
        }
        if (!char || char.length === 0) {
          return;
        }
        raw += char;
        output.write("*".repeat(char.length));
      };

      activeKeypressHandler = onKeypress;
      rawModeEnabledBySelect = Boolean(input.setRawMode);
      input.on("keypress", onKeypress);
    });
  }

  function sectionHeader(title: string): string {
    return `\n${colorize("===", ANSI_DIM, useColor)} ${colorize(title, ANSI_BOLD_CYAN, useColor)} ${colorize("===", ANSI_DIM, useColor)}`;
  }

  async function selectByArrowKeys<T extends string>(
    message: string,
    options: SelectOption<T>[],
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
      lines.push(colorize(truncateForTerminal(`[SELECT] ${message}`, columns - 1), ANSI_BOLD_CYAN, useColor));
      for (let i = 0; i < options.length; i += 1) {
        const option = options[i];
        const selected = i === index;
        const prefix = selected ? ">>" : "  ";
        const hint = option.hint ? ` (${option.hint})` : "";
        const rawLine = `  ${prefix} ${option.label}${hint}`;
        const clipped = truncateForTerminal(rawLine, columns - 1);
        lines.push(selected ? colorize(clipped, ANSI_BOLD_GREEN, useColor) : clipped);
      }
      lines.push(colorize("[INPUT] Use Up/Down arrows, then Enter.", ANSI_BOLD_YELLOW, useColor));
      output.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        if (activeKeypressHandler) {
          input.removeListener("keypress", activeKeypressHandler);
          activeKeypressHandler = null;
        } else {
          input.removeListener("keypress", onKeypress);
        }
        if (input.setRawMode && rawModeEnabledBySelect) {
          try {
            input.setRawMode(previousRaw);
          } catch {
            // Ignore raw mode restore errors on shutdown paths.
          }
        }
        rawModeEnabledBySelect = false;
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

      activeKeypressHandler = onKeypress;
      rawModeEnabledBySelect = Boolean(input.setRawMode);
      input.on("keypress", onKeypress);
      render();
    });
  }

  return {
    intro: async (title: string) => {
      // eslint-disable-next-line no-console
      console.log(`${colorize("[OpenPocket]", ANSI_BOLD_GREEN, useColor)} ${title}`);
      // eslint-disable-next-line no-console
      console.log(
        [
          "",
          "Steps:",
          "  1) Consent",
          "  2) Deployment target",
          "  3) Model selection",
          "  4) API key setup",
          "  5) Channel setup (Telegram, Discord, WhatsApp)",
          "  6) Device onboarding checks",
        ].join("\n"),
      );
    },
    note: async (title: string, body: string) => {
      const normalized = body
        .split("\n")
        .map((line) => (line.trim() ? `  ${line}` : ""))
        .join("\n");
      // eslint-disable-next-line no-console
      console.log(sectionHeader(title));
      // eslint-disable-next-line no-console
      console.log(normalized);
    },
    select: async (message, options, initialValue) => selectByArrowKeys(message, options, initialValue),
    confirm: async (message, initialValue = false) => {
      const defaultHint = initialValue ? "Y/n" : "y/N";
      while (true) {
        const raw = (
          await ask(`\n${colorize("[INPUT]", ANSI_BOLD_YELLOW, useColor)} ${message} [${defaultHint}]: `)
        )
          .trim()
          .toLowerCase();
        if (!raw) {
          return initialValue;
        }
        if (raw === "y" || raw === "yes") {
          return true;
        }
        if (raw === "n" || raw === "no") {
          return false;
        }
        // eslint-disable-next-line no-console
        console.log("Please enter y or n.");
      }
    },
    text: async (message, initialValue, validate) => {
      while (true) {
        const initSuffix = initialValue ? ` [${initialValue}]` : "";
        const raw = (await ask(`\n${colorize("[INPUT]", ANSI_BOLD_YELLOW, useColor)} ${message}${initSuffix}: `)).trim();
        const finalValue = raw || initialValue || "";
        const err = validate ? validate(finalValue) : null;
        if (!err) {
          return finalValue;
        }
        // eslint-disable-next-line no-console
        console.log(`Invalid input: ${err}`);
      }
    },
    secret: async (message, validate) => {
      while (true) {
        const raw = (await askSecret(`\n${colorize("[INPUT]", ANSI_BOLD_YELLOW, useColor)} ${message}: `)).trim();
        const err = validate ? validate(raw) : null;
        if (!err) {
          return raw;
        }
        // eslint-disable-next-line no-console
        console.log(`Invalid input: ${err}`);
      }
    },
    pause: async (message) => {
      await ask(`\n${message}\n${colorize("[INPUT]", ANSI_BOLD_YELLOW, useColor)} Press Enter to continue...`);
    },
    outro: async (message: string) => {
      // eslint-disable-next-line no-console
      console.log(`\n${message}`);
    },
    close: async () => {
      if (activeKeypressHandler) {
        input.removeListener("keypress", activeKeypressHandler);
        activeKeypressHandler = null;
      }
      if (input.setRawMode) {
        try {
          input.setRawMode(false);
        } catch {
          // Ignore raw mode reset errors.
        }
      }
      input.pause();
      rl.close();
    },
  };
}

async function runConsentStep(prompter: SetupPrompter, state: SetupState): Promise<void> {
  await prompter.note(
    "User Consent (Required)",
    [
      "OpenPocket terms:",
      "1) The emulator and runtime data directories run on your local machine.",
      "2) Account sign-ins, app data, and screenshots are stored locally by default.",
      "3) If you configure a cloud model API (for example OpenAI), task text and screenshots may be sent to that provider for inference.",
      "4) You can stop the gateway at any time and remove local runtime data.",
    ].join("\n"),
  );

  const accepted = await prompter.confirm(
    "Accept terms and continue?",
    false,
  );
  if (!accepted) {
    throw new Error("User consent not accepted. Setup aborted.");
  }
  state.consentAcceptedAt = nowIso();
}

function normalizeAdbEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes(":")) {
    return trimmed;
  }
  return `${trimmed}:5555`;
}

async function runDeploymentTargetStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
): Promise<void> {
  const currentType = normalizeDeviceTargetType(config.target.type);
  const targetType = await prompter.select(
    "Choose deployment target for Agent Phone",
    [
      { value: "emulator", label: "Emulator (local Android AVD)" },
      { value: "physical-phone", label: "Physical Phone (ADB USB/Wi-Fi)" },
      { value: "android-tv", label: "Android TV (ADB USB/Wi-Fi)" },
      { value: "cloud", label: "Cloud (provider-managed device)" },
    ],
    currentType,
  );

  config.target.type = targetType;
  state.targetType = targetType;
  state.targetConfiguredAt = nowIso();

  if (isEmulatorTarget(targetType)) {
    config.target.adbEndpoint = "";
  } else if (targetType === "physical-phone" || targetType === "android-tv") {
    const connectionMode = await prompter.select(
      "How will this device connect to your local runtime?",
      [
        { value: "usb", label: "USB (direct cable, recommended first)" },
        { value: "wifi", label: "Wi-Fi (wireless debugging endpoint)" },
      ],
      config.target.adbEndpoint.trim() ? "wifi" : "usb",
    );
    state.targetConnectionMode = connectionMode;
    if (connectionMode === "wifi") {
      const endpoint = await prompter.text(
        "Wireless debugging endpoint (IP or host, optional :port)",
        config.target.adbEndpoint.trim(),
        (inputText) => {
          if (!inputText.trim()) {
            return "Endpoint cannot be empty for Wi-Fi mode.";
          }
          return null;
        },
      );
      config.target.adbEndpoint = normalizeAdbEndpoint(endpoint);
    } else {
      config.target.adbEndpoint = "";
    }
  } else {
    const cloudProvider = await prompter.text(
      "Cloud provider name (for tracking purpose)",
      config.target.cloudProvider.trim(),
      () => null,
    );
    config.target.cloudProvider = cloudProvider.trim();
    const endpointRaw = await prompter.text(
      "ADB endpoint for cloud device (optional, leave empty if not using adb yet)",
      config.target.adbEndpoint.trim(),
      () => null,
    );
    config.target.adbEndpoint = normalizeAdbEndpoint(endpointRaw);
  }

  const preferredDeviceId = await prompter.text(
    "Preferred adb device ID (optional, leave empty for auto-select)",
    config.agent.deviceId ?? "",
    () => null,
  );
  config.agent.deviceId = preferredDeviceId.trim() ? preferredDeviceId.trim() : null;

  state.targetAdbEndpoint = config.target.adbEndpoint;
  state.targetCloudProvider = config.target.cloudProvider;
  saveConfig(config);

  await prompter.note(
    "Deployment Target",
    [
      `Target type: ${config.target.type} (${deviceTargetLabel(config.target.type)})`,
      `Preferred adb device: ${config.agent.deviceId || "(auto)"}`,
      `ADB endpoint: ${config.target.adbEndpoint || "(none)"}`,
      `Cloud provider: ${config.target.cloudProvider || "(none)"}`,
    ].join("\n"),
  );
}

async function runModelSelectionStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
): Promise<ModelSelectionResult> {
  const options = Object.entries(config.models).flatMap(([profileKey, profile]) => {
    const baseOption: SelectOption<string> = {
      value: modelSelectionValue(profileKey, "api-key"),
      label: modelOptionLabel(profileKey, profile),
      hint: `${profile.model} | ${profile.apiKeyEnv}`,
    };
    if (!isCodexCliCapableModel(profile)) {
      return [baseOption];
    }
    return [
      baseOption,
      {
        value: modelSelectionValue(profileKey, "codex-cli"),
        label: `${modelOptionLabel(profileKey, profile)} + Codex CLI Login`,
        hint: "OAuth via codex cli",
      },
    ];
  });
  const selectedRaw = await prompter.select(
    "Choose your default model profile",
    options,
    modelSelectionValue(config.defaultModel, "api-key"),
  );
  const selection = parseModelSelectionValue(selectedRaw);

  config.defaultModel = selection.profileKey;
  saveConfig(config);

  const selectedProfile = config.models[selection.profileKey];
  if (!selectedProfile) {
    throw new Error(`Unknown model profile during setup: ${selection.profileKey}`);
  }
  state.modelProfile = selection.profileKey;
  state.modelProvider = providerFromBaseUrl(selectedProfile.baseUrl);
  state.apiKeyEnv = selectedProfile.apiKeyEnv;
  state.modelConfiguredAt = nowIso();

  const authSummary =
    selection.authMode === "codex-cli"
      ? "Auth: Codex CLI login (OAuth)"
      : `API key env: ${selectedProfile.apiKeyEnv}`;
  await prompter.note(
    "Model Setup",
    [
      `Default model profile: ${selection.profileKey}`,
      `Provider: ${state.modelProvider}`,
      `Model id: ${selectedProfile.model}`,
      authSummary,
    ].join("\n"),
  );

  return selection;
}

async function runApiKeyStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
  selection: ModelSelectionResult,
  options?: RunSetupOptions,
): Promise<void> {
  const modelProfileKey = selection.profileKey;
  const selectedProfile = config.models[modelProfileKey];
  if (!selectedProfile) {
    throw new Error(`Unknown model profile during setup: ${modelProfileKey}`);
  }

  if (selection.authMode === "codex-cli") {
    const codexHome = resolveCodexHomeForDisplay();
    const authPath = path.join(codexHome, "auth.json");
    await prompter.note(
      "Codex CLI Authorization",
      [
        "You selected Codex CLI auth mode.",
        "OpenPocket will run `codex login` now for authorization.",
        `Credential file expected at: ${authPath}`,
      ].join("\n"),
    );

    const loginRunner = options?.codexCliLoginRunner ?? runCodexCliLoginCommand;
    const loginResult = await loginRunner();
    if (loginResult.cancelled) {
      throw new Error("Setup cancelled by user.");
    }
    const credential = readCodexCliCredential();
    if (credential) {
      state.apiKeySource = "codex-cli";
      state.apiKeyConfiguredAt = nowIso();
      const successMessage = loginResult.ok
        ? "Authorization complete. Codex CLI credentials detected and ready."
        : [
            "`codex login` was not confirmed, but existing Codex CLI credentials were detected.",
            `Details: ${loginResult.detail}`,
            "Authorization complete. Existing credentials will be used.",
          ].join("\n");
      await prompter.note("Codex CLI Authorization", successMessage);
      return;
    }

    await prompter.note(
      "Codex CLI Authorization",
      [
        "Authorization was not confirmed.",
        `Details: ${loginResult.detail}`,
        "You can continue with API key setup as fallback.",
      ].join("\n"),
    );

    const useFallback = await prompter.confirm(
      "Continue with API key setup fallback?",
      true,
    );
    if (!useFallback) {
      state.apiKeySource = "skipped";
      return;
    }
  }

  const envName = selectedProfile.apiKeyEnv || "MODEL_API_KEY";
  const envKey = process.env[envName]?.trim() ?? "";
  const configKey = selectedProfile.apiKey.trim();
  const hasConfigKey = Boolean(configKey);
  const provider = providerFromBaseUrl(selectedProfile.baseUrl);

  await prompter.note(
    "API Key Setup",
    [
      `Selected model profile: ${modelProfileKey}`,
      `Provider: ${provider}`,
      `Model id: ${selectedProfile.model}`,
      `Expected environment variable: ${envName}`,
      "You can also edit config.json manually after setup.",
    ].join("\n"),
  );

  const apiKeyOptions: SelectOption<ApiKeyChoice>[] = [
    {
      value: "env",
      label: `Use environment variable ${envName}`,
      hint: envKey ? `Detected (length ${envKey.length})` : "Not detected",
    },
    {
      value: "config",
      label: "Paste API key and save to local config.json",
      hint: hasConfigKey ? `Current config key detected (length ${configKey.length})` : "Stored in plain text on this machine",
    },
    {
      value: "skip",
      label: "Skip for now",
    },
  ];
  if (hasConfigKey) {
    apiKeyOptions.splice(1, 0, {
      value: "config-existing",
      label: "Use existing key from local config.json",
      hint: `Detected (length ${configKey.length})`,
    });
  }

  const choice = await prompter.select<ApiKeyChoice>(
    "Choose API key setup method",
    apiKeyOptions,
    hasConfigKey ? "config-existing" : envKey ? "env" : "config",
  );

  if (choice === "env") {
    if (!envKey) {
      await prompter.note(
        "Environment Variable Not Found",
        `${envName} is not set in the current shell. Marked as skipped; you can export it and rerun setup later.`,
      );
      state.apiKeySource = "skipped";
      return;
    }
    state.apiKeyEnv = envName;
    state.apiKeySource = "env";
    state.apiKeyConfiguredAt = nowIso();
    return;
  }

  if (choice === "config-existing") {
    state.apiKeyEnv = envName;
    state.apiKeySource = "config";
    state.apiKeyConfiguredAt = nowIso();
    return;
  }

  if (choice === "skip") {
    state.apiKeySource = "skipped";
    return;
  }

  const inputKey = await promptSecretWithRetryOrSkip(prompter, `Enter API key for ${provider}`, "API key");
  if (!inputKey) {
    state.apiKeySource = "skipped";
    return;
  }
  const confirmed = await prompter.confirm(
    "Confirm writing this key to local config.json (stored only on this machine)?",
    true,
  );
  if (!confirmed) {
    state.apiKeySource = "skipped";
    return;
  }

  const updatedProfiles = applyProviderApiKey(config, modelProfileKey, inputKey);
  saveConfig(config);
  state.apiKeyEnv = envName;
  state.apiKeySource = "config";
  state.apiKeyConfiguredAt = nowIso();
  await prompter.note(
    "API Key Setup",
    `Updated model profiles: ${updatedProfiles.join(", ") || "(none)"}`,
  );
}

async function runVmStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
  emulator: SetupEmulator,
): Promise<void> {
  if (!isEmulatorTarget(config.target.type)) {
    await prompter.note(
      "Device Onboarding Check",
      [
        `Target is ${config.target.type}; skipping emulator Play Store onboarding.`,
        "Connect your target device and verify `adb devices` shows it as online before `openpocket gateway start`.",
      ].join("\n"),
    );
    return;
  }

  const choice = await prompter.select(
    "Do you want to launch the Android emulator now and complete Gmail sign-in for Play Store?",
    [
      { value: "start", label: "Start and show emulator now (recommended)" },
      { value: "skip", label: "Skip for now and do it later with /startvm" },
    ],
    "start",
  );
  if (choice === "skip") {
    return;
  }

  const startMsg = await emulator.start(false);
  const showMsg = emulator.showWindow();
  state.emulatorStartedAt = nowIso();
  await prompter.note("Emulator", `${startMsg}\n${showMsg}`);

  const playStoreDetected = detectPlayStore(emulator, config.agent.deviceId);
  state.playStoreDetected = playStoreDetected;
  if (playStoreDetected === false) {
    await prompter.note(
      "Play Store Check",
      [
        "Play Store (com.android.vending) was not detected.",
        "Use a Google Play AVD image, otherwise many apps cannot be installed or signed in.",
      ].join("\n"),
    );
  }

  await prompter.note(
    "Manual Action Required",
    [
      "Please complete the following manually in the emulator:",
      "1) Open Play Store",
      "2) Sign in with your Gmail account",
      "3) Complete verification / 2FA if prompted",
      "4) Confirm you can search and install apps in Play Store",
    ].join("\n"),
  );

  await prompter.pause("Return to the terminal after finishing the steps above.");
  const done = await prompter.confirm("Have you completed Gmail sign-in and verified Play Store access?", false);
  if (done) {
    state.gmailLoginConfirmedAt = nowIso();
  }
}

async function runTelegramStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
): Promise<void> {
  const fallbackEnv = "TELEGRAM_BOT_TOKEN";
  const configuredEnv = config.telegram.botTokenEnv || fallbackEnv;
  const currentTokenEnv = normalizeEnvVarName(configuredEnv, fallbackEnv);
  if (currentTokenEnv !== configuredEnv) {
    config.telegram.botTokenEnv = currentTokenEnv;
    await prompter.note(
      "Telegram Setup",
      [
        `Current botTokenEnv value is invalid: ${configuredEnv}`,
        `Reset to default env variable name: ${currentTokenEnv}`,
      ].join("\n"),
    );
  }
  const envToken = process.env[currentTokenEnv]?.trim() ?? "";
  const hasConfigToken = Boolean(config.telegram.botToken.trim());

  await prompter.note(
    "Telegram Gateway Setup",
    [
      "OpenPocket gateway requires a Telegram bot token.",
      "Create one with @BotFather if you do not have it yet.",
      `Current token env: ${currentTokenEnv}`,
      `Current token in config.json: ${hasConfigToken ? "set" : "empty"}`,
    ].join("\n"),
  );

  const tokenOptions: SelectOption<TokenChoice>[] = [
    {
      value: "env",
      label: `Use environment variable ${currentTokenEnv}`,
      hint: envToken ? `Detected (length ${envToken.length})` : "Not detected",
    },
    {
      value: "config",
      label: "Paste token and save to local config.json",
    },
    {
      value: "skip",
      label: "Skip token setup for now",
    },
  ];
  if (hasConfigToken) {
    tokenOptions.splice(1, 0, {
      value: "config-existing",
      label: "Use existing token from local config.json",
      hint: `Detected (length ${config.telegram.botToken.trim().length})`,
    });
  }

  const tokenChoice = await prompter.select<TokenChoice>(
    "Telegram bot token source",
    tokenOptions,
    hasConfigToken ? "config-existing" : envToken ? "env" : "config",
  );

  if (tokenChoice === "env") {
    const envName = await prompter.text(
      "Environment variable name for Telegram token",
      currentTokenEnv,
      (value) => (value.trim() ? null : "Environment variable name cannot be empty."),
    );
    config.telegram.botTokenEnv = envName.trim();
    config.telegram.botToken = "";
    state.telegramTokenSource = "env";
    if (!process.env[config.telegram.botTokenEnv]?.trim()) {
      await prompter.note(
        "Telegram Setup",
        `${config.telegram.botTokenEnv} is not set in this shell. Gateway start will fail until it is exported.`,
      );
    }
  } else if (tokenChoice === "config-existing") {
    state.telegramTokenSource = "config";
  } else if (tokenChoice === "config") {
    const token = await promptSecretWithRetryOrSkip(prompter, "Enter Telegram bot token", "Telegram bot token");
    if (!token) {
      state.telegramTokenSource = "skip";
    } else {
      const confirmed = await prompter.confirm(
        "Confirm writing Telegram bot token to local config.json?",
        true,
      );
      if (confirmed) {
        config.telegram.botToken = token;
        state.telegramTokenSource = "config";
      } else {
        state.telegramTokenSource = "skip";
      }
    }
  } else {
    state.telegramTokenSource = "skip";
  }

  const currentAllow = config.telegram.allowedChatIds;
  const allowedMode = await prompter.select(
    "Telegram chat allowlist policy",
    [
      {
        value: "keep",
        label: "Keep current allowlist",
        hint:
          currentAllow.length > 0
            ? currentAllow.join(", ")
            : "empty -> all chats allowed",
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
  state.telegramAllowedChatMode = allowedMode;

  if (allowedMode === "open") {
    config.telegram.allowedChatIds = [];
  } else if (allowedMode === "set") {
    const input = await prompter.text(
      "Enter allowed chat IDs (comma or space separated)",
      config.telegram.allowedChatIds.join(", "),
      (value) => {
        try {
          parseAllowedChatIdsInput(value);
          return null;
        } catch (error) {
          return (error as Error).message;
        }
      },
    );
    config.telegram.allowedChatIds = parseAllowedChatIdsInput(input);
  }

  state.telegramConfiguredAt = nowIso();
  saveConfig(config);
}

async function runDiscordStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
): Promise<void> {
  const fallbackEnv = "DISCORD_BOT_TOKEN";

  if (!config.channels) config.channels = {};
  if (!config.channels.discord) config.channels.discord = {};
  const dc = config.channels.discord;

  const configuredEnv = dc.tokenEnv || fallbackEnv;
  const envToken = process.env[configuredEnv]?.trim() ?? "";
  const hasConfigToken = Boolean(dc.token?.trim());

  await prompter.note(
    "Discord Bot Setup",
    [
      "OpenPocket can receive commands from Discord DMs or a guild channel.",
      "Create a bot at https://discord.com/developers/applications and enable:",
      "  - MESSAGE CONTENT intent (Privileged Gateway Intents)",
      "  - bot scope with Send Messages, Read Message History permissions",
      `Current token env: ${configuredEnv}`,
      `Current token in config: ${hasConfigToken ? "set" : "empty"}`,
    ].join("\n"),
  );

  const tokenOptions: SelectOption<TokenChoice>[] = [
    {
      value: "env",
      label: `Use environment variable ${configuredEnv}`,
      hint: envToken ? `Detected (length ${envToken.length})` : "Not detected",
    },
    {
      value: "config",
      label: "Paste token and save to local config.json",
    },
    {
      value: "skip",
      label: "Skip token setup for now",
    },
  ];
  if (hasConfigToken) {
    tokenOptions.splice(1, 0, {
      value: "config-existing",
      label: "Use existing token from local config.json",
      hint: `Detected (length ${dc.token!.trim().length})`,
    });
  }

  const tokenChoice = await prompter.select<TokenChoice>(
    "Discord bot token source",
    tokenOptions,
    hasConfigToken ? "config-existing" : envToken ? "env" : "config",
  );

  if (tokenChoice === "env") {
    dc.tokenEnv = configuredEnv;
    dc.token = "";
    state.discordTokenSource = "env";
    if (!envToken) {
      await prompter.note(
        "Discord Setup",
        `${configuredEnv} is not set in the current shell. Discord channel will not start until it is exported.`,
      );
    }
  } else if (tokenChoice === "config-existing") {
    state.discordTokenSource = "config";
  } else if (tokenChoice === "config") {
    const token = await promptSecretWithRetryOrSkip(prompter, "Enter Discord bot token", "Discord bot token");
    if (!token) {
      state.discordTokenSource = "skip";
    } else {
      const confirmed = await prompter.confirm(
        "Confirm writing Discord bot token to local config.json?",
        true,
      );
      if (confirmed) {
        dc.token = token;
        state.discordTokenSource = "config";
      } else {
        state.discordTokenSource = "skip";
      }
    }
  } else {
    state.discordTokenSource = "skip";
  }

  const dmPolicy = await prompter.select(
    "Discord DM access policy",
    [
      { value: "pairing", label: "Pairing (unknown senders get a code, owner approves)" },
      { value: "allowlist", label: "Allowlist (only pre-configured user IDs)" },
      { value: "open", label: "Open (all DMs allowed)" },
    ],
    (dc.dmPolicy as string) || "pairing",
  );
  dc.dmPolicy = dmPolicy as "pairing" | "allowlist" | "open";

  state.discordConfiguredAt = nowIso();
  saveConfig(config);
}

async function runWhatsAppStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
): Promise<void> {
  if (!config.channels) config.channels = {};
  if (!config.channels.whatsapp) config.channels.whatsapp = {};
  const wa = config.channels.whatsapp;

  await prompter.note(
    "WhatsApp Setup",
    [
      "OpenPocket uses Baileys (WhatsApp Web protocol) for WhatsApp integration.",
      "On first gateway start, a QR code will be displayed in the terminal.",
      "Scan it with your phone (WhatsApp > Settings > Linked Devices > Link a Device).",
      "",
      "Recommendations:",
      "  - Use a dedicated phone number to avoid account restrictions",
      "  - WhatsApp Web automation is unofficial; use responsibly",
      "  - Session credentials are stored locally in your state directory",
    ].join("\n"),
  );

  const dmPolicy = await prompter.select(
    "WhatsApp DM access policy",
    [
      { value: "pairing", label: "Pairing (unknown senders get a code, owner approves)" },
      { value: "allowlist", label: "Allowlist (only pre-configured phone numbers)" },
      { value: "open", label: "Open (all messages allowed)" },
    ],
    (wa.dmPolicy as string) || "pairing",
  );
  wa.dmPolicy = dmPolicy as "pairing" | "allowlist" | "open";

  const sendReceipts = await prompter.confirm(
    "Send read receipts when processing messages?",
    wa.sendReadReceipts ?? true,
  );
  wa.sendReadReceipts = sendReceipts;

  const chunkMode = await prompter.select(
    "Long message chunking mode",
    [
      { value: "newline", label: "Split at newlines (natural paragraph breaks)" },
      { value: "length", label: "Split at character limit" },
    ],
    wa.chunkMode || "newline",
  );
  wa.chunkMode = chunkMode as "length" | "newline";

  state.whatsappConfiguredAt = nowIso();
  saveConfig(config);

  const authDir = path.join(config.stateDir, "whatsapp-auth");
  const alreadyLinked = fs.existsSync(path.join(authDir, "creds.json"));

  if (alreadyLinked) {
    await prompter.note(
      "WhatsApp Setup",
      [
        "WhatsApp channel configured.",
        `Existing session found at: ${authDir}`,
        "Gateway will reconnect automatically on next start.",
      ].join("\n"),
    );
    return;
  }

  const linkNow = await prompter.confirm(
    "Link WhatsApp now? (A QR code will be displayed for you to scan)",
    true,
  );

  if (!linkNow) {
    await prompter.note(
      "WhatsApp Setup",
      [
        "WhatsApp channel configured (linking deferred).",
        "QR code will be displayed when you run `openpocket gateway start`.",
        "",
        "To link later:",
        "  1) Run `openpocket gateway start`",
        "  2) Scan the QR code with WhatsApp on your phone:",
        "     iOS:     Settings > Linked Devices > Link a Device",
        "     Android: Menu (⋮) > Linked Devices > Link a Device",
      ].join("\n"),
    );
    return;
  }

  await runWhatsAppQrPairing(config, prompter);
}

async function runWhatsAppQrPairing(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
): Promise<void> {
  const authDir = path.join(config.stateDir, "whatsapp-auth");
  fs.mkdirSync(authDir, { recursive: true });

  const proxyUrl = await detectProxyForWhatsApp(prompter);

  await prompter.note(
    "WhatsApp QR Pairing",
    [
      "Connecting to WhatsApp Web...",
      proxyUrl ? `  Using proxy: ${proxyUrl}` : "",
      "A QR code will appear below. On your phone, open:",
      "  iOS:     WhatsApp > Settings > Linked Devices > Link a Device",
      "  Android: WhatsApp > Menu (⋮) > Linked Devices > Link a Device",
      "Then point your camera at the QR code.",
      "",
      "The QR code refreshes every ~60 seconds. Total timeout: 2 minutes.",
    ].filter(Boolean).join("\n"),
  );

  const baileys = await import("baileys");
  const makeWASocket = baileys.default;
  const { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestWaWebVersion } = baileys;
  const QRCode = await import("qrcode");
  const pino = (await import("pino")).default;

  const silentLogger = pino({ level: "silent" }) as any;

  let waVersion: [number, number, number] | undefined;
  try {
    const { version } = await fetchLatestWaWebVersion({});
    waVersion = version;
    console.log(`  [WhatsApp] Using WA Web version: ${version.join(".")}`);
  } catch {
    console.log("  [WhatsApp] Could not fetch latest WA version, using default.");
  }

  let proxyAgent: any = undefined;
  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      proxyAgent = new HttpsProxyAgent(proxyUrl);
    } catch {
      console.log("  [WhatsApp] Could not create proxy agent, connecting directly.");
    }
  }

  let currentSock: ReturnType<typeof makeWASocket> | null = null;

  const result = await new Promise<"linked" | "timeout" | "error">((resolve) => {
    let resolved = false;
    const timeoutMs = 120_000;
    let qrCount = 0;
    let retryCount = 0;
    const maxRetries = 5;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve("timeout");
      }
    }, timeoutMs);

    async function startSocket(): Promise<void> {
      if (resolved) return;

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
      currentSock = sock;

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async (update) => {
        if (resolved) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          qrCount++;
          retryCount = 0;
          console.log("");
          console.log("  ┌─────────────────────────────────────────┐");
          console.log(`  │  Scan this QR code with WhatsApp  (${qrCount})    │`);
          console.log("  └─────────────────────────────────────────┘");
          console.log("");
          try {
            const qrArt = await QRCode.toString(qr, { type: "utf8", errorCorrectionLevel: "L", margin: 2 });
            for (const line of qrArt.trimEnd().split("\n")) {
              console.log(`  ${line}`);
            }
          } catch {
            console.log(`  QR data: ${qr}`);
          }
          console.log("");
          console.log("  Waiting for scan...");
        }

        if (connection === "open") {
          clearTimeout(timer);
          if (!resolved) {
            resolved = true;
            resolve("linked");
          }
        }

        if (connection === "close") {
          const err = lastDisconnect?.error as any;
          const statusCode = err?.output?.statusCode as number | undefined;
          const errMsg = err?.message || err?.output?.payload?.message || "unknown";

          if (statusCode === DisconnectReason.loggedOut) {
            clearTimeout(timer);
            if (!resolved) {
              resolved = true;
              resolve("error");
            }
            return;
          }

          retryCount++;
          if (retryCount > maxRetries) {
            console.log(`  [WhatsApp] Connection failed after ${maxRetries} retries: ${errMsg}`);
            console.log("  [WhatsApp] This may be a network issue. Check if WhatsApp Web is accessible from your network.");
            clearTimeout(timer);
            if (!resolved) {
              resolved = true;
              resolve("error");
            }
            return;
          }

          console.log(`  [WhatsApp] Connection closed (${errMsg}), retrying ${retryCount}/${maxRetries}...`);
          try { sock.end(undefined); } catch { /* ignore */ }
          const delay = Math.min(2000 * retryCount, 10_000);
          setTimeout(() => { void startSocket(); }, delay);
        }
      });
    }

    void startSocket();
  });

  if (currentSock) {
    try {
      (currentSock as any).ev?.removeAllListeners();
      (currentSock as any).end(undefined);
    } catch { /* ignore */ }
    currentSock = null;
  }

  if (result === "linked") {
    console.log("");
    await prompter.note(
      "WhatsApp Pairing",
      [
        "WhatsApp linked successfully!",
        `Session saved to: ${authDir}`,
        "Gateway will reconnect automatically on subsequent starts.",
      ].join("\n"),
    );
  } else if (result === "timeout") {
    await prompter.note(
      "WhatsApp Pairing",
      [
        "QR code scan timed out (2 minutes).",
        "You can pair later when running `openpocket gateway start`.",
        "A new QR code will be displayed at that time.",
      ].join("\n"),
    );
  } else {
    await prompter.note(
      "WhatsApp Pairing",
      [
        "WhatsApp pairing failed.",
        "You can retry later when running `openpocket gateway start`.",
      ].join("\n"),
    );
  }
}

async function detectProxyForWhatsApp(prompter: SetupPrompter): Promise<string | null> {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) return envProxy;

  if (process.platform === "darwin") {
    try {
      const { execSync } = await import("node:child_process");
      const output = execSync("networksetup -getsecurewebproxy Wi-Fi", { timeout: 5000, encoding: "utf-8" });
      const enabled = /^Enabled:\s*Yes/im.test(output);
      const serverMatch = output.match(/^Server:\s*(.+)$/im);
      const portMatch = output.match(/^Port:\s*(\d+)$/im);
      if (enabled && serverMatch && portMatch) {
        const url = `http://${serverMatch[1].trim()}:${portMatch[1].trim()}`;
        const ok = await testProxyConnectivity(url);
        if (ok) return url;
      }
    } catch { /* ignore */ }
  }

  const commonPorts = [7897, 7890, 1087, 8080, 1080];
  for (const port of commonPorts) {
    const url = `http://127.0.0.1:${port}`;
    const ok = await testProxyConnectivity(url);
    if (ok) return url;
  }

  return null;
}

async function testProxyConnectivity(proxyUrl: string): Promise<boolean> {
  try {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    const https = await import("node:https");
    const agent = new HttpsProxyAgent(proxyUrl);

    return new Promise<boolean>((resolve) => {
      const req = https.get("https://web.whatsapp.com", { agent, timeout: 8000 } as any, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode === 200));
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

async function runChannelSetupStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
): Promise<void> {
  await prompter.note(
    "Channel Setup",
    [
      "OpenPocket supports multiple messaging channels for task control.",
      "Select which channels you want to configure.",
      "You can always add more channels later by rerunning `openpocket onboard`.",
    ].join("\n"),
  );

  const channelOptions: SelectOption<string>[] = [
    { value: "telegram", label: "Telegram", hint: "Bot API polling" },
    { value: "discord", label: "Discord", hint: "Bot with DMs and guild support" },
    { value: "whatsapp", label: "WhatsApp", hint: "Via Baileys (WhatsApp Web)" },
  ];

  const selectedChannels: string[] = [];
  for (const option of channelOptions) {
    const enable = await prompter.confirm(
      `Enable ${option.label}? (${option.hint})`,
      option.value === "telegram",
    );
    if (enable) selectedChannels.push(option.value);
  }

  state.enabledChannels = selectedChannels;
  state.channelsConfiguredAt = nowIso();

  if (selectedChannels.length === 0) {
    await prompter.note(
      "Channel Setup",
      "No channels selected. You can configure channels later with `openpocket onboard`.",
    );
    return;
  }

  if (selectedChannels.includes("telegram")) {
    await runTelegramStep(config, prompter, state);
  }

  if (selectedChannels.includes("discord")) {
    await runDiscordStep(config, prompter, state);
  }

  if (selectedChannels.includes("whatsapp")) {
    await runWhatsAppStep(config, prompter, state);
  }

  const summary = selectedChannels.map((ch) => `  - ${ch}`).join("\n");
  await prompter.note(
    "Channel Setup Complete",
    `Configured channels:\n${summary}`,
  );
}

function detectCommandVersion(command: string): string {
  try {
    const result = spawnSync(command, ["version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 3000,
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if ((result.status ?? 1) !== 0) {
      return "";
    }
    return text.split(/\r?\n/)[0] ?? "";
  } catch {
    return "";
  }
}

function buildNgrokSetupGuide(executable: string, envName: string): string {
  return [
    `Could not run \`${executable} version\`.`,
    "Quick setup guide:",
    "1) Create a free ngrok account: https://dashboard.ngrok.com/signup",
    "2) Install ngrok CLI: https://ngrok.com/download",
    `3) Authenticate once: ${executable} config add-authtoken <YOUR_NGROK_AUTHTOKEN>`,
    `4) Optional env for OpenPocket:`,
    `   macOS/Linux: export ${envName}=\"<YOUR_NGROK_AUTHTOKEN>\"`,
    `   Windows PowerShell: $env:${envName}=\"<YOUR_NGROK_AUTHTOKEN>\"`,
    "You can continue below and paste token into local config.json if preferred.",
  ].join("\n");
}

async function runHumanAuthStep(
  config: OpenPocketConfig,
  prompter: SetupPrompter,
  state: SetupState,
): Promise<void> {
  const mode = await prompter.select(
    "Real-device authorization bridge mode",
    [
      {
        value: "ngrok",
        label: "Enable local relay + ngrok tunnel (recommended)",
      },
      {
        value: "lan",
        label: "Enable local relay only (same Wi-Fi / LAN access)",
      },
      {
        value: "disabled",
        label: "Disable human-auth bridge for now",
      },
    ],
    config.humanAuth.enabled
      ? config.humanAuth.tunnel.provider === "ngrok" && config.humanAuth.tunnel.ngrok.enabled
        ? "ngrok"
        : "lan"
      : "disabled",
  );

  state.humanAuthMode = mode;
  if (mode === "disabled") {
    config.humanAuth.enabled = false;
    saveConfig(config);
    await prompter.note(
      "Human Auth Bridge",
      "Disabled. You can rerun `openpocket onboard` to enable it later.",
    );
    return;
  }

  config.humanAuth.enabled = true;
  config.humanAuth.useLocalRelay = true;
  config.humanAuth.relayBaseUrl = "";

  if (mode === "lan") {
    config.humanAuth.tunnel.provider = "none";
    config.humanAuth.tunnel.ngrok.enabled = false;
    config.humanAuth.localRelayHost = "0.0.0.0";

    const publicUrl = await prompter.text(
      "LAN URL reachable from your phone (e.g., http://192.168.1.25:8787)",
      config.humanAuth.publicBaseUrl || "",
      (value) => {
        const v = value.trim();
        if (!v) {
          return "LAN URL cannot be empty in LAN mode.";
        }
        if (!/^https?:\/\//i.test(v)) {
          return "LAN URL must start with http:// or https://";
        }
        return null;
      },
    );
    config.humanAuth.publicBaseUrl = publicUrl.trim().replace(/\/+$/, "");
    state.humanAuthEnabledAt = nowIso();
    saveConfig(config);
    await prompter.note(
      "Human Auth Bridge",
      [
        "Enabled in LAN mode.",
        `Gateway will auto-start local relay on ${config.humanAuth.localRelayHost}:${config.humanAuth.localRelayPort}.`,
        `Phone open URL base: ${config.humanAuth.publicBaseUrl}`,
      ].join("\n"),
    );
    return;
  }

  config.humanAuth.tunnel.provider = "ngrok";
  config.humanAuth.tunnel.ngrok.enabled = true;
  config.humanAuth.localRelayHost = "127.0.0.1";
  config.humanAuth.publicBaseUrl = "";

  const envName = config.humanAuth.tunnel.ngrok.authtokenEnv || "NGROK_AUTHTOKEN";
  const ngrokVersion = detectCommandVersion(config.humanAuth.tunnel.ngrok.executable);
  await prompter.note(
    "ngrok Setup",
    ngrokVersion
      ? `Detected ${config.humanAuth.tunnel.ngrok.executable}: ${ngrokVersion}`
      : buildNgrokSetupGuide(config.humanAuth.tunnel.ngrok.executable, envName),
  );

  const envToken = process.env[envName]?.trim() ?? "";
  const configToken = config.humanAuth.tunnel.ngrok.authtoken.trim();
  const hasConfigToken = Boolean(configToken);
  const ngrokTokenOptions: SelectOption<TokenChoice>[] = [
    {
      value: "env",
      label: `Use environment variable ${envName}`,
      hint: envToken ? `Detected (length ${envToken.length})` : "Not detected",
    },
    {
      value: "config",
      label: "Paste token and save to local config.json",
      hint: hasConfigToken ? `Current config token detected (length ${configToken.length})` : undefined,
    },
    {
      value: "skip",
      label: "Skip for now",
    },
  ];
  if (hasConfigToken) {
    ngrokTokenOptions.splice(1, 0, {
      value: "config-existing",
      label: "Use existing token from local config.json",
      hint: `Detected (length ${configToken.length})`,
    });
  }

  const tokenMethod = await prompter.select<TokenChoice>(
    "How should OpenPocket read ngrok authtoken?",
    ngrokTokenOptions,
    hasConfigToken ? "config-existing" : envToken ? "env" : "config",
  );

  if (tokenMethod === "env") {
    config.humanAuth.tunnel.ngrok.authtoken = "";
    if (!envToken) {
      await prompter.note(
        "ngrok Setup",
        `${envName} is not set in the current shell. Gateway may fail to open ngrok tunnel until you export this env.`,
      );
    }
  } else if (tokenMethod === "config") {
    const token = await promptSecretWithRetryOrSkip(prompter, "Enter ngrok authtoken", "ngrok authtoken");
    if (token) {
      const confirmed = await prompter.confirm(
        "Confirm writing ngrok authtoken to local config.json?",
        true,
      );
      if (confirmed) {
        config.humanAuth.tunnel.ngrok.authtoken = token;
      }
    }
  }

  state.humanAuthEnabledAt = nowIso();
  state.ngrokConfiguredAt = nowIso();
  saveConfig(config);
  await prompter.note(
    "Human Auth Bridge",
    [
      "Enabled in ngrok mode.",
      "Gateway will auto-start local relay and ngrok tunnel.",
      "No separate relay command is required for normal use.",
    ].join("\n"),
  );
}

export async function runSetupWizard(
  config: OpenPocketConfig,
  options: RunSetupOptions = {},
): Promise<void> {
  if (!options.skipTtyCheck && !options.prompter && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("`setup` requires an interactive terminal (TTY).");
  }

  const prompter = options.prompter ?? makeConsolePrompter();
  const emulator = options.emulator ?? new EmulatorManager(config);
  const state = loadState(config);

  try {
    if (options.printHeader !== false) {
      printHeader();
    }
    await prompter.intro("OpenPocket onboarding");
    await runConsentStep(prompter, state);
    await runDeploymentTargetStep(config, prompter, state);
    const selectedModel = await runModelSelectionStep(config, prompter, state);
    await runApiKeyStep(config, prompter, state, selectedModel, options);
    await runChannelSetupStep(config, prompter, state);
    await runVmStep(config, prompter, state, emulator);
    await runHumanAuthStep(config, prompter, state);
    saveState(config, state);

    const configuredChannels = state.enabledChannels ?? [];
    const channelHint = configuredChannels.length > 0
      ? `  2) Send a natural-language task via ${configuredChannels.join(", ")}`
      : "  2) Configure a channel with `openpocket onboard` to start messaging";

    await prompter.outro(
      [
        "Setup completed.",
        `Onboarding state: ${onboardingStatePath(config)}`,
        "Next:",
        "  1) openpocket gateway start",
        channelHint,
        "  3) If task is blocked by real-device auth, approve via messaging channel link on your phone",
        "Tip: switch deployment target later with `openpocket target set ...` (when gateway is stopped).",
        "Tip: add more channels later with `openpocket onboard`.",
      ].join("\n"),
    );
  } finally {
    await prompter.close();
  }
}
