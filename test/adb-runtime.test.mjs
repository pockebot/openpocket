import assert from "node:assert/strict";
import test from "node:test";

const { AdbRuntime, extractPackageName } = await import("../dist/device/adb-runtime.js");

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
    this.powerDumps = Array.isArray(options.powerDumps) ? [...options.powerDumps] : [];
    this.policyDumps = Array.isArray(options.policyDumps) ? [...options.policyDumps] : [];
  }

  status() {
    return {
      avdName: "Pixel",
      devices: ["emulator-5554"],
      bootedDevices: ["emulator-5554"],
    };
  }

  adbBinary() {
    return "adb";
  }

  runAdb(args) {
    this.calls.push(args);

    if (
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "dumpsys" &&
      args[4] === "power"
    ) {
      return this.powerDumps.length > 0 ? this.powerDumps.shift() : "mInteractive=true";
    }
    if (
      args[0] === "-s" &&
      args[2] === "shell" &&
      args[3] === "dumpsys" &&
      args[4] === "window" &&
      args[5] === "policy"
    ) {
      return this.policyDumps.length > 0
        ? this.policyDumps.shift()
        : "isStatusBarKeyguard=false\nmShowingLockscreen=false";
    }

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
    /Text input failed/,
  );
});

test("AdbRuntime uses escaped adb input for passwords with special characters", async () => {
  const emulator = new FakeEmulator();
  const runtime = new AdbRuntime(makeConfig(), emulator);

  const result = await runtime.executeAction({ type: "type", text: "P@ssw0rd!#$" });
  assert.match(result, /Typed text length=11/i);
  const inputCall = emulator.calls.find(
    (args) => args[0] === "-s" && args[2] === "shell" && args[3] === "input" && args[4] === "text",
  );
  assert.equal(Boolean(inputCall), true);
  assert.equal(inputCall[5], "P\\@ssw0rd\\!\\#\\$");
  assert.equal(
    emulator.calls.some((args) => args.includes("clipboard") || args.includes("KEYCODE_PASTE") || args.includes("ADB_INPUT_B64")),
    false,
  );
});

test("AdbRuntime executes drag with swipe gesture", async () => {
  const emulator = new FakeEmulator();
  const runtime = new AdbRuntime(makeConfig(), emulator);

  const result = await runtime.executeAction({
    type: "drag",
    x1: 120,
    y1: 640,
    x2: 680,
    y2: 980,
    durationMs: 420,
  });
  assert.match(result, /Dragged from/);
  assert.equal(
    emulator.calls.some(
      (args) =>
        args[0] === "-s"
        && args[2] === "shell"
        && args[3] === "input"
        && args[4] === "swipe"
        && args[5] === "120"
        && args[6] === "640"
        && args[7] === "680"
        && args[8] === "980"
        && args[9] === "420",
    ),
    true,
  );
});

test("AdbRuntime executes long_press_drag with combined hold and move duration", async () => {
  const emulator = new FakeEmulator();
  const runtime = new AdbRuntime(makeConfig(), emulator);

  const result = await runtime.executeAction({
    type: "long_press_drag",
    x1: 300,
    y1: 900,
    x2: 700,
    y2: 900,
    holdMs: 700,
    durationMs: 260,
  });
  assert.match(result, /Long-press drag/);
  assert.match(result, /hold=700ms/);
  assert.match(result, /move=260ms/);
  assert.equal(
    emulator.calls.some(
      (args) =>
        args[0] === "-s"
        && args[2] === "shell"
        && args[3] === "input"
        && args[4] === "swipe"
        && args[5] === "300"
        && args[6] === "900"
        && args[7] === "700"
        && args[8] === "900"
        && args[9] === "960",
    ),
    true,
  );
});

test("AdbRuntime wakes and dismisses keyguard before interactive action on physical phone", async () => {
  const emulator = new FakeEmulator({
    powerDumps: ["mInteractive=false"],
    policyDumps: [
      "KeyguardServiceDelegate: showing=true",
      "KeyguardServiceDelegate: showing=false",
    ],
  });
  const runtime = new AdbRuntime(
    {
      agent: { deviceId: null },
      target: { type: "physical-phone", pin: "1234" },
    },
    emulator,
  );

  const result = await runtime.executeAction({ type: "keyevent", keycode: "KEYCODE_HOME" });
  assert.match(result, /Sent keyevent KEYCODE_HOME/i);
  assert.equal(
    emulator.calls.some(
      (args) => args[0] === "-s" && args[2] === "shell" && args[3] === "input" && args[4] === "keyevent" && args[5] === "KEYCODE_WAKEUP",
    ),
    true,
  );
  assert.equal(
    emulator.calls.some((args) => args[0] === "-s" && args[2] === "shell" && args[3] === "wm" && args[4] === "dismiss-keyguard"),
    true,
  );
});

