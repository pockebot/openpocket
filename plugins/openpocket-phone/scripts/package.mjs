#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const integrationRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(integrationRoot, "../..");
const codexPluginRoot = path.join(integrationRoot, "codex", "openpocket-phone");
const claudePluginRoot = path.join(integrationRoot, "claude", "openpocket-phone");
const sharedSkillPath = path.join(
  integrationRoot,
  "shared",
  "skills",
  "phone-use",
  "SKILL.md",
);
const releasesDir = path.join(claudePluginRoot, "releases");
const archivePath = path.join(releasesDir, "openpocket-phone-claude.zip");
const esbuildPath = path.join(repoRoot, "node_modules", ".bin", "esbuild");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    shell: false,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed${detail ? `\n${detail}` : ""}`);
  }
}

function copyIntoStage(stageDir, relativePath) {
  const source = path.join(claudePluginRoot, relativePath);
  const destination = path.join(stageDir, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function buildRuntime(runtimeDir) {
  if (!fs.existsSync(esbuildPath)) {
    throw new Error("esbuild is missing. Run npm install before packaging the phone plugins.");
  }

  fs.mkdirSync(runtimeDir, { recursive: true });

  run(esbuildPath, [
    "src/mcp/server.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--external:sharp",
    `--outfile=${path.join(runtimeDir, "openpocket-phone-server.mjs")}`,
  ]);
  run(esbuildPath, [
    "src/device/screen-awake-worker.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    `--outfile=${path.join(runtimeDir, "screen-awake-worker.js")}`,
  ]);

  fs.copyFileSync(
    path.join(repoRoot, "assets", "android", "openpocket-ime.apk"),
    path.join(runtimeDir, "openpocket-ime.apk"),
  );
  fs.chmodSync(path.join(runtimeDir, "openpocket-phone-server.mjs"), 0o755);
  fs.chmodSync(path.join(runtimeDir, "screen-awake-worker.js"), 0o755);
}

function replaceDirectory(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

function syncHostBundles(runtimeDir) {
  for (const pluginRoot of [codexPluginRoot, claudePluginRoot]) {
    replaceDirectory(runtimeDir, path.join(pluginRoot, "runtime"));
    const skillPath = path.join(pluginRoot, "skills", "phone-use", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.copyFileSync(sharedSkillPath, skillPath);
  }
}

function buildArchive() {
  fs.mkdirSync(releasesDir, { recursive: true });
  fs.rmSync(archivePath, { force: true });
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-claude-plugin-"));
  try {
    for (const relativePath of [
      ".claude-plugin",
      ".mcp.json",
      "README.md",
      "skills",
      "runtime",
    ]) {
      copyIntoStage(stageDir, relativePath);
    }
    run("zip", ["-q", "-X", "-r", archivePath, "."], { cwd: stageDir });
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-phone-build-"));
try {
  const runtimeDir = path.join(buildDir, "runtime");
  buildRuntime(runtimeDir);
  syncHostBundles(runtimeDir);
  buildArchive();
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true });
}

const sizeKb = Math.ceil(fs.statSync(archivePath).size / 1024);
console.log(`Codex plugin: ${codexPluginRoot}`);
console.log(`Claude plugin: ${claudePluginRoot}`);
console.log(`Claude archive: ${archivePath}`);
console.log(`Archive size: ${sizeKb} KB`);
