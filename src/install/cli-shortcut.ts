import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface InstallCliShortcutOptions {
  cliPath?: string;
  homeDir?: string;
  shellRcPaths?: string[];
  commandName?: string;
}

export interface InstallCliShortcutResult {
  commandPath: string;
  binDir: string;
  cliPath: string;
  shellRcUpdated: string[];
  binDirAlreadyInPath: boolean;
  preferredPathCommandPath: string | null;
}

function shellSingleQuote(input: string): string {
  return `'${input.replace(/'/g, `'\"'\"'`)}'`;
}

function ensurePathLine(shellRcPath: string, exportLine: string): boolean {
  const marker = "# OpenPocket CLI";
  const lineExists = (body: string) =>
    body.includes(exportLine) || body.includes(`${marker}\n${exportLine}`);

  if (!fs.existsSync(shellRcPath)) {
    fs.writeFileSync(shellRcPath, "", "utf-8");
  }
  const body = fs.readFileSync(shellRcPath, "utf-8");
  if (lineExists(body)) {
    return false;
  }

  const suffix = body.endsWith("\n") || body.length === 0 ? "" : "\n";
  fs.appendFileSync(shellRcPath, `${suffix}${marker}\n${exportLine}\n`, "utf-8");
  return true;
}

function defaultCliPath(): string {
  // dist/install/cli-shortcut.js -> dist/cli.js
  return path.resolve(__dirname, "..", "cli.js");
}

function buildLauncher(cliPath: string): string {
  return [
    "#!/usr/bin/env bash",
    "# OpenPocket CLI launcher",
    "set -euo pipefail",
    `exec node ${shellSingleQuote(cliPath)} "$@"`,
    "",
  ].join("\n");
}

function isWritableDirectory(dirPath: string): boolean {
  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      return false;
    }
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function installPreferredPathLauncher(
  commandName: string,
  launcher: string,
  homeBinDir: string,
): string | null {
  if (process.env.OPENPOCKET_SKIP_ENV_SETUP === "1" || process.env.OPENPOCKET_SKIP_GLOBAL_PATH_INSTALL === "1") {
    return null;
  }

  const preferred = ["/usr/local/bin", "/opt/homebrew/bin"];
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);

  const candidates = Array.from(
    new Set([...preferred, ...pathEntries].map((entry) => path.resolve(entry))),
  );

  for (const dir of candidates) {
    if (path.resolve(dir) === path.resolve(homeBinDir)) {
      continue;
    }
    if (!isWritableDirectory(dir)) {
      continue;
    }

    const commandPath = path.join(dir, commandName);
    if (fs.existsSync(commandPath)) {
      try {
        const existing = fs.readFileSync(commandPath, "utf-8");
        if (!existing.includes("# OpenPocket CLI launcher")) {
          continue;
        }
      } catch {
        continue;
      }
    }

    try {
      fs.writeFileSync(commandPath, launcher, { encoding: "utf-8", mode: 0o755 });
      fs.chmodSync(commandPath, 0o755);
      return commandPath;
    } catch {
      // Best effort only; continue to next candidate directory.
    }
  }

  return null;
}

function defaultShellRcPaths(homeDir: string): string[] {
  const candidates = [
    path.join(homeDir, ".zshrc"),
    path.join(homeDir, ".zprofile"),
    path.join(homeDir, ".bash_profile"),
    path.join(homeDir, ".bashrc"),
    path.join(homeDir, ".profile"),
  ];
  return Array.from(new Set(candidates));
}

export function installCliShortcut(
  options: InstallCliShortcutOptions = {},
): InstallCliShortcutResult {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const commandName = options.commandName ?? "openpocket";
  const cliPath = path.resolve(options.cliPath ?? defaultCliPath());
  const binDir = path.join(homeDir, ".local", "bin");
  const commandPath = path.join(binDir, commandName);
  fs.mkdirSync(binDir, { recursive: true });

  const launcher = buildLauncher(cliPath);
  fs.writeFileSync(commandPath, launcher, { encoding: "utf-8", mode: 0o755 });
  fs.chmodSync(commandPath, 0o755);
  const preferredPathCommandPath = options.homeDir
    ? null
    : installPreferredPathLauncher(commandName, launcher, binDir);

  const exportLine = 'export PATH="$HOME/.local/bin:$PATH"';
  const shellRcPaths = options.shellRcPaths ?? defaultShellRcPaths(homeDir);
  const shellRcUpdated: string[] = [];
  for (const rcPath of shellRcPaths) {
    try {
      if (ensurePathLine(rcPath, exportLine)) {
        shellRcUpdated.push(rcPath);
      }
    } catch {
      // Best effort only; launcher still works if PATH is already configured.
    }
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  const binDirAlreadyInPath = pathEntries.includes(path.resolve(binDir));

  return {
    commandPath,
    binDir,
    cliPath,
    shellRcUpdated,
    binDirAlreadyInPath,
    preferredPathCommandPath,
  };
}
