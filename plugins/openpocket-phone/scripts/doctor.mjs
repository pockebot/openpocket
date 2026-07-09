#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const integrationRoot = path.resolve(scriptDir, "..");
const codexPluginRoot = path.join(integrationRoot, "codex", "openpocket-phone");
const claudePluginRoot = path.join(integrationRoot, "claude", "openpocket-phone");
const sharedSkillPath = path.join(
  integrationRoot,
  "shared",
  "skills",
  "phone-use",
  "SKILL.md",
);
const runtimeFiles = [
  "openpocket-phone-server.mjs",
  "screen-awake-worker.js",
  "openpocket-ime.apk",
];
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required plugin file is missing: ${filePath}`);
  }
}

function inspectHost(name, pluginRoot, manifestPath) {
  const resolvedManifestPath = path.join(pluginRoot, manifestPath);
  const mcpPath = path.join(pluginRoot, ".mcp.json");
  const skillPath = path.join(pluginRoot, "skills", "phone-use", "SKILL.md");
  assertFile(resolvedManifestPath);
  assertFile(mcpPath);
  assertFile(skillPath);

  const manifest = readJson(resolvedManifestPath);
  const mcp = readJson(mcpPath);
  if (manifest.name !== "openpocket-phone") {
    throw new Error(`${name} manifest has an unexpected plugin name: ${manifest.name}`);
  }
  if (!mcp.mcpServers?.["openpocket-phone"]) {
    throw new Error(`${name} plugin does not register the openpocket-phone MCP server.`);
  }

  const runtimeHashes = {};
  for (const relativePath of runtimeFiles) {
    const filePath = path.join(pluginRoot, "runtime", relativePath);
    assertFile(filePath);
    runtimeHashes[relativePath] = hashFile(filePath);
  }

  return {
    pluginRoot,
    version: manifest.version,
    mcpServerName: "openpocket-phone",
    skillHash: hashFile(skillPath),
    runtimeHashes,
  };
}

async function main() {
  assertFile(sharedSkillPath);
  const codex = inspectHost("Codex", codexPluginRoot, ".codex-plugin/plugin.json");
  const claude = inspectHost("Claude", claudePluginRoot, ".claude-plugin/plugin.json");
  const sharedSkillHash = hashFile(sharedSkillPath);

  if (codex.skillHash !== sharedSkillHash || claude.skillHash !== sharedSkillHash) {
    throw new Error("Host skill copies are stale. Run npm run phone-use:package.");
  }
  for (const relativePath of runtimeFiles) {
    if (codex.runtimeHashes[relativePath] !== claude.runtimeHashes[relativePath]) {
      throw new Error(`Host runtime copies differ: ${relativePath}`);
    }
  }

  const serverPath = path.join(codexPluginRoot, "runtime", "openpocket-phone-server.mjs");
  const serverModule = await import(pathToFileURL(serverPath).href);
  const toolNames = Array.isArray(serverModule.TOOLS)
    ? serverModule.TOOLS.map((tool) => tool.name)
    : [];
  const missingTools = requiredTools.filter((name) => !toolNames.includes(name));
  if (missingTools.length > 0) {
    throw new Error(`MCP server is missing required tools: ${missingTools.join(", ")}`);
  }

  console.log(JSON.stringify({
    ok: true,
    integrationRoot,
    sourceSkill: sharedSkillPath,
    synchronized: true,
    toolCount: toolNames.length,
    requiredTools,
    toolNames,
    hosts: { codex, claude },
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    integrationRoot,
    error: error?.message ? String(error.message) : String(error),
  }, null, 2));
  process.exit(1);
});
