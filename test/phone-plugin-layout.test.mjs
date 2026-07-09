import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrationRoot = path.join(repoRoot, "plugins", "openpocket-phone");
const codexPluginRoot = path.join(integrationRoot, "codex", "openpocket-phone");
const claudePluginRoot = path.join(integrationRoot, "claude", "openpocket-phone");

test("phone integrations use one root with explicit host bundles", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "plugins", "openpocket-phone-claude")), false);

  const codexMarketplace = JSON.parse(fs.readFileSync(
    path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
    "utf8",
  ));
  const claudeMarketplace = JSON.parse(fs.readFileSync(
    path.join(repoRoot, ".claude-plugin", "marketplace.json"),
    "utf8",
  ));

  assert.equal(
    codexMarketplace.plugins[0].source.path,
    "./plugins/openpocket-phone/codex/openpocket-phone",
  );
  assert.equal(
    claudeMarketplace.plugins[0].source,
    "./plugins/openpocket-phone/claude/openpocket-phone",
  );
});

test("host bundles contain synchronized generated runtime files", () => {
  for (const relativePath of [
    "openpocket-phone-server.mjs",
    "screen-awake-worker.js",
    "openpocket-ime.apk",
  ]) {
    const codexRuntime = fs.readFileSync(path.join(codexPluginRoot, "runtime", relativePath));
    const claudeRuntime = fs.readFileSync(path.join(claudePluginRoot, "runtime", relativePath));
    assert.deepEqual(codexRuntime, claudeRuntime, relativePath);
  }
});
