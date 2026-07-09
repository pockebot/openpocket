import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOLS,
  buildSnapshotMetadata,
  findMatchingUiElements,
  handleOpenPocketPhoneTool,
  visibleTextEntries,
} from "../dist/mcp/server.js";

function element(overrides = {}) {
  return {
    id: overrides.id ?? "1",
    text: overrides.text ?? "",
    contentDesc: overrides.contentDesc ?? "",
    resourceId: overrides.resourceId ?? "",
    className: overrides.className ?? "android.widget.TextView",
    clickable: overrides.clickable ?? true,
    enabled: overrides.enabled ?? true,
    bounds: overrides.bounds ?? { left: 10, top: 20, right: 210, bottom: 90 },
    center: overrides.center ?? { x: 110, y: 55 },
    scaledBounds: overrides.scaledBounds ?? { left: 5, top: 10, right: 105, bottom: 45 },
    scaledCenter: overrides.scaledCenter ?? { x: 55, y: 27 },
  };
}

function snapshot(overrides = {}) {
  return {
    deviceId: overrides.deviceId ?? "emulator-5554",
    currentApp: overrides.currentApp ?? "com.whatnot_mobile",
    width: overrides.width ?? 1080,
    height: overrides.height ?? 2400,
    screenshotBase64: overrides.screenshotBase64 ?? Buffer.from("screen").toString("base64"),
    secureSurfaceDetected: overrides.secureSurfaceDetected ?? false,
    secureSurfaceEvidence: overrides.secureSurfaceEvidence ?? "",
    somScreenshotBase64: overrides.somScreenshotBase64 ?? null,
    capturedAt: overrides.capturedAt ?? "2026-07-08T20:00:00.000Z",
    scaleX: overrides.scaleX ?? 2,
    scaleY: overrides.scaleY ?? 2,
    scaledWidth: overrides.scaledWidth ?? 540,
    scaledHeight: overrides.scaledHeight ?? 1200,
    uiElements: overrides.uiElements ?? [],
    captureMetrics: overrides.captureMetrics ?? {
      totalMs: 12,
      ensureReadyMs: 1,
      screencapMs: 2,
      screenSizeMs: 1,
      currentAppMs: 1,
      scaleMs: 1,
      uiDumpMs: 3,
      overlayMs: 1,
      uiElementsSource: "fresh",
      uiElementsCount: overrides.uiElements?.length ?? 0,
      visualHash: "abc123",
      visualHashHammingDistance: null,
      uiDumpTimedOut: false,
      secureSurfaceDetected: overrides.secureSurfaceDetected ?? false,
      secureSurfaceEvidence: overrides.secureSurfaceEvidence ?? "",
    },
  };
}

function makeRuntime(options = {}) {
  const devices = options.devices ?? ["emulator-5554"];
  const apps = options.apps ?? [
    { label: "Whatnot", packageName: "com.whatnot_mobile" },
    { label: "Chrome", packageName: "com.android.chrome" },
  ];
  const snapshots = [...(options.snapshots ?? [snapshot()])];
  const actions = [];
  const sleeps = [];
  const runtime = {
    config: {
      target: { type: "emulator" },
      agent: { deviceId: options.configuredDeviceId ?? null },
    },
    emulator: {
      status() {
        return {
          targetType: "emulator",
          avdName: "OpenPocket_AVD",
          devices,
          bootedDevices: devices,
        };
      },
      start: async () => "started",
      stop: () => "stopped",
    },
    adb: {
      resolveDeviceId(preferred) {
        if (preferred) return preferred;
        if (devices.length === 0) throw new Error("No online target device found.");
        return devices[0];
      },
      captureQuickObservation: async (preferred) => ({
        deviceId: preferred ?? devices[0],
        currentApp: "com.whatnot_mobile",
        screenshotHash: "abc123",
      }),
      captureScreenSnapshot: async (preferred) => {
        const next = snapshots.shift() ?? options.snapshots?.at(-1) ?? snapshot();
        return {
          ...next,
          deviceId: preferred ?? next.deviceId,
        };
      },
      executeAction: async (action, preferred) => {
        actions.push({ action, preferred });
        return `ok:${action.type}`;
      },
      queryLaunchableApps: () => apps,
      queryLaunchablePackages: () => apps.map((item) => item.packageName),
    },
    sleep: async (durationMs) => {
      sleeps.push(durationMs);
    },
  };
  return { runtime, actions, sleeps };
}

