import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { installCliShortcut } = await import("../dist/install/cli-shortcut.js");

test("installCliShortcut creates launcher and updates shell rc once", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-shortcut-"));
  const fakeCliPath = path.join(home, "dist-cli.js");
  fs.writeFileSync(fakeCliPath, "console.log('ok')\n", "utf-8");

  const zshrc = path.join(home, ".zshrc");
  const bashrc = path.join(home, ".bashrc");

  const first = installCliShortcut({
    homeDir: home,
    cliPath: fakeCliPath,
    shellRcPaths: [zshrc, bashrc],
  });

  assert.equal(fs.existsSync(first.commandPath), true);
  const launcher = fs.readFileSync(first.commandPath, "utf-8");
  assert.match(launcher, /exec node/);
  assert.match(launcher, /dist-cli\.js/);

  const zshBody1 = fs.readFileSync(zshrc, "utf-8");
  const bashBody1 = fs.readFileSync(bashrc, "utf-8");
  assert.match(zshBody1, /OpenPocket CLI/);
  assert.match(bashBody1, /OpenPocket CLI/);
  assert.equal(first.shellRcUpdated.length, 2);
  assert.equal(first.preferredPathCommandPath, null);

  const second = installCliShortcut({
    homeDir: home,
    cliPath: fakeCliPath,
    shellRcPaths: [zshrc, bashrc],
  });
  const zshBody2 = fs.readFileSync(zshrc, "utf-8");
  const bashBody2 = fs.readFileSync(bashrc, "utf-8");
  assert.equal(
    zshBody2.match(/OpenPocket CLI/g)?.length ?? 0,
    1,
    "zshrc should not duplicate PATH entry",
  );
  assert.equal(
    bashBody2.match(/OpenPocket CLI/g)?.length ?? 0,
    1,
    "bashrc should not duplicate PATH entry",
  );
  assert.equal(second.shellRcUpdated.length, 0);
  assert.equal(second.preferredPathCommandPath, null);
});
