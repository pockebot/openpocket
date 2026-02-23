import assert from "node:assert/strict";
import test from "node:test";

const { buildEmulatorStartArgs } = await import("../dist/device/emulator-manager.js");

test("buildEmulatorStartArgs injects default skin and dpi", () => {
  const args = buildEmulatorStartArgs({
    avdName: "OpenPocket_AVD",
    headless: false,
    extraArgs: [],
  });

  assert.deepEqual(args, [
    "-avd",
    "OpenPocket_AVD",
    "-gpu",
    "auto",
    "-skin",
    "1080x2400",
    "-dpi-device",
    "420",
  ]);
});

test("buildEmulatorStartArgs appends no-window in headless mode", () => {
  const args = buildEmulatorStartArgs({
    avdName: "OpenPocket_AVD",
    headless: true,
    extraArgs: [],
  });

  assert.deepEqual(args, [
    "-avd",
    "OpenPocket_AVD",
    "-gpu",
    "auto",
    "-skin",
    "1080x2400",
    "-dpi-device",
    "420",
    "-no-window",
  ]);
});

test("buildEmulatorStartArgs respects custom skin and dpi from extra args", () => {
  const args = buildEmulatorStartArgs({
    avdName: "OpenPocket_AVD",
    headless: false,
    extraArgs: ["-skin", "720x1280", "-dpi-device", "320", "-accel", "off"],
  });

  assert.equal(args.includes("1080x2400"), false);
  assert.equal(args.includes("420"), false);
  assert.deepEqual(args, [
    "-avd",
    "OpenPocket_AVD",
    "-gpu",
    "auto",
    "-skin",
    "720x1280",
    "-dpi-device",
    "320",
    "-accel",
    "off",
  ]);
});
