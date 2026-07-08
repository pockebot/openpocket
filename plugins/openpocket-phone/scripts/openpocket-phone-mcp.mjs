#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const extraArgs = process.argv.slice(2);

function existingFile(candidate) {
  if (!candidate) {
    return null;
  }
  const resolved = path.resolve(candidate);
  return existsSync(resolved) ? resolved : null;
}

function serverCandidates() {
  const candidates = [
    existingFile(process.env.OPENPOCKET_MCP_SERVER),
    process.env.OPENPOCKET_REPO_ROOT
      ? existingFile(path.join(process.env.OPENPOCKET_REPO_ROOT, "dist/mcp/server.js"))
      : null,
    existingFile(path.join(pluginRoot, "../../../dist/mcp/server.js")),
    existingFile(path.join(process.cwd(), "dist/mcp/server.js")),
  ];
  return candidates.filter(Boolean);
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