test("AdbRuntime inputs default PIN when device remains locked after dismiss attempt", async () => {
  const emulator = new FakeEmulator({
    powerDumps: ["mInteractive=true"],
    policyDumps: [
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=false",
    ],
  });
  const runtime = new AdbRuntime(
    {
      agent: { deviceId: null },
      target: { type: "physical-phone", pin: "1234" },
    },
    emulator,
  );

  const result = await runtime.executeAction({ type: "tap", x: 100, y: 220 });
  assert.match(result, /Tapped at/i);
  assert.equal(
    emulator.calls.some(
      (args) =>
        args[0] === "-s"
        && args[2] === "shell"
        && args[3] === "input"
        && args[4] === "swipe",
    ),
    true,
  );
  for (const keycode of ["8", "9", "10", "11", "66"]) {
    assert.equal(
      emulator.calls.some(
        (args) =>
          args[0] === "-s"
          && args[2] === "shell"
          && args[3] === "input"
          && args[4] === "keyevent"
          && args[5] === keycode,
      ),
      true,
      `missing keyevent ${keycode}`,
    );
  }
});

test("AdbRuntime fails clearly when physical phone stays locked after unlock attempts", async () => {
  const emulator = new FakeEmulator({
    powerDumps: ["mInteractive=true"],
    policyDumps: [
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
    ],
  });
  const runtime = new AdbRuntime(
    {
      agent: { deviceId: null },
      target: { type: "physical-phone", pin: "1234" },
    },
    emulator,
  );

  await assert.rejects(
    runtime.executeAction({ type: "tap", x: 120, y: 300 }),
    /is locked/i,
  );
  assert.equal(
    emulator.calls.some(
      (args) => args[0] === "-s" && args[2] === "shell" && args[3] === "input" && args[4] === "keyevent" && args[5] === "KEYCODE_MENU",
    ),
    false,
  );
});

test("AdbRuntime avoids KEYCODE_MENU fallback when lock state is unknown after PIN unlock", async () => {
  const emulator = new FakeEmulator({
    powerDumps: ["mInteractive=true"],
    policyDumps: [
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "unable to resolve keyguard state",
    ],
  });
  const runtime = new AdbRuntime(
    {
      agent: { deviceId: null },
      target: { type: "physical-phone", pin: "1234" },
    },
    emulator,
  );

  const result = await runtime.executeAction({ type: "tap", x: 140, y: 320 });
  assert.match(result, /Tapped at/i);
  assert.equal(
    emulator.calls.some(
      (args) => args[0] === "-s" && args[2] === "shell" && args[3] === "input" && args[4] === "keyevent" && args[5] === "KEYCODE_MENU",
    ),
    false,
  );
});

test("AdbRuntime retries PIN unlock once when first attempt still reports locked", async () => {
  const emulator = new FakeEmulator({
    powerDumps: ["mInteractive=true"],
    policyDumps: [
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=false",
    ],
  });
  const runtime = new AdbRuntime(
    {
      agent: { deviceId: null },
      target: { type: "physical-phone", pin: "1234" },
    },
    emulator,
  );

  const result = await runtime.executeAction({ type: "tap", x: 160, y: 360 });
  assert.match(result, /Tapped at/i);
  const digitOneCount = emulator.calls.filter(
    (args) =>
      args[0] === "-s"
      && args[2] === "shell"
      && args[3] === "input"
      && args[4] === "keyevent"
      && args[5] === "8",
  ).length;
  assert.equal(digitOneCount, 2);
});

test("AdbRuntime avoids second PIN entry when lock clears after settle delay", async () => {
  const emulator = new FakeEmulator({
    powerDumps: ["mInteractive=true"],
    policyDumps: [
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=false",
    ],
  });
  const runtime = new AdbRuntime(
    {
      agent: { deviceId: null },
      target: { type: "physical-phone", pin: "1234" },
    },
    emulator,
  );

  const result = await runtime.executeAction({ type: "tap", x: 180, y: 420 });
  assert.match(result, /Tapped at/i);
  const digitOneCount = emulator.calls.filter(
    (args) =>
      args[0] === "-s"
      && args[2] === "shell"
      && args[3] === "input"
      && args[4] === "keyevent"
      && args[5] === "8",
  ).length;
  assert.equal(digitOneCount, 1);
});

test("AdbRuntime falls back to default PIN when physical PIN is empty", async () => {
  const emulator = new FakeEmulator({
    powerDumps: ["mInteractive=true"],
    policyDumps: [
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=true",
      "isStatusBarKeyguard=false",
    ],
  });
  const runtime = new AdbRuntime(
    {
      agent: { deviceId: null },
      target: { type: "physical-phone", pin: "" },
    },
    emulator,
  );

  const result = await runtime.executeAction({ type: "tap", x: 90, y: 180 });
  assert.match(result, /Tapped at/i);
  for (const keycode of ["8", "9", "10", "11", "66"]) {
    assert.equal(
      emulator.calls.some(
        (args) =>
          args[0] === "-s"
          && args[2] === "shell"
          && args[3] === "input"
          && args[4] === "keyevent"
          && args[5] === keycode,
      ),
      true,
      `missing keyevent ${keycode}`,
    );
  }
});

