#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(pluginRoot, "../..");
const marketplaceName = "openpocket-local";
const pluginName = "openpocket-phone";
const pluginSelector = `${pluginName}@${marketplaceName}`;
const targetTypes = new Set(["emulator", "physical-phone", "android-tv", "cloud"]);

const clientAliases = new Map([
  ["codex", "codex"],
  ["codex-cli", "codex"],
  ["codex-desktop", "codex"],
  ["claude", "claude-code"],
  ["claude-code", "claude-code"],
  ["claude-cli", "claude-code"],
  ["claude-desktop", "claude-code"],
]);

function usage() {
  return `OpenPocket Phone installer

Usage:
  npm run phone-use:install -- codex [options]
  npm run phone-use:install -- claude-code [options]

Clients:
  codex        Installs the Codex plugin for Codex CLI and Codex Desktop.
  claude-code  Registers a user-scoped MCP server for Claude Code CLI and Desktop.

Options:
  --target <type>       Configure emulator, physical-phone, android-tv, or cloud.
  --device <serial>     Pin a physical target to one ADB device serial.
  --start-emulator      Start the configured emulator after installation.
  --skip-deps           Do not install missing npm dependencies.
  --skip-build          Reuse the existing dist/ build.
  --dry-run             Print the plan without changing files or client config.
  -h, --help            Show this help.
`;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseInstallArgs(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    return { help: true };
  }

  const rawClient = String(argv[0] || "").trim().toLowerCase();
  const client = clientAliases.get(rawClient);
  if (!client) {
    throw new Error(`Unknown client: ${rawClient || "(missing)"}. Use codex or claude-code.`);
  }

  const options = {
    help: false,
    client,
    target: null,
    device: null,
    startEmulator: false,
    skipDeps: false,
    skipBuild: false,
    dryRun: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      options.target = takeValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--device") {
      options.device = takeValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--start-emulator") {
      options.startEmulator = true;
      continue;
    }
    if (arg === "--skip-deps") {
      options.skipDeps = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.device && !options.target) {
    options.target = "physical-phone";
  }
  if (options.target && !targetTypes.has(options.target)) {
    throw new Error(
      `Unknown target: ${options.target}. Use emulator, physical-phone, android-tv, or cloud.`,
    );
  }
  if (options.device && !["physical-phone", "android-tv"].includes(options.target)) {
    throw new Error("--device can only be used with physical-phone or android-tv targets.");
  }
  if (options.startEmulator && options.target && options.target !== "emulator") {
    throw new Error("--start-emulator cannot be used with a non-emulator target.");
  }

  return options;
}

function quoteArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function commandLine(command, args) {
  return [command, ...args].map(quoteArg).join(" ");
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
  });
  return {
    command: commandLine(command, args),
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

function outputTail(value, maxChars = 2400) {
  const text = String(value || "").trim();
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function assertSuccess(result, label) {
  if (result.status === 0 && !result.error) {
    return result;
  }
  const details = [outputTail(result.stderr), outputTail(result.stdout)]
    .filter(Boolean)
    .join("\n");
  throw new Error(
    `${label} failed while running: ${result.command}${details ? `\n${details}` : ""}`,
  );
}

function findOnPath(name) {
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue searching.
      }
    }
  }
  return null;
}

function uniqueExistingPaths(candidates) {
  const seen = new Set();
  const resolved = [];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const value = path.resolve(candidate);
    if (seen.has(value) || !fs.existsSync(value)) {
      continue;
    }
    seen.add(value);
    resolved.push(value);
  }
  return resolved;
}

export function codexBinaryCandidates() {
  return uniqueExistingPaths([
    process.env.OPENPOCKET_CODEX_BIN,
    process.platform === "darwin"
      ? "/Applications/ChatGPT.app/Contents/Resources/codex"
      : null,
    process.platform === "darwin"
      ? path.join(os.homedir(), "Applications/ChatGPT.app/Contents/Resources/codex")
      : null,
    findOnPath("codex"),
  ]);
}

export function parseMarketplaceList(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s{2,}(.+?)\s*$/);
    if (!match || match[1] === "MARKETPLACE") {
      continue;
    }
    rows.push({ name: match[1], root: match[2] });
  }
  return rows;
}

