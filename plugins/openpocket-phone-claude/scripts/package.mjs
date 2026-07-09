#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(pluginRoot, "../..");
const runtimeDir = path.join(pluginRoot, "runtime");
const releasesDir = path.join(pluginRoot, "releases");
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
  const source = path.join(pluginRoot, relativePath);
  const destination = path.join(stageDir, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function buildRuntime() {
  if (!fs.existsSync(esbuildPath)) {
    throw new Error("esbuild is missing. Run npm install before packaging the Claude plugin.");
  }

  fs.rmSync(runtimeDir, { recursive: true, force: true });
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

buildRuntime();
buildArchive();

const sizeKb = Math.ceil(fs.statSync(archivePath).size / 1024);
console.log(`Claude plugin: ${archivePath}`);
console.log(`Archive size: ${sizeKb} KB`);
