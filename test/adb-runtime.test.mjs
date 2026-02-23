import assert from "node:assert/strict";
import test from "node:test";

const { AdbRuntime } = await import("../dist/device/adb-runtime.js");

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
    this.failAdbKeyboardBroadcast = Boolean(options.failAdbKeyboardBroadcast);
    this.availableImes = Array.isArray(options.availableImes)
      ? options.availableImes
      : ["com.android.adbkeyboard/.AdbIME", "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME"];
    this.currentIme = options.defaultIme ?? "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME";
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
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "ime" &&
      args[4] === "list" &&
      args[5] === "-s"
    ) {
      return this.availableImes.join("\n");
    }
    if (
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "settings" &&
      args[4] === "get" &&
      args[5] === "secure" &&
      args[6] === "default_input_method"
    ) {
      return `${this.currentIme}\n`;
    }
    if (
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "ime" &&
      args[4] === "enable"
    ) {
      return this.availableImes.includes(args[5]) ? "" : `Error: Unknown id: ${args[5]}`;
    }
    if (
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "ime" &&
      args[4] === "set"
    ) {
      if (!this.availableImes.includes(args[5])) {
        throw new Error(`Unknown id: ${args[5]}`);
      }
      this.currentIme = String(args[5]);
      return "";
    }
    if (
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "am" &&
      args[4] === "broadcast" &&
      args[6] === "ADB_INPUT_B64"
    ) {
      if (this.failAdbKeyboardBroadcast) {
        return "Broadcast failed: no receivers";
      }
      return "Broadcast completed: result=0";
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

test("AdbRuntime uses unverified clipboard paste when clipboard read is unavailable", async () => {
  const emulator = new FakeEmulator({ failClipboardRead: true });
  const runtime = new AdbRuntime(makeConfig(), emulator);

  const result = await runtime.executeAction({ type: "type", text: "旧金山 天气" });
  assert.match(result, /clipboard paste \(unverified\)/i);
  assert.equal(
    emulator.calls.some((args) => args.includes("KEYCODE_PASTE")),
    true,
  );
  assert.equal(
    emulator.calls.some(
      (args) => args[0] === "-s" && args[2] === "shell" && args[3] === "input" && args[4] === "text",
    ),
    false,
  );
});

test("AdbRuntime falls back to adb keyboard for non-ASCII when clipboard command is unavailable", async () => {
  const emulator = new FakeEmulator({ failClipboardSet: true });
  const runtime = new AdbRuntime(makeConfig(), emulator);

  const result = await runtime.executeAction({ type: "type", text: "旧金山 天气" });
  assert.match(result, /adb keyboard/i);
  assert.equal(
    emulator.calls.some((args) => args.includes("ADB_INPUT_B64")),
    true,
  );
  assert.equal(
    emulator.calls.some(
      (args) => args[0] === "-s" && args[2] === "shell" && args[3] === "input" && args[4] === "text",
    ),
    false,
  );
});

test("AdbRuntime fails clearly when non-ASCII input methods are unavailable", async () => {
  const emulator = new FakeEmulator({ failClipboardSet: true, availableImes: [] });
  const runtime = new AdbRuntime(makeConfig(), emulator);

  await assert.rejects(
    runtime.executeAction({ type: "type", text: "旧金山 天气" }),
    /Non-ASCII text input failed/,
  );
});
