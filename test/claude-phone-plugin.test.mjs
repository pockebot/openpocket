import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins", "openpocket-phone-claude");
const serverPath = path.join(pluginRoot, "runtime", "openpocket-phone-server.mjs");
const archivePath = path.join(
  pluginRoot,
  "releases",
  "openpocket-phone-claude.zip",
);

test("Claude plugin declares one phone-use skill and one MCP server", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    "utf8",
  ));
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const skill = fs.readFileSync(
    path.join(pluginRoot, "skills", "phone-use", "SKILL.md"),
    "utf8",
  );

  assert.equal(manifest.name, "openpocket-phone");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(mcp.mcpServers["openpocket-phone"].command, "node");
  assert.deepEqual(mcp.mcpServers["openpocket-phone"].args, [
    "${CLAUDE_PLUGIN_ROOT}/runtime/openpocket-phone-server.mjs",
  ]);
  assert.match(skill, /^---\nname: phone-use\n/m);
  assert.match(skill, /target_status/);
});

test("Claude Desktop archive contains a self-contained plugin root", () => {
  const result = spawnSync("unzip", ["-Z1", archivePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entries = new Set(result.stdout.split(/\r?\n/).filter(Boolean));

  for (const required of [
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "skills/phone-use/SKILL.md",
    "runtime/openpocket-phone-server.mjs",
    "runtime/screen-awake-worker.js",
    "runtime/openpocket-ime.apk",
  ]) {
    assert.equal(entries.has(required), true, `missing ${required}`);
  }
});

test("bundled Claude MCP runtime completes initialize and lists 23 tools", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-claude-runtime-"));
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "openpocket-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const result = spawnSync(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home },
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const responses = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const initialized = responses.find((response) => response.id === 1);
  const tools = responses.find((response) => response.id === 2)?.result?.tools;

  assert.equal(initialized.result.serverInfo.name, "openpocket-phone");
  assert.equal(tools.length, 23);
  assert.equal(tools.some((tool) => tool.name === "target_status"), true);
  assert.equal(tools.some((tool) => tool.name === "screenshot"), true);
});