function resolveCodexBinary(dryRun) {
  const candidates = codexBinaryCandidates();
  if (dryRun) {
    return {
      binary: candidates[0] || "codex",
      marketplaceOutput: "",
      probed: false,
    };
  }

  const failures = [];
  for (const binary of candidates) {
    const result = execute(binary, ["plugin", "marketplace", "list"]);
    if (result.status === 0 && !result.error) {
      return {
        binary,
        marketplaceOutput: result.stdout,
        probed: true,
      };
    }
    failures.push(`${binary}: ${outputTail(result.stderr || result.stdout, 500)}`);
  }

  if (candidates.length === 0) {
    throw new Error(
      "Codex CLI was not found. Install Codex CLI or the Codex desktop app, then retry.",
    );
  }
  throw new Error(`No usable Codex CLI was found.\n${failures.join("\n")}`);
}

function installCodexPlugin(dryRun) {
  const resolved = resolveCodexBinary(dryRun);
  const rows = parseMarketplaceList(resolved.marketplaceOutput);
  const existing = rows.find((row) => row.name === marketplaceName);

  if (existing && path.resolve(existing.root) !== repoRoot) {
    throw new Error(
      `Marketplace ${marketplaceName} already points to ${existing.root}, not ${repoRoot}.`,
    );
  }

  const commands = [];
  if (!existing) {
    commands.push([resolved.binary, ["plugin", "marketplace", "add", repoRoot]]);
  }
  commands.push([resolved.binary, ["plugin", "add", pluginSelector]]);

  if (!dryRun) {
    for (const [command, args] of commands) {
      assertSuccess(execute(command, args), "Codex plugin installation");
    }
  }

  return {
    binary: resolved.binary,
    commands: commands.map(([command, args]) => commandLine(command, args)),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeClaudeConfig(config, serverEntry) {
  if (!isPlainObject(config)) {
    throw new Error("Claude configuration must be a JSON object.");
  }
  if (config.mcpServers !== undefined && !isPlainObject(config.mcpServers)) {
    throw new Error("Claude configuration mcpServers must be a JSON object.");
  }
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers || {}),
      [pluginName]: serverEntry,
    },
  };
}

export function installClaudeCodeConfig({
  configPath = process.env.OPENPOCKET_CLAUDE_CONFIG
    || path.join(os.homedir(), ".claude.json"),
  nodePath = process.execPath,
  serverPath = path.join(repoRoot, "dist", "mcp", "server.js"),
  dryRun = false,
} = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  const serverEntry = {
    type: "stdio",
    command: path.resolve(nodePath),
    args: [path.resolve(serverPath)],
  };

  let existing = {};
  let existingText = null;
  if (fs.existsSync(resolvedConfigPath)) {
    existingText = fs.readFileSync(resolvedConfigPath, "utf8");
    try {
      existing = JSON.parse(existingText);
    } catch (error) {
      throw new Error(
        `Claude configuration is not valid JSON: ${resolvedConfigPath}\n${error.message}`,
      );
    }
  }

  const merged = mergeClaudeConfig(existing, serverEntry);
  const nextText = `${JSON.stringify(merged, null, 2)}\n`;
  const changed = existingText !== nextText;
  const backupPath = existingText && changed
    ? `${resolvedConfigPath}.openpocket-phone.bak`
    : null;

  if (!dryRun && changed) {
    fs.mkdirSync(path.dirname(resolvedConfigPath), { recursive: true });
    let mode = 0o600;
    if (fs.existsSync(resolvedConfigPath)) {
      mode = fs.statSync(resolvedConfigPath).mode & 0o777;
      fs.copyFileSync(resolvedConfigPath, backupPath);
      fs.chmodSync(backupPath, mode);
    }
    const tempPath = `${resolvedConfigPath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, nextText, { encoding: "utf8", mode });
    fs.renameSync(tempPath, resolvedConfigPath);
    fs.chmodSync(resolvedConfigPath, mode);
  }

  return {
    configPath: resolvedConfigPath,
    backupPath,
    changed,
    serverEntry,
  };
}

function ensureNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Node.js 20 or newer is required. Current version: ${process.versions.node}`);
  }
}

