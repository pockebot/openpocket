import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function runCli(args, env = {}) {
  return spawnSync("node", [cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENPOCKET_SKIP_ENV_SETUP: "1",
      OPENPOCKET_SKIP_GATEWAY_PID_CHECK: "1",
      ...env,
    },
    encoding: "utf-8",
  });
}

function makeHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("skills validate --strict reports invalid skills and exits non-zero", () => {
  const home = makeHome("openpocket-cli-skills-validate-");
  const init = runCli(["init"], { OPENPOCKET_HOME: home });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const invalidSkillPath = path.join(home, "workspace", "skills", "bad-legacy.md");
  fs.mkdirSync(path.dirname(invalidSkillPath), { recursive: true });
  fs.writeFileSync(invalidSkillPath, "# legacy bad skill without frontmatter\n", "utf-8");

  const run = runCli(["skills", "validate", "--strict"], { OPENPOCKET_HOME: home });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Skill Validation \(strict\)/);
  assert.match(run.stdout, /Validation summary: valid=\d+ invalid=\d+ total=\d+/);
});
