import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");
const { ensureAndroidPrerequisites } = await import("../dist/environment/android-prerequisites.js");

async function withTempHome(prefix, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env.OPENPOCKET_HOME;
  process.env.OPENPOCKET_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prev;
    }
  }
}

test("ensureAndroidPrerequisites supports skip mode for CI/tests", async () => {
  await withTempHome("openpocket-env-skip-", async () => {
    const prev = process.env.OPENPOCKET_SKIP_ENV_SETUP;
    process.env.OPENPOCKET_SKIP_ENV_SETUP = "1";
    try {
      const cfg = loadConfig();
      cfg.emulator.androidSdkRoot = "";
      const result = await ensureAndroidPrerequisites(cfg, { autoInstall: true });
      assert.equal(result.skipped, true);
      assert.equal(path.isAbsolute(result.sdkRoot), true);
      assert.equal(cfg.emulator.androidSdkRoot.length > 0, true);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENPOCKET_SKIP_ENV_SETUP;
      } else {
        process.env.OPENPOCKET_SKIP_ENV_SETUP = prev;
      }
    }
  });
});

test("strict mode uses only Google Play system image candidates", async () => {
  const { getSystemImageCandidates } = await import("../dist/environment/android-prerequisites.js");
  assert.equal(typeof getSystemImageCandidates, "function");

  const candidates = getSystemImageCandidates();
  assert.equal(candidates.length > 0, true);
  assert.equal(
    candidates.every((pkg) => pkg.includes(";google_apis_playstore;")),
    true,
  );
  const first34 = candidates.findIndex((pkg) => pkg.includes("system-images;android-34;"));
  const first361 = candidates.findIndex((pkg) => pkg.includes("system-images;android-36.1;"));
  assert.equal(first34 >= 0, true);
  assert.equal(first361 >= 0, true);
  assert.equal(first361 < first34, true);
});

test("buildAvdManagerOpts pins avdmanager toolsdir to selected SDK root", async () => {
  const { buildAvdManagerOpts } = await import("../dist/environment/android-prerequisites.js");
  assert.equal(typeof buildAvdManagerOpts, "function");

  const sdkRoot = "/tmp/android-sdk";
  const opts = buildAvdManagerOpts(sdkRoot, "");
  assert.match(opts, /-Dcom\.android\.sdkmanager\.toolsdir=\/tmp\/android-sdk\/cmdline-tools\/latest/);
});

test("buildAvdManagerOpts preserves existing flags and avoids duplicate toolsdir", async () => {
  const { buildAvdManagerOpts } = await import("../dist/environment/android-prerequisites.js");
  const sdkRoot = "/tmp/android-sdk";
  const existing = "-Xmx2048m -Dcom.android.sdkmanager.toolsdir=/already-set";
  const opts = buildAvdManagerOpts(sdkRoot, existing);
  assert.equal(opts, existing);
});

test("shouldRunSdkBootstrap only skips bootstrap when AVD exists and essentials are present", async () => {
  const { shouldRunSdkBootstrap } = await import("../dist/environment/android-prerequisites.js");
  assert.equal(typeof shouldRunSdkBootstrap, "function");

  assert.equal(shouldRunSdkBootstrap(true, 0), false);
  assert.equal(shouldRunSdkBootstrap(true, 1), true);
  assert.equal(shouldRunSdkBootstrap(false, 0), true);
  assert.equal(shouldRunSdkBootstrap(false, 2), true);
});

test("upsertAvdConfigOverrides updates existing keys and appends missing keys", async () => {
  const { upsertAvdConfigOverrides } = await import("../dist/environment/android-prerequisites.js");
  assert.equal(typeof upsertAvdConfigOverrides, "function");

  const source = [
    "disk.dataPartition.size=16G",
    "hw.lcd.height=640",
    "tag.id=google_apis_playstore",
    "",
  ].join("\n");

  const patched = upsertAvdConfigOverrides(source, [
    { key: "disk.dataPartition.size", value: "24G" },
    { key: "hw.lcd.width", value: "1080" },
    { key: "hw.lcd.height", value: "2400" },
    { key: "hw.lcd.density", value: "420" },
  ]);

  assert.match(patched, /^disk\.dataPartition\.size=24G$/m);
  assert.match(patched, /^hw\.lcd\.width=1080$/m);
  assert.match(patched, /^hw\.lcd\.height=2400$/m);
  assert.match(patched, /^hw\.lcd\.density=420$/m);
  assert.match(patched, /^tag\.id=google_apis_playstore$/m);
});

test("upsertAvdConfigOverrides is idempotent for repeated writes", async () => {
  const { upsertAvdConfigOverrides } = await import("../dist/environment/android-prerequisites.js");
  const source = "hw.lcd.width=320\n";
  const once = upsertAvdConfigOverrides(source, [{ key: "hw.lcd.width", value: "1080" }]);
  const twice = upsertAvdConfigOverrides(once, [{ key: "hw.lcd.width", value: "1080" }]);
  const widthLines = twice
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line === "hw.lcd.width=1080");
  assert.equal(widthLines.length, 1);
});