test("AdbRuntime screen-awake heartbeat manages worker lifecycle independently", () => {
  const emulator = new FakeEmulator();
  const starts = [];
  const stops = [];
  const runtime = new AdbRuntime(makeConfig(), emulator, {
    createScreenAwakeWorker: (params) => {
      starts.push(params);
      let stopped = false;
      return {
        stop: () => {
          if (!stopped) {
            stopped = true;
            stops.push(params);
          }
        },
      };
    },
  });

  runtime.startScreenAwakeHeartbeat("emulator-5554", 3000);
  runtime.startScreenAwakeHeartbeat("emulator-5554", 3000);
  runtime.startScreenAwakeHeartbeat("emulator-5554", 5000);
  runtime.stopScreenAwakeHeartbeat();
  runtime.stopScreenAwakeHeartbeat();

  assert.equal(starts.length, 2);
  assert.equal(stops.length, 2);
  assert.deepEqual(starts[0], {
    adbPath: "adb",
    preferredDeviceId: "emulator-5554",
    adbEndpoint: null,
    targetType: "emulator",
    intervalMs: 3000,
  });
  assert.equal(starts[1].intervalMs, 5000);
});

test("AdbRuntime screen-awake heartbeat worker normalizes physical target params", () => {
  const emulator = new FakeEmulator();
  const starts = [];
  const stops = [];
  const runtime = new AdbRuntime(
    {
      agent: { deviceId: "USB-DEVICE-1" },
      target: { type: "physical-phone", adbEndpoint: "192.168.0.15" },
    },
    emulator,
    {
      createScreenAwakeWorker: (params) => {
        starts.push(params);
        let stopped = false;
        return {
          stop: () => {
            if (!stopped) {
              stopped = true;
              stops.push(params);
            }
          },
        };
      },
    },
  );

  runtime.startScreenAwakeHeartbeat(undefined, 200);
  runtime.stopScreenAwakeHeartbeat();

  assert.equal(starts.length, 1);
  assert.equal(stops.length, 1);
  assert.deepEqual(starts[0], {
    adbPath: "adb",
    preferredDeviceId: "USB-DEVICE-1",
    adbEndpoint: "192.168.0.15:5555",
    targetType: "physical-phone",
    intervalMs: 1000,
  });
});

test("extractPackageName parses top resumed activity from activity dump", () => {
  const dump = "topResumedActivity=ActivityRecord{157928692 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t6}";
  assert.equal(extractPackageName(dump), "com.google.android.apps.nexuslauncher");
});

test("extractPackageName parses ACTIVITY fallback line", () => {
  const dump = "ACTIVITY com.twitter.android/.StartActivity 8cae290 pid=27347 userId=0";
  assert.equal(extractPackageName(dump), "com.twitter.android");
});

test("AdbRuntime shell supports explicit sh -lc wrapping via useShellWrap", async () => {
  const emulator = new FakeEmulator();
  const runtime = new AdbRuntime(makeConfig(), emulator);

  await runtime.executeAction({
    type: "shell",
    command: "mkdir -p /sdcard/smoke && echo ok > /sdcard/smoke/main.txt",
    useShellWrap: true,
  });

  assert.equal(emulator.calls.length, 1);
  assert.deepEqual(
    emulator.calls[0].slice(0, 5),
    ["-s", "emulator-5554", "shell", "sh", "-lc"],
  );
  assert.equal(
    emulator.calls[0][5],
    "mkdir -p /sdcard/smoke && echo ok > /sdcard/smoke/main.txt",
  );
});

test("AdbRuntime shell preserves wrapped command and quoted arguments", async () => {
  const emulator = new FakeEmulator();
  const runtime = new AdbRuntime(makeConfig(), emulator);

  await runtime.executeAction({
    type: "shell",
    command: "sh -lc 'echo first && echo second'",
  });
  await runtime.executeAction({
    type: "shell",
    command: "settings put global device_name \"Pixel 9 Pro\"",
  });

  assert.deepEqual(
    emulator.calls[0].slice(0, 5),
    ["-s", "emulator-5554", "shell", "sh", "-lc"],
  );
  assert.equal(emulator.calls[0][5], "echo first && echo second");
  assert.deepEqual(
    emulator.calls[1],
    ["-s", "emulator-5554", "shell", "settings", "put", "global", "device_name", "Pixel 9 Pro"],
  );
});