function readJson(result) {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("MCP tool list exposes ergonomic phone-use primitives", () => {
  const names = TOOLS.map((tool) => tool.name);
  for (const expected of [
    "target_status",
    "screenshot",
    "ui_snapshot",
    "visible_text",
    "find_text",
    "wait_for_text",
    "tap_text",
    "open_app",
    "list_apps",
    "drag",
    "long_press_drag",
  ]) {
    assert.ok(names.includes(expected), `expected ${expected}`);
  }
  assert.equal(new Set(names).size, names.length, "tool names should be unique");
});

test("snapshot metadata includes secure-surface status, metrics, and visible text", () => {
  const snap = snapshot({
    secureSurfaceDetected: true,
    secureSurfaceEvidence: "FLAG_SECURE",
    uiElements: [
      element({ id: "1", text: "Sold", resourceId: "com.app:id/sold" }),
      element({ id: "2", contentDesc: "Search K-pop", text: "" }),
    ],
  });

  const metadata = buildSnapshotMetadata(snap, {
    includeApps: true,
    installedApps: [{ label: "Whatnot", packageName: "com.whatnot_mobile" }],
  });

  assert.equal(metadata.secureSurfaceDetected, true);
  assert.equal(metadata.secureSurfaceEvidence, "FLAG_SECURE");
  assert.equal(metadata.captureMetrics.totalMs, 12);
  assert.deepEqual(metadata.visibleTextLines, ["Sold", "Search K-pop"]);
  assert.deepEqual(metadata.installedPackages, ["com.whatnot_mobile"]);
});

test("visibleTextEntries and findMatchingUiElements return actionable element metadata", () => {
  const elements = [
    element({ id: "1", text: "Products", center: { x: 100, y: 100 } }),
    element({ id: "2", text: "Sold", contentDesc: "Sold tab", center: { x: 400, y: 100 } }),
  ];

  const entries = visibleTextEntries(elements);
  assert.deepEqual(entries.map((entry) => entry.text), ["Products", "Sold", "Sold tab"]);

  const matches = findMatchingUiElements(elements, {
    query: "sold",
    matchMode: "contains",
    field: "all",
    caseSensitive: false,
  });
  assert.equal(matches[0].element.id, "2");
  assert.equal(matches[0].field, "text");
});

test("tap_text captures the screen, resolves text, and taps the matched center", async () => {
  const { runtime, actions } = makeRuntime({
    snapshots: [
      snapshot({
        uiElements: [
          element({ id: "1", text: "Products", center: { x: 200, y: 120 } }),
          element({ id: "2", text: "Sold", center: { x: 820, y: 120 } }),
        ],
      }),
    ],
  });

  const result = await handleOpenPocketPhoneTool("tap_text", {
    query: "Sold",
    matchMode: "exact",
  }, runtime);
  const payload = readJson(result);

  assert.equal(payload.tapped, true);
  assert.equal(payload.matched.element.id, "2");
  assert.deepEqual(actions[0], {
    action: { type: "tap", x: 820, y: 120 },
    preferred: "emulator-5554",
  });
});

test("wait_for_text polls until matching UI text appears", async () => {
  const { runtime, sleeps } = makeRuntime({
    snapshots: [
      snapshot({ uiElements: [element({ id: "1", text: "Loading" })] }),
      snapshot({ uiElements: [element({ id: "2", text: "Sold Results" })] }),
    ],
  });

  const result = await handleOpenPocketPhoneTool("wait_for_text", {
    query: "Sold",
    timeoutMs: 5000,
    intervalMs: 250,
  }, runtime);
  const payload = readJson(result);

  assert.equal(payload.found, true);
  assert.equal(payload.attempts, 2);
  assert.equal(payload.matches[0].element.id, "2");
  assert.deepEqual(sleeps, [250]);
});

test("open_app resolves a launcher label to a package before launching", async () => {
  const { runtime, actions } = makeRuntime();
  const result = await handleOpenPocketPhoneTool("open_app", {
    label: "what",
  }, runtime);
  const payload = readJson(result);

  assert.equal(payload.opened, true);
  assert.equal(payload.app.packageName, "com.whatnot_mobile");
  assert.deepEqual(actions[0], {
    action: { type: "launch_app", packageName: "com.whatnot_mobile" },
    preferred: null,
  });
});

test("actions fail clearly when multiple target devices are online and no deviceId is provided", async () => {
  const { runtime } = makeRuntime({
    devices: ["emulator-5554", "emulator-5556"],
  });

  const result = await handleOpenPocketPhoneTool("tap", {
    x: 1,
    y: 2,
  }, runtime);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Multiple target devices are online/);
});
