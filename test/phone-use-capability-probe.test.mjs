import test from "node:test";
import assert from "node:assert/strict";

import {
  PhoneUseCapabilityProbe,
  parseActivityLogCapabilitySignals,
  parseAppOpsCapabilitySignals,
  parseCameraDumpsysCapabilitySignals,
  parseAgoDurationMs,
} from "../dist/phone-use-util/index.js";

test("parseAgoDurationMs supports mixed units", () => {
  const ms = parseAgoDurationMs("+1h2m3s400ms ago");
  assert.equal(ms, 3723400);
});

test("parseAppOpsCapabilitySignals detects recent active and requested signals", () => {
  const output = [
    "CAMERA: allow; time=+4s200ms ago",
    "RECORD_AUDIO: ignore; rejectTime=+2s100ms ago",
    "ACCESS_FINE_LOCATION: allow; time=+2m0s ago",
  ].join("\n");

  const signals = parseAppOpsCapabilitySignals(output, {
    packageName: "com.slack",
    observedAt: "2026-02-26T00:00:00.000Z",
    recentWindowMs: 15_000,
  });

  assert.equal(signals.length, 2);
  assert.deepEqual(
    signals.map((item) => [item.capability, item.phase]),
    [
      ["camera", "active"],
      ["microphone", "requested"],
    ],
  );
});

test("parseCameraDumpsysCapabilitySignals detects active client package", () => {
  const output = [
    "Active Camera Clients:",
    "[ClientDescriptor{com.instagram.android}]",
  ].join("\n");
  const signals = parseCameraDumpsysCapabilitySignals(output, {
    foregroundPackage: "com.instagram.android",
    observedAt: "2026-02-26T00:00:00.000Z",
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].capability, "camera");
  assert.equal(signals[0].phase, "active");
  assert.equal(signals[0].packageName, "com.instagram.android");
});

test("parseCameraDumpsysCapabilitySignals supports mixed-case package names", () => {
  const output = [
    "Active Camera Clients:",
    "[ClientDescriptor{com.google.android.GoogleCamera}]",
  ].join("\n");
  const signals = parseCameraDumpsysCapabilitySignals(output, {
    foregroundPackage: "com.google.android.GoogleCamera",
    observedAt: "2026-02-26T00:00:00.000Z",
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].capability, "camera");
  assert.equal(signals[0].phase, "active");
  assert.equal(signals[0].packageName, "com.google.android.GoogleCamera");
});

test("parseActivityLogCapabilitySignals detects cross-app photo intent", () => {
  const output = [
    "1772081818.193  1615  4360 I ActivityTaskManager: START u0 {act=android.intent.action.GET_CONTENT typ=image/* cmp=com.android.documentsui/.picker.PickActivity} with LAUNCH_MULTIPLE from uid 10321 (com.Slack) result code=0",
  ].join("\n");
  const signals = parseActivityLogCapabilitySignals(output, {
    fallbackPackage: "com.Slack",
    observedAt: "2026-02-26T00:00:00.000Z",
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].capability, "photos");
  assert.equal(signals[0].phase, "requested");
  assert.equal(signals[0].packageName, "com.Slack");
});

test("PhoneUseCapabilityProbe dedupes repeated capability events", () => {
  let nowMs = 1_000_000;
  const probe = new PhoneUseCapabilityProbe({
    adbRunner: {
      run: (_deviceId, args) => {
        const joined = args.join(" ");
        if (joined.includes("cmd appops")) {
          return "CAMERA: allow; time=+1s0ms ago";
        }
        if (joined.includes("dumpsys media.camera")) {
          return "Active Camera Clients:\n[]";
        }
        if (joined.includes("logcat")) {
          return "";
        }
        return "";
      },
    },
    nowMs: () => nowMs,
    nowIso: () => "2026-02-26T00:00:00.000Z",
    minPollIntervalMs: 300,
    dedupeWindowMs: 10_000,
  });

  const first = probe.poll({
    deviceId: "emulator-5554",
    foregroundPackage: "com.slack",
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].capability, "camera");

  nowMs += 500;
  const second = probe.poll({
    deviceId: "emulator-5554",
    foregroundPackage: "com.slack",
  });
  assert.equal(second.length, 0);

  nowMs += 11_000;
  const third = probe.poll({
    deviceId: "emulator-5554",
    foregroundPackage: "com.slack",
  });
  assert.equal(third.length, 1);
  assert.equal(third[0].capability, "camera");
});

test("PhoneUseCapabilityProbe poll accepts mixed-case foreground package names", () => {
  const probe = new PhoneUseCapabilityProbe({
    adbRunner: {
      run: (_deviceId, args) => {
        const joined = args.join(" ");
        if (joined.includes("cmd appops")) {
          assert.match(joined, /com\.Slack/);
          return "CAMERA: allow; time=+1s0ms ago";
        }
        if (joined.includes("dumpsys media.camera")) {
          return "Active Camera Clients:\n[]";
        }
        if (joined.includes("logcat")) {
          return "";
        }
        return "";
      },
    },
    nowMs: () => 1_000_000,
    nowIso: () => "2026-02-26T00:00:00.000Z",
    minPollIntervalMs: 300,
  });

  const events = probe.poll({
    deviceId: "emulator-5554",
    foregroundPackage: "com.Slack",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].capability, "camera");
  assert.equal(events[0].packageName, "com.Slack");
});
