import { stdout as output } from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkgJson = require("../../package.json") as { version: string; license: string };

export type CliTone = "plain" | "accent" | "muted" | "info" | "success" | "warn" | "error";
export type CliStepStatus = "ok" | "running" | "warn" | "failed" | "skipped";

export const OPENPOCKET_ASCII = [
  "  ██████╗  ██████╗  ███████╗ ███╗   ██╗ ██████╗   ██████╗   ██████╗ ██╗  ██╗  ███████╗ ████████╗",
  " ██╔═══██╗ ██╔══██╗ ██╔════╝ ████╗  ██║ ██╔══██╗ ██╔═══██╗ ██╔════╝ ██║ ██╔╝  ██╔════╝ ╚══██╔══╝",
  " ██║   ██║ ██████╔╝ █████╗   ██╔██╗ ██║ ██████╔╝ ██║   ██║ ██║      █████╔╝   █████╗      ██║   ",
  " ██║   ██║ ██╔═══╝  ██╔══╝   ██║╚██╗██║ ██╔═══╝  ██║   ██║ ██║      ██╔═██╗   ██╔══╝      ██║   ",
  " ╚██████╔╝ ██║      ███████╗ ██║ ╚████║ ██║      ╚██████╔╝ ╚██████╗ ██║  ██╗  ███████╗    ██║   ",
  "  ╚═════╝  ╚═╝      ╚══════╝ ╚═╝  ╚═══╝ ╚═╝       ╚═════╝   ╚═════╝ ╚═╝  ╚═╝  ╚══════╝    ╚═╝   ",
] as const;

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[2m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_BOLD_WHITE = "\u001b[1;37m";
const ANSI_BOLD_CYAN = "\u001b[1;36m";
const ANSI_BOLD_GREEN = "\u001b[1;32m";
const ANSI_BOLD_YELLOW = "\u001b[1;33m";
const ANSI_BOLD_RED = "\u001b[1;31m";
const ANSI_BOLD_BLUE = "\u001b[1;34m";

const TONE_ANSI: Record<CliTone, string | null> = {
  plain: null,
  accent: ANSI_BOLD_CYAN,
  muted: ANSI_DIM,
  info: ANSI_BOLD_BLUE,
  success: ANSI_BOLD_GREEN,
  warn: ANSI_BOLD_YELLOW,
  error: ANSI_BOLD_RED,
};

function padRight(text: string, width: number): string {
  if (text.length >= width) {
    return text;
  }
  return `${text}${" ".repeat(width - text.length)}`;
}

export function shouldUseColor(stream: NodeJS.WriteStream = output): boolean {
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

export function colorize(text: string, ansiCode: string | null, enabled: boolean): string {
  if (!enabled || !ansiCode) {
    return text;
  }
  return `${ansiCode}${text}${ANSI_RESET}`;
}

function tonePaint(text: string, tone: CliTone, enabled: boolean): string {
  return colorize(text, TONE_ANSI[tone], enabled);
}

export function createOpenPocketBanner(options?: {
  subtitle?: string;
  stream?: NodeJS.WriteStream;
}): string {
  const stream = options?.stream ?? output;
  const useColor = shouldUseColor(stream);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const subtitle = options?.subtitle?.trim() || "GATEWAY RUNTIME";

  const ascii = OPENPOCKET_ASCII.map((line) => colorize(line, ANSI_BOLD_WHITE, useColor));
  const subtitleLine = colorize(`                             ${subtitle}                             `, ANSI_BOLD_YELLOW, useColor);
  const meta = colorize(
    `  Version: ${pkgJson.version}  |  License: ${pkgJson.license}  |  ${timestamp}`,
    ANSI_DIM,
    useColor,
  );

  return [...ascii, subtitleLine, "", meta, ""].join("\n");
}

export interface CliTheme {
  useColor: boolean;
  paint: (text: string, tone?: CliTone) => string;
  label: (text: string, tone?: CliTone) => string;
  section: (title: string) => string;
  info: (message: string) => string;
  success: (message: string) => string;
  warn: (message: string) => string;
  error: (message: string) => string;
  kv: (key: string, value: string, tone?: CliTone) => string;
  step: (step: number, total: number, title: string, status: CliStepStatus, detail: string) => string;
  emphasize: (text: string, tone?: CliTone) => string;
  classifyRuntimeLine: (line: string) => string;
}

export function createCliTheme(stream: NodeJS.WriteStream = output): CliTheme {
  const useColor = shouldUseColor(stream);

  const paint = (text: string, tone: CliTone = "plain") => tonePaint(text, tone, useColor);

  const statusBadge = (status: CliStepStatus): string => {
    if (status === "ok") {
      return paint("OK", "success");
    }
    if (status === "running") {
      return paint("RUN", "info");
    }
    if (status === "warn") {
      return paint("WARN", "warn");
    }
    if (status === "failed") {
      return paint("FAIL", "error");
    }
    return paint("SKIP", "muted");
  };

  const runtimeTone = (line: string): CliTone => {
    const lowered = line.toLowerCase();
    if (lowered.includes("[download]") && lowered.includes("100%")) {
      return "success";
    }
    if (lowered.includes("[download]")) {
      return "info";
    }
    if (lowered.includes("[warn]") || lowered.includes(" warning") || lowered.includes("warn=")) {
      return "warn";
    }
    if (lowered.includes(" error") || lowered.includes("failed") || lowered.includes(" fail") || lowered.includes("exception")) {
      return "error";
    }
    if (lowered.includes("[gateway-loop]")) {
      return "warn";
    }
    if (lowered.includes("[human-auth]")) {
      return "accent";
    }
    if (lowered.includes("[heartbeat]")) {
      return "muted";
    }
    if (lowered.includes("[cron]")) {
      return "info";
    }
    if (lowered.includes("[gateway]")) {
      return "accent";
    }
    if (lowered.includes("[env]")) {
      return "info";
    }
    return "plain";
  };

  return {
    useColor,
    paint,
    label: (text: string, tone: CliTone = "accent") => {
      if (tone === "plain") {
        return colorize(`[${text}]`, ANSI_BOLD, useColor);
      }
      return paint(`[${text}]`, tone);
    },
    section: (title: string) => `${paint("===", "muted")} ${paint(title, "accent")} ${paint("===", "muted")}`,
    info: (message: string) => `${paint("[INFO]", "info")} ${message}`,
    success: (message: string) => `${paint("[OK]", "success")} ${message}`,
    warn: (message: string) => `${paint("[WARN]", "warn")} ${message}`,
    error: (message: string) => `${paint("[ERROR]", "error")} ${message}`,
    kv: (key: string, value: string, tone: CliTone = "plain") => {
      const formattedKey = paint(`${padRight(key, 18)}:`, "muted");
      return `  ${formattedKey} ${paint(value, tone)}`;
    },
    step: (step: number, total: number, title: string, status: CliStepStatus, detail: string) => {
      const head = `${paint(`[${step}/${total}]`, "accent")} ${title}`;
      const tail = `${statusBadge(status)} ${detail}`.trim();
      return `${head} ${paint("->", "muted")} ${tail}`;
    },
    emphasize: (text: string, tone: CliTone = "accent") => paint(text, tone),
    classifyRuntimeLine: (line: string) => paint(line, runtimeTone(line)),
  };
}