function printStep(index, total, label, detail) {
  console.log(`[${index}/${total}] ${label.padEnd(12)} ${detail}`);
}

function runBuild(options) {
  const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const dependenciesReady = fs.existsSync(tscPath);
  if (!dependenciesReady && options.skipDeps) {
    throw new Error("npm dependencies are missing and --skip-deps was provided.");
  }
  if (!dependenciesReady && !options.dryRun) {
    assertSuccess(
      execute("npm", ["install", "--no-audit", "--no-fund"]),
      "Dependency installation",
    );
  }

  const serverPath = path.join(repoRoot, "dist", "mcp", "server.js");
  if (!options.skipBuild && !options.dryRun) {
    assertSuccess(execute("npm", ["run", "build", "--silent"]), "OpenPocket build");
  }
  if (!options.dryRun && !fs.existsSync(serverPath)) {
    throw new Error(`MCP server build is missing: ${serverPath}`);
  }

  return {
    dependenciesReady,
    serverPath,
  };
}

function configureTarget(options) {
  const cliPath = path.join(repoRoot, "dist", "cli.js");
  if (options.dryRun) {
    return options.target || "existing config (default: emulator)";
  }

  if (options.target) {
    const args = [cliPath, "target", "set", "--type", options.target];
    if (options.device) {
      args.push("--device", options.device);
    }
    assertSuccess(execute(process.execPath, args), "Target configuration");
  } else {
    assertSuccess(
      execute(process.execPath, [cliPath, "target", "show"]),
      "Target initialization",
    );
  }

  if (options.startEmulator) {
    assertSuccess(
      execute(process.execPath, [cliPath, "emulator", "start"]),
      "Emulator startup",
    );
  }
  return options.target || "existing config (default: emulator)";
}

function runDoctor(dryRun) {
  if (dryRun) {
    return { toolCount: 23 };
  }
  const doctorPath = path.join(pluginRoot, "scripts", "doctor.mjs");
  const result = assertSuccess(
    execute(process.execPath, [doctorPath]),
    "OpenPocket Phone doctor",
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Doctor returned invalid JSON.\n${outputTail(result.stdout)}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseInstallArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  ensureNodeVersion();
  const clientLabel = options.client === "codex"
    ? "Codex CLI + Desktop"
    : "Claude Code CLI + Desktop";
  const total = 5;

  console.log("OpenPocket Phone");
  console.log(`Client: ${clientLabel}`);
  if (options.dryRun) {
    console.log("Mode: dry run");
  }
  console.log("");

  const build = runBuild(options);
  printStep(
    1,
    total,
    "Dependencies",
    build.dependenciesReady ? "ready" : options.dryRun ? "install if missing" : "installed",
  );
  printStep(2, total, "Runtime", options.skipBuild ? "reused existing build" : "built");

  const target = configureTarget(options);
  printStep(3, total, "Target", target);

  if (options.client === "codex") {
    const codex = installCodexPlugin(options.dryRun);
    printStep(4, total, "Plugin", `${pluginSelector} installed`);
    if (options.dryRun) {
      for (const command of codex.commands) {
        console.log(`             ${command}`);
      }
    }
  } else {
    const claude = installClaudeCodeConfig({
      serverPath: build.serverPath,
      dryRun: options.dryRun,
    });
    printStep(4, total, "MCP", `${pluginName} registered in ${claude.configPath}`);
    if (claude.backupPath) {
      console.log(`             Backup: ${claude.backupPath}`);
    }
  }

  const doctor = runDoctor(options.dryRun);
  printStep(5, total, "Doctor", `${doctor.toolCount} tools ready`);

  console.log("");
  console.log(`Ready for ${clientLabel}.`);
  console.log("Restart the client and start a new task, then ask:");
  console.log("Use openpocket-phone. Call target_status and report the Android target.");
  return 0;
}

const isMainEntry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMainEntry) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`OpenPocket Phone install failed: ${error.message}`);
    process.exitCode = 1;
  });
}
