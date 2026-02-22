import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AdbRuntime } = require("../dist/device/adb-runtime.js");

function makeConfig() {
  return {
    agent: {
      deviceId: null,
    },
  };
}

class FakeEmulator {
  constructor(options = {}) {
    this.calls = [];
    this.failInputTextOnce = Boolean(options.failInputTextOnce);
    this.failClipboardRead = Boolean(options.failClipboardRead);
    this.failClipboardSet = Boolean(options.failClipboardSet);
    this.clipboardText = "";
  }

  status() {
    return {
      avdName: "Pixel",
      devices: ["emulator-5554"],
      bootedDevices: ["emulator-5554"],
    };
  }

  runAdb(args) {
    this.calls.push(args);

    if (
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "cmd" &&
      args[4] === "clipboard" &&
      args[5] === "set" &&
      args[6] === "text"
    ) {
      if (this.failClipboardSet) {
        return "Error: clipboard set unsupported";
      }
      this.clipboardText = String(args[7] ?? "");
      return "";
    }
    if (
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "cmd" &&
      args[4] === "clipboard" &&
      args[5] === "get" &&
      args[6] === "text"
    ) {
      if (this.failClipboardRead) {
        return "Error: clipboard get unsupported";
      }
      return this.clipboardText;
    }
    if (
      this.failInputTextOnce &&
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "input" &&
      args[4] === "text"
    ) {
      this.failInputTextOnce = false;
      throw new Error("input text failed");
    }
    return "";
  }
}

test("AdbRuntime uses clipboard paste for non-ASCII typing", async () => {
  const emulator = new FakeEmulator();
  const runtime = new AdbRuntime(makeConfig(), emulator);

  const result = await runtime.executeAction({ type: "type", text: "san\u00a0francisco weather" });
  assert.match(result, /clipboard paste/i);
  assert.equal(
    emulator.calls.some(
      (args) => args[0] === "-s" && args[2] === "shell" && args[3] === "input" && args[4] === "text",
    ),
    false,
  );
  assert.equal(emulator.calls.some((args) => args.includes("clipboard")), true);
  assert.equal(emulator.calls.some((args) => args.includes("KEYCODE_PASTE")), true);
});

test("AdbRuntime falls back to clipboard when input text fails", async () => {
  const emulator = new FakeEmulator({ failInputTextOnce: true });
  const runtime = new AdbRuntime(makeConfig(), emulator);

  const result = await runtime.executeAction({ type: "type", text: "san francisco weather" });
  assert.match(result, /clipboard paste/i);
  assert.equal(emulator.calls.some((args) => args.includes("clipboard")), true);
  assert.equal(emulator.calls.some((args) => args.includes("KEYCODE_PASTE")), true);
});

test("AdbRuntime avoids stale clipboard paste when clipboard cannot be verified", async () => {
  const emulator = new FakeEmulator({ failClipboardRead: true });
  const runtime = new AdbRuntime(makeConfig(), emulator);

  const result = await runtime.executeAction({ type: "type", text: "旧金山 天气" });
  assert.match(result, /Typed text length=6/);
  assert.equal(
    emulator.calls.some((args) => args.includes("KEYCODE_PASTE")),
    false,
  );
  assert.equal(
    emulator.calls.some(
      (args) => args[0] === "-s" && args[2] === "shell" && args[3] === "input" && args[4] === "text",
    ),
    true,
  );
});
