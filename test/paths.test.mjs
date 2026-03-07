import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  openpocketHome,
  defaultConfigPath,
  defaultWorkspaceDir,
  defaultStateDir,
  managerDir,
  managerRegistryPath,
  managerModelTemplatePath,
  agentsRootDir,
  agentConfigPath,
  agentWorkspaceDir,
  agentStateDir,
  resolvePath,
  nowForFilename,
} = await import("../dist/utils/paths.js");

test("path helpers respect OPENPOCKET_HOME", () => {
  const prev = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = "/tmp/openpocket-custom-home";
  try {
    assert.equal(openpocketHome(), path.resolve("/tmp/openpocket-custom-home"));
    assert.equal(defaultConfigPath(), path.resolve("/tmp/openpocket-custom-home/config.json"));
    assert.equal(defaultWorkspaceDir(), path.resolve("/tmp/openpocket-custom-home/workspace"));
    assert.equal(defaultStateDir(), path.resolve("/tmp/openpocket-custom-home/state"));
    assert.equal(managerDir(), path.resolve("/tmp/openpocket-custom-home/manager"));
    assert.equal(managerRegistryPath(), path.resolve("/tmp/openpocket-custom-home/manager/registry.json"));
    assert.equal(
      managerModelTemplatePath(),
      path.resolve("/tmp/openpocket-custom-home/manager/model-template.json"),
    );
    assert.equal(agentsRootDir(), path.resolve("/tmp/openpocket-custom-home/agents"));
    assert.equal(agentConfigPath("review-bot"), path.resolve("/tmp/openpocket-custom-home/agents/review-bot/config.json"));
    assert.equal(agentWorkspaceDir("review-bot"), path.resolve("/tmp/openpocket-custom-home/agents/review-bot/workspace"));
    assert.equal(agentStateDir("review-bot"), path.resolve("/tmp/openpocket-custom-home/agents/review-bot/state"));
  } finally {
    if (prev === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prev;
    }
  }
});

test("resolvePath handles ~ and nowForFilename has expected format", () => {
  const resolved = resolvePath("~/openpocket-test");
  assert.equal(resolved.startsWith(os.homedir()), true);

  const stamp = nowForFilename();
  assert.match(stamp, /^\d{8}-\d{6}$/);
});
