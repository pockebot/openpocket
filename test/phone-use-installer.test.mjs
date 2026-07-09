import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  claudeBinaryCandidates,
  parseInstallArgs,
  parseMarketplaceList,
  removeLegacyClaudeMcpConfig,
} from "../plugins/openpocket-phone/scripts/install.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = path.join(
  repoRoot,
  "plugins",
  "openpocket-phone",
  "scripts",
  "install.mjs",
);

test("phone-use installer normalizes client aliases and target options", () => {
  assert.deepEqual(parseInstallArgs(["codex-desktop"]), {
    help: false,
    client: "codex",
    target: null,
    device: null,
    startEmulator: false,
    skipDeps: false,
    skipBuild: false,
    dryRun: false,
  });

  const claude = parseInstallArgs([
    "claude",
    "--device",
    "device-123",
    "--skip-build",
  ]);
  assert.equal(claude.client, "claude-code");
  assert.equal(claude.target, "physical-phone");
  assert.equal(claude.device, "device-123");
  assert.equal(claude.skipBuild, true);
});

test("phone-use installer rejects incompatible target options", () => {
  assert.throws(
    () => parseInstallArgs(["codex", "--target", "cloud", "--device", "abc"]),
    /--device can only be used/i,
  );
  assert.throws(
    () => parseInstallArgs(["claude-code", "--target", "physical-phone", "--start-emulator"]),
    /--start-emulator cannot be used/i,
  );
  assert.throws(
    () => parseInstallArgs(["codex", "--target", "ios"]),
    /Unknown target: ios/i,
  );
});

test("Claude MCP migration preserves unrelated settings and creates a backup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-phone-installer-"));
  const configPath = path.join(home, ".claude.json");
  const original = {
    keep: true,
    mcpServers: {
      existing: {
        type: "stdio",
        command: "existing-server",
        args: [],
      },
      "openpocket-phone": {
        type: "stdio",
        command: "/usr/local/bin/node",
        args: ["/repo/dist/mcp/server.js"],
      },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const result = removeLegacyClaudeMcpConfig({
    configPath,
  });
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const backup = JSON.parse(fs.readFileSync(result.backupPath, "utf8"));

  assert.equal(result.changed, true);
  assert.equal(config.keep, true);
  assert.equal(config.mcpServers["openpocket-phone"], undefined);
  assert.deepEqual(config.mcpServers.existing, original.mcpServers.existing);
  assert.deepEqual(backup, original);

  const second = removeLegacyClaudeMcpConfig({
    configPath,
  });
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, null);
});

test("Claude binary discovery includes an explicit executable", () => {
  const previous = process.env.OPENPOCKET_CLAUDE_BIN;
  process.env.OPENPOCKET_CLAUDE_BIN = process.execPath;
  try {
    assert.equal(claudeBinaryCandidates()[0], process.execPath);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENPOCKET_CLAUDE_BIN;
    } else {
      process.env.OPENPOCKET_CLAUDE_BIN = previous;
    }
  }
});

test("marketplace list parser supports roots with spaces", () => {
  const rows = parseMarketplaceList(`MARKETPLACE       ROOT
openai-bundled   /tmp/openai bundled
openpocket-local /Users/test/OpenPocket
`);
  assert.deepEqual(rows, [
    { name: "openai-bundled", root: "/tmp/openai bundled" },
  ]);
});

test("installer dry run explains the one-command Codex flow", () => {
  const result = spawnSync(process.execPath, [installerPath, "codex", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Client: Codex CLI \+ Desktop/);
  assert.match(result.stdout, /openpocket-phone@openpocket-local installed/);
  assert.match(result.stdout, /23 tools ready/);
  assert.match(result.stdout, /Restart the client and start a new task/);
});

test("installer dry run explains the native Claude Code plugin flow", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-phone-claude-dry-"));
  const result = spawnSync(
    process.execPath,
    [installerPath, "claude-code", "--dry-run"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Client: Claude Code CLI \+ Desktop/);
  assert.match(result.stdout, /openpocket-phone@openpocket-local installed/);
  assert.match(result.stdout, /plugin marketplace add/);
  assert.match(result.stdout, /plugin install/);
  assert.match(result.stdout, /23 tools ready/);
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false);
});
