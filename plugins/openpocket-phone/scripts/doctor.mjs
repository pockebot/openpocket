#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const requiredTools = [
  "target_status",
  "current_app",
  "screenshot",
  "ui_snapshot",
  "visible_text",
  "find_text",
  "wait_for_text",
  "tap_text",
  "open_app",
  "list_apps",
];

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
  return [
    existingFile(process.env.OPENPOCKET_MCP_SERVER),
    process.env.OPENPOCKET_REPO_ROOT
      ? existingFile(path.join(process.env.OPENPOCKET_REPO_ROOT, "dist/mcp/server.js"))
      : null,
    marketplaceRoot ? existingFile(path.join(marketplaceRoot, "dist/mcp/server.js")) : null,
    findServerFromAncestors(pluginRoot),
    existingFile(path.join(process.cwd(), "dist/mcp/server.js")),
  ].filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

async function main() {
  const pluginJsonPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const mcpJsonPath = path.join(pluginRoot, ".mcp.json");
  const pluginJson = readJson(pluginJsonPath);
  const mcpJson = readJson(mcpJsonPath);
  const [serverPath] = serverCandidates();
  if (!serverPath) {
    throw new Error("MCP server not found. Run npm run build or set OPENPOCKET_REPO_ROOT.");
  }
  const serverModule = await import(pathToFileURL(serverPath).href);
  const toolNames = Array.isArray(serverModule.TOOLS)
    ? serverModule.TOOLS.map((tool) => tool.name)
    : [];
  const missingTools = requiredTools.filter((name) => !toolNames.includes(name));
  if (missingTools.length > 0) {
    throw new Error(`MCP server is missing required tools: ${missingTools.join(", ")}`);
  }
  const payload = {
    ok: true,
    pluginRoot,
    pluginName: pluginJson.name,
    pluginVersion: pluginJson.version,
    mcpServerName: Object.keys(mcpJson.mcpServers || {})[0] ?? null,
    serverPath,
    toolCount: toolNames.length,
    requiredTools,
    toolNames,
  };
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    pluginRoot,
    error: error?.message ? String(error.message) : String(error),
  }, null, 2));
  process.exit(1);
});
