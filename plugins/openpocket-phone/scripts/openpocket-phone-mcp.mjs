#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const extraArgs = process.argv.slice(2);

function debug(...args) {
  if (process.env.OPENPOCKET_PHONE_MCP_DEBUG) {
    console.error("[openpocket-phone][debug]", ...args);
  }
}

function existingFile(candidate) {
  if (!candidate) {
    return null;
  }
  const resolved = path.resolve(candidate);
  return existsSync(resolved) ? resolved : null;
}

function findServerFromAncestors(startDir) {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = existingFile(path.join(current, "dist/mcp/server.js"));
    if (candidate) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function inferMarketplaceNameFromCachePath() {
  const parts = pluginRoot.split(path.sep);
  const cacheIndex = parts.lastIndexOf("cache");
  if (cacheIndex < 0 || cacheIndex + 1 >= parts.length) {
    return null;
  }
  return parts[cacheIndex + 1] || null;
}

function unquoteTomlString(value) {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/^"((?:[^"\\]|\\.)*)"/);
  if (!match) {
    return null;
  }
  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function findMarketplaceRootFromCodexConfig() {
  const marketplaceName = inferMarketplaceNameFromCachePath();
  if (!marketplaceName) {
    return null;
  }

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  if (!existsSync(configPath)) {
    return null;
  }

  const sectionPattern = new RegExp(
    `^\\[marketplaces\\.${marketplaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]$`,
  );
  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = sectionPattern.test(trimmed);
      continue;
    }
    if (!inSection || !/^source\s*=/.test(trimmed)) {
      continue;
    }
    const [, rawValue] = trimmed.split(/=(.*)/s);
    const source = unquoteTomlString(rawValue);
    if (source) {
      return source;
    }
  }
  return null;
}

function serverCandidates() {
  const marketplaceRoot = findMarketplaceRootFromCodexConfig();
  const candidates = [
    existingFile(process.env.OPENPOCKET_MCP_SERVER),
    process.env.OPENPOCKET_REPO_ROOT
      ? existingFile(path.join(process.env.OPENPOCKET_REPO_ROOT, "dist/mcp/server.js"))
      : null,
    marketplaceRoot ? existingFile(path.join(marketplaceRoot, "dist/mcp/server.js")) : null,
    findServerFromAncestors(pluginRoot),
    existingFile(path.join(process.cwd(), "dist/mcp/server.js")),
  ];
  const filtered = candidates.filter(Boolean);
  debug("pluginRoot", pluginRoot);
  debug("cwd", process.cwd());
  debug("marketplaceRoot", marketplaceRoot);
  debug("serverCandidates", filtered);
  return filtered;
}

function run(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  child.on("error", (error) => {
    console.error("[openpocket-phone] failed to start MCP server:");
    console.error(error.message);
    console.error("Build this repository with `npm run build`, set OPENPOCKET_REPO_ROOT, or install the `openpocket-mcp` binary.");
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

const [serverPath] = serverCandidates();
if (serverPath) {
  run(process.execPath, [serverPath, ...extraArgs]);
} else {
  run("openpocket-mcp", extraArgs);
}
