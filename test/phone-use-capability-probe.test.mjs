import test from "node:test";
import assert from "node:assert/strict";

import {
  PhoneUseCapabilityProbe,
  buildPaymentArtifactKey,
  inferPaymentFieldSemantic,
  parsePaymentArtifactKey,
  parsePaymentUiTreeFieldCandidates,
  parseActivityLogCapabilitySignals,
  parseAppOpsCapabilitySignals,
  parseCameraDumpsysCapabilitySignals,
  parseWindowSecurePaymentSignal,
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

test("parseWindowSecurePaymentSignal detects secure payment surface from focused package", () => {
  const dumpsys = [
    "mCurrentFocus=Window{ab12cd3 u0 com.shop.app/.CheckoutActivity}",
    "Window #9 Window{ab12cd3 u0 com.shop.app/.CheckoutActivity}:",
    "  mAttrs={(0,0)(fillxfill) sim=#20 ty=APPLICATION fl=FLAG_SECURE HARDWARE_ACCELERATED}",
    "  secure=true",
  ].join("\n");
  const signal = parseWindowSecurePaymentSignal(dumpsys, {
    foregroundPackage: "com.shop.app",
    candidatePackages: ["com.shop.app"],
    observedAt: "2026-02-26T00:00:00.000Z",
  });
  assert.equal(Boolean(signal), true);
  assert.equal(signal.packageName, "com.shop.app");
  assert.match(signal.evidence, /FLAG_SECURE/i);
});

test("parsePaymentUiTreeFieldCandidates extracts semantic payment fields", () => {
  const xml = [
    "<hierarchy>",
    '<node index="0" text="Card number" resource-id="com.shop:id/card_number" class="android.widget.EditText" package="com.shop" content-desc="" clickable="true" enabled="true" focusable="true" password="false" bounds="[60,320][1020,430]" />',
    '<node index="1" text="Expiration date, 2 digit month, 2 digit year" resource-id="com.shop:id/expiry" class="android.widget.EditText" package="com.shop" content-desc="" clickable="true" enabled="true" focusable="true" password="false" bounds="[60,440][520,550]" />',
    '<node index="2" text="Security code" resource-id="com.shop:id/cvc" class="android.widget.EditText" package="com.shop" content-desc="" clickable="true" enabled="true" focusable="true" password="true" bounds="[560,440][1020,550]" />',
    '<node index="3" text="Billing ZIP" resource-id="com.shop:id/postal_code" class="android.widget.EditText" package="com.shop" content-desc="" clickable="true" enabled="true" focusable="true" password="false" bounds="[60,560][520,670]" />',
    "</hierarchy>",
  ].join("");
  const fields = parsePaymentUiTreeFieldCandidates(xml);
  assert.equal(fields.some((field) => field.semantic === "card_number"), true);
  assert.equal(fields.some((field) => field.semantic === "expiry"), true);
  assert.equal(fields.some((field) => field.semantic === "cvc"), true);
  assert.equal(fields.some((field) => field.semantic === "postal_code"), true);
  const cardField = fields.find((field) => field.semantic === "card_number");
  assert.equal(cardField.required, true);
  assert.equal(cardField.inputType, "card-number");
});

test("payment artifact key helpers round-trip semantic/resource hints", () => {
  const key = buildPaymentArtifactKey("billing_email", "billing_email", 2);
  const parsed = parsePaymentArtifactKey(key);
  assert.equal(Boolean(parsed), true);
  assert.equal(parsed.semantic, "billing_email");
  assert.equal(parsed.resourceIdHint, "billing_email");
  assert.equal(parsed.index, 2);
});

test("inferPaymentFieldSemantic identifies billing email hints", () => {
  const inferred = inferPaymentFieldSemantic({
    label: "Email",
    hint: "Billing email address",
    resourceId: "com.shop:id/billing_email",
    contentDesc: "",
    className: "android.widget.EditText",
  });
  assert.equal(inferred.semantic, "billing_email");
  assert.equal(inferred.confidence > 0.6, true);
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

test("PhoneUseCapabilityProbe poll checks candidate package when foreground switches to permission controller", () => {
  const probe = new PhoneUseCapabilityProbe({
    adbRunner: {
      run: (_deviceId, args) => {
        const joined = args.join(" ");
        if (joined.includes("cmd appops") && joined.includes("com.google.android.permissioncontroller")) {
          return "";
        }
        if (joined.includes("cmd appops") && joined.includes("com.Slack")) {
          return "CAMERA: ignore; rejectTime=+1s0ms ago";
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
    nowMs: () => 2_000_000,
    nowIso: () => "2026-02-26T00:00:00.000Z",
    minPollIntervalMs: 300,
  });

  const events = probe.poll({
    deviceId: "emulator-5554",
    foregroundPackage: "com.google.android.permissioncontroller",
    candidatePackages: ["com.Slack"],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].capability, "camera");
  assert.equal(events[0].phase, "requested");
  assert.equal(events[0].packageName, "com.Slack");
});

test("PhoneUseCapabilityProbe poll emits payment event from secure window + ui tree", () => {
  const probe = new PhoneUseCapabilityProbe({
    adbRunner: {
      run: (_deviceId, args) => {
        const joined = args.join(" ");
        if (joined.includes("cmd appops")) {
          return "";
        }
        if (joined.includes("dumpsys media.camera")) {
          return "Active Camera Clients:\n[]";
        }
        if (joined.includes("logcat")) {
          return "";
        }
        if (joined.includes("dumpsys window windows")) {
          return [
            "mCurrentFocus=Window{ab12cd3 u0 com.shop.app/.CheckoutActivity}",
            "Window #9 Window{ab12cd3 u0 com.shop.app/.CheckoutActivity}:",
            "  mAttrs={(0,0)(fillxfill) sim=#20 ty=APPLICATION fl=FLAG_SECURE HARDWARE_ACCELERATED}",
            "  secure=true",
          ].join("\n");
        }
        if (joined.includes("exec-out uiautomator dump /dev/tty")) {
          return [
            "<hierarchy>",
            '<node index="0" text="Card number" resource-id="com.shop:id/card_number" class="android.widget.EditText" package="com.shop" content-desc="" clickable="true" enabled="true" focusable="true" password="false" bounds="[60,320][1020,430]" />',
            '<node index="1" text="Expiration date" resource-id="com.shop:id/expiry" class="android.widget.EditText" package="com.shop" content-desc="" clickable="true" enabled="true" focusable="true" password="false" bounds="[60,440][520,550]" />',
            '<node index="2" text="CVC" resource-id="com.shop:id/cvc" class="android.widget.EditText" package="com.shop" content-desc="" clickable="true" enabled="true" focusable="true" password="true" bounds="[560,440][1020,550]" />',
            "</hierarchy>",
          ].join("");
        }
        return "";
      },
    },
    nowMs: () => 3_000_000,
    nowIso: () => "2026-02-26T00:00:00.000Z",
    minPollIntervalMs: 300,
  });

  const events = probe.poll({
    deviceId: "emulator-5554",
    foregroundPackage: "com.shop.app",
  });
  const payment = events.find((event) => event.capability === "payment");
  assert.equal(Boolean(payment), true);
  assert.equal(payment.source, "window_secure");
  assert.equal(payment.paymentContext?.secureWindow, true);
  assert.equal((payment.paymentContext?.fieldCandidates?.length ?? 0) >= 3, true);
});
