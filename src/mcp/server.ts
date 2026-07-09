#!/usr/bin/env node

/**
 * OpenPocket Android Phone MCP Server
 *
 * Exposes Android target control as MCP tools for Codex, Claude Code, and
 * other MCP clients.
 * Usage: node dist/mcp/server.js [--config path/to/config.json]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "../config/index.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import { AdbRuntime } from "../device/adb-runtime.js";
import type {
  InstalledAppInfo,
  OpenPocketConfig,
  ScreenSnapshot,
  UiElementSnapshot,
} from "../types.js";

type ToolArgs = Record<string, unknown>;

export type OpenPocketPhoneRuntime = {
  config: OpenPocketConfig;
  emulator: EmulatorManager;
  adb: AdbRuntime;
  sleep?: (durationMs: number) => Promise<void>;
};

type McpTextContent = { type: "text"; text: string };
type McpImageContent = { type: "image"; data: string; mimeType: string };
type McpToolResult = {
  content: Array<McpTextContent | McpImageContent>;
  isError?: boolean;
};

type MatchMode = "contains" | "exact" | "regex";
type MatchField = "all" | "text" | "contentDesc" | "resourceId" | "className";

type UiElementMatch = {
  element: UiElementSnapshot;
  field: Exclude<MatchField, "all">;
  value: string;
  score: number;
};

const DEFAULT_WAIT_FOR_TEXT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_FOR_TEXT_INTERVAL_MS = 600;
const MAX_WAIT_FOR_TEXT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_MATCHES = 10;
const MAX_MATCHES = 50;

const MATCH_FIELDS: Array<Exclude<MatchField, "all">> = [
  "text",
  "contentDesc",
  "resourceId",
  "className",
];

// --- Tool Definitions --------------------------------------------------

export const TOOLS = [
  {
    name: "target_status",
    description:
      "Inspect the configured OpenPocket Android target, online ADB devices, booted emulator devices, and the currently resolved target device when available.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Optional target device ID to validate." },
      },
    },
  },
  {
    name: "start_emulator",
    description:
      "Start the configured Android emulator target and wait until it boots. Use only when target_status shows no online emulator for an emulator-backed target.",
    inputSchema: {
      type: "object" as const,
      properties: {
        headless: { type: "boolean", description: "Override emulator headless mode for this start." },
      },
    },
  },
  {
    name: "stop_emulator",
    description:
      "Stop the configured Android emulator target. Do not use for physical phones.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "current_app",
    description:
      "Inspect the current foreground Android app and a lightweight screenshot hash without returning image content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
    },
  },
  {
    name: "screenshot",
    description:
      "Capture the current Android target screen. Returns image content plus metadata, visible text, UI elements, secure-surface status, and capture metrics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
        includeApps: { type: "boolean", description: "Include launchable app labels and packages in metadata. Defaults to false." },
      },
    },
  },
  {
    name: "ui_snapshot",
    description:
      "Capture text-only UI metadata without returning images. Use before data extraction, text matching, or low-token inspection loops.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
        includeApps: { type: "boolean", description: "Include launchable app labels and packages. Defaults to false." },
      },
    },
  },
  {
    name: "visible_text",
    description:
      "Return visible/accessibility text lines and source UI element IDs from the current Android screen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
        includeResourceIds: { type: "boolean", description: "Include resource IDs as text hints. Defaults to false." },
      },
    },
  },
  {
    name: "find_text",
    description:
      "Find UI elements by visible text, content description, resource ID, or class name. Returns element IDs and bounds without tapping.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Text or regex to match." },
        matchMode: { type: "string", enum: ["contains", "exact", "regex"], description: "Text matching mode. Defaults to contains." },
        field: { type: "string", enum: ["all", "text", "contentDesc", "resourceId", "className"], description: "Element field to search. Defaults to all." },
        caseSensitive: { type: "boolean", description: "Use case-sensitive matching. Defaults to false." },
        maxResults: { type: "number", description: "Maximum matches to return. Defaults to 10." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["query"],
    },
  },
  {
    name: "wait_for_text",
    description:
      "Wait until matching UI text appears. Use instead of manual screenshot polling after navigation, scrolling, search, or app launch.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Text or regex to wait for." },
        matchMode: { type: "string", enum: ["contains", "exact", "regex"], description: "Text matching mode. Defaults to contains." },
        field: { type: "string", enum: ["all", "text", "contentDesc", "resourceId", "className"], description: "Element field to search. Defaults to all." },
        caseSensitive: { type: "boolean", description: "Use case-sensitive matching. Defaults to false." },
        timeoutMs: { type: "number", description: "Maximum wait time in milliseconds. Defaults to 10000 and caps at 60000." },
        intervalMs: { type: "number", description: "Polling interval in milliseconds. Defaults to 600." },
        maxResults: { type: "number", description: "Maximum matches to return. Defaults to 10." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["query"],
    },
  },
  {
    name: "tap_text",
    description:
      "Tap the best matching UI element by visible text, content description, or resource ID. Prefer this over raw coordinates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Text or regex to match before tapping." },
        matchMode: { type: "string", enum: ["contains", "exact", "regex"], description: "Text matching mode. Defaults to contains." },
        field: { type: "string", enum: ["all", "text", "contentDesc", "resourceId", "className"], description: "Element field to search. Defaults to all." },
        caseSensitive: { type: "boolean", description: "Use case-sensitive matching. Defaults to false." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["query"],
    },
  },
  {
    name: "tap",
    description: "Tap at pixel coordinates on the Android target screen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        x: { type: "number", description: "X coordinate in original device pixels." },
        y: { type: "number", description: "Y coordinate in original device pixels." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "tap_element",
    description: "Tap a UI element by its ID from screenshot, ui_snapshot, visible_text, or find_text.",
    inputSchema: {
      type: "object" as const,
      properties: {
        elementId: { type: "string", description: "Element ID from uiElements." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["elementId"],
    },
  },
  {
    name: "swipe",
    description: "Perform a swipe gesture on the Android target screen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        x1: { type: "number", description: "Start X coordinate." },
        y1: { type: "number", description: "Start Y coordinate." },
        x2: { type: "number", description: "End X coordinate." },
        y2: { type: "number", description: "End Y coordinate." },
        durationMs: { type: "number", description: "Swipe duration in ms. Defaults to 300." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["x1", "y1", "x2", "y2"],
    },
  },
  {
    name: "drag",
    description: "Perform a drag gesture between two points.",
    inputSchema: {
      type: "object" as const,
      properties: {
        x1: { type: "number", description: "Start X coordinate." },
        y1: { type: "number", description: "Start Y coordinate." },
        x2: { type: "number", description: "End X coordinate." },
        y2: { type: "number", description: "End Y coordinate." },
        durationMs: { type: "number", description: "Drag duration in ms. Defaults to 360." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["x1", "y1", "x2", "y2"],
    },
  },
  {
    name: "long_press_drag",
    description: "Long-press at the start point, then drag to the target point.",
    inputSchema: {
      type: "object" as const,
      properties: {
        x1: { type: "number", description: "Start X coordinate." },
        y1: { type: "number", description: "Start Y coordinate." },
        x2: { type: "number", description: "End X coordinate." },
        y2: { type: "number", description: "End Y coordinate." },
        holdMs: { type: "number", description: "Hold duration before moving. Defaults to 450." },
        durationMs: { type: "number", description: "Move duration in ms. Defaults to 300." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["x1", "y1", "x2", "y2"],
    },
  },
  {
    name: "type_text",
    description: "Type text into the currently focused input field on the Android target. Handles Unicode.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to type." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["text"],
    },
  },
  {
    name: "key_event",
    description: "Send an Android key event such as KEYCODE_BACK, KEYCODE_HOME, KEYCODE_ENTER, or KEYCODE_SEARCH.",
    inputSchema: {
      type: "object" as const,
      properties: {
        keycode: { type: "string", description: "Android keycode name." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["keycode"],
    },
  },
  {
    name: "open_app",
    description:
      "Open an installed app by package name or by matching its launcher label. Prefer this over launch_app when the package is unknown.",
    inputSchema: {
      type: "object" as const,
      properties: {
        packageName: { type: "string", description: "Android package name. Used directly when provided." },
        label: { type: "string", description: "Launcher label to match when packageName is unknown." },
        query: { type: "string", description: "Alias for label." },
        matchMode: { type: "string", enum: ["contains", "exact", "regex"], description: "Label/package matching mode. Defaults to contains." },
        caseSensitive: { type: "boolean", description: "Use case-sensitive matching. Defaults to false." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
    },
  },
  {
    name: "launch_app",
    description: "Launch an installed app by exact Android package name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        packageName: { type: "string", description: "Android package name." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["packageName"],
    },
  },
  {
    name: "adb_shell",
    description: "Execute an arbitrary ADB shell command on the Android target. Use narrowly and avoid destructive commands.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        useShellWrap: { type: "boolean", description: "Execute as sh -lc on device for operators or redirects. Defaults to false." },
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
      required: ["command"],
    },
  },
  {
    name: "list_apps",
    description: "List launchable apps with package names and launcher labels.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
    },
  },
  {
    name: "list_packages",
    description: "List launchable app package names on the Android target.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID. Required when multiple target devices are online." },
      },
    },
  },
  {
    name: "wait",
    description: "Wait for a specified duration between actions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        durationMs: { type: "number", description: "Duration in milliseconds. Defaults to 1000." },
      },
    },
  },
];

// --- Matching and metadata helpers -------------------------------------

function argsObject(raw: unknown): ToolArgs {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as ToolArgs;
  }
  return {};
}

function stringArg(args: ToolArgs, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringArg(args: ToolArgs, key: string): string | null {
  const value = stringArg(args, key);
  return value ? value : null;
}

function booleanArg(args: ToolArgs, key: string, fallback = false): boolean {
  return typeof args[key] === "boolean" ? Boolean(args[key]) : fallback;
}

function numberArg(args: ToolArgs, key: string, fallback: number): number {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

function boundedNumberArg(args: ToolArgs, key: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(numberArg(args, key, fallback))));
}

function matchModeArg(args: ToolArgs): MatchMode {
  const raw = stringArg(args, "matchMode");
  return raw === "exact" || raw === "regex" ? raw : "contains";
}

function matchFieldArg(args: ToolArgs): MatchField {
  const raw = stringArg(args, "field");
  return raw === "text"
    || raw === "contentDesc"
    || raw === "resourceId"
    || raw === "className"
    ? raw
    : "all";
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function textResult(text: string, isError = false): McpToolResult {
  return {
    content: [{ type: "text", text }],
    isError: isError || undefined,
  };
}

function jsonResult(payload: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(payload, null, 2), isError);
}

function elementLabel(element: UiElementSnapshot): string {
  return element.text || element.contentDesc || element.resourceId || element.className || element.id;
}

function compactElement(element: UiElementSnapshot) {
  return {
    id: element.id,
    text: element.text,
    contentDesc: element.contentDesc,
    resourceId: element.resourceId,
    className: element.className,
    clickable: element.clickable,
    enabled: element.enabled,
    bounds: element.bounds,
    center: element.center,
  };
}

function compactMatch(match: UiElementMatch) {
  return {
    field: match.field,
    value: match.value,
    score: match.score,
    element: compactElement(match.element),
  };
}

function normalizeForCompare(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

function elementFieldValue(element: UiElementSnapshot, field: Exclude<MatchField, "all">): string {
  switch (field) {
    case "text":
      return element.text;
    case "contentDesc":
      return element.contentDesc;
    case "resourceId":
      return element.resourceId;
    case "className":
      return element.className;
    default:
      return "";
  }
}

function matchValue(value: string, query: string, mode: MatchMode, caseSensitive: boolean): boolean {
  if (!value || !query) {
    return false;
  }
  if (mode === "regex") {
    const flags = caseSensitive ? "" : "i";
    return new RegExp(query, flags).test(value);
  }
  const haystack = normalizeForCompare(value, caseSensitive);
  const needle = normalizeForCompare(query, caseSensitive);
  return mode === "exact" ? haystack === needle : haystack.includes(needle);
}

function scoreMatch(field: Exclude<MatchField, "all">, value: string, query: string, mode: MatchMode, caseSensitive: boolean): number {
  const fieldScore = field === "text" ? 40 : field === "contentDesc" ? 30 : field === "resourceId" ? 20 : 5;
  const normalizedValue = normalizeForCompare(value, caseSensitive);
  const normalizedQuery = normalizeForCompare(query, caseSensitive);
  let modeScore = 10;
  if (mode === "exact" || normalizedValue === normalizedQuery) {
    modeScore = 60;
  } else if (normalizedValue.startsWith(normalizedQuery)) {
    modeScore = 40;
  } else if (mode === "regex") {
    modeScore = 35;
  } else if (normalizedValue.includes(normalizedQuery)) {
    modeScore = 25;
  }
  return fieldScore + modeScore + (value.length > 0 ? Math.max(0, 20 - Math.min(value.length, 20)) : 0);
}

export function findMatchingUiElements(
  elements: UiElementSnapshot[],
  options: {
    query: string;
    matchMode?: MatchMode;
    field?: MatchField;
    caseSensitive?: boolean;
    maxResults?: number;
  },
): UiElementMatch[] {
  const query = String(options.query || "").trim();
  if (!query) {
    return [];
  }
  const mode = options.matchMode ?? "contains";
  const caseSensitive = Boolean(options.caseSensitive);
  const fields = options.field && options.field !== "all"
    ? [options.field]
    : MATCH_FIELDS;
  const maxResults = Math.max(1, Math.min(MAX_MATCHES, Math.round(options.maxResults ?? DEFAULT_MAX_MATCHES)));
  const matches: UiElementMatch[] = [];

  for (const element of elements) {
    for (const field of fields) {
      const value = elementFieldValue(element, field).trim();
      if (!matchValue(value, query, mode, caseSensitive)) {
        continue;
      }
      matches.push({
        element,
        field,
        value,
        score: scoreMatch(field, value, query, mode, caseSensitive),
      });
    }
  }

  return matches
    .sort((a, b) => (
      b.score - a.score
      || a.element.bounds.top - b.element.bounds.top
      || a.element.bounds.left - b.element.bounds.left
      || a.element.id.localeCompare(b.element.id)
    ))
    .slice(0, maxResults);
}

export function visibleTextEntries(
  elements: UiElementSnapshot[],
  options?: { includeResourceIds?: boolean },
) {
  const includeResourceIds = Boolean(options?.includeResourceIds);
  const entries: Array<{
    elementId: string;
    text: string;
    source: "text" | "contentDesc" | "resourceId";
    bounds: UiElementSnapshot["bounds"];
    center: UiElementSnapshot["center"];
  }> = [];

  for (const element of elements) {
    const candidates: Array<{ text: string; source: "text" | "contentDesc" | "resourceId" }> = [
      { text: element.text.trim(), source: "text" },
      { text: element.contentDesc.trim(), source: "contentDesc" },
    ];
    if (includeResourceIds) {
      candidates.push({ text: element.resourceId.trim(), source: "resourceId" });
    }
    for (const candidate of candidates) {
      if (!candidate.text) {
        continue;
      }
      entries.push({
        elementId: element.id,
        text: candidate.text,
        source: candidate.source,
        bounds: element.bounds,
        center: element.center,
      });
    }
  }

  return entries;
}

function visibleTextLines(elements: UiElementSnapshot[], includeResourceIds = false): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of visibleTextEntries(elements, { includeResourceIds })) {
    const key = entry.text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(entry.text);
  }
  return lines;
}

export function buildSnapshotMetadata(
  snap: ScreenSnapshot,
  options?: {
    includeApps?: boolean;
    installedApps?: InstalledAppInfo[];
    includeResourceIds?: boolean;
  },
) {
  const includeApps = Boolean(options?.includeApps);
  const installedApps = options?.installedApps ?? snap.installedApps ?? [];
  const installedPackages = installedApps.length > 0
    ? installedApps.map((item) => item.packageName)
    : (snap.installedPackages ?? []);
  return {
    deviceId: snap.deviceId,
    currentApp: snap.currentApp,
    width: snap.width,
    height: snap.height,
    scaledWidth: snap.scaledWidth,
    scaledHeight: snap.scaledHeight,
    scaleX: snap.scaleX,
    scaleY: snap.scaleY,
    capturedAt: snap.capturedAt,
    secureSurfaceDetected: snap.secureSurfaceDetected,
    secureSurfaceEvidence: snap.secureSurfaceEvidence,
    captureMetrics: snap.captureMetrics ?? null,
    visibleTextLines: visibleTextLines(snap.uiElements, Boolean(options?.includeResourceIds)),
    visibleText: visibleTextEntries(snap.uiElements, { includeResourceIds: Boolean(options?.includeResourceIds) }),
    uiElements: snap.uiElements,
    ...(includeApps ? { installedApps, installedPackages } : {}),
  };
}

function requireUnambiguousTarget(runtime: OpenPocketPhoneRuntime, requestedDeviceId: string | null): void {
  if (requestedDeviceId || runtime.config.agent.deviceId) {
    return;
  }
  const status = runtime.emulator.status();
  if (status.devices.length <= 1) {
    return;
  }
  throw new Error(
    `Multiple target devices are online (${status.devices.join(", ")}). Pass deviceId explicitly before inspecting or controlling the target.`,
  );
}

function selectedDeviceId(runtime: OpenPocketPhoneRuntime, args: ToolArgs): string | null {
  const requestedDeviceId = optionalStringArg(args, "deviceId");
  requireUnambiguousTarget(runtime, requestedDeviceId);
  return requestedDeviceId;
}

function queryArgs(args: ToolArgs) {
  const query = stringArg(args, "query") || stringArg(args, "text");
  return {
    query,
    matchMode: matchModeArg(args),
    field: matchFieldArg(args),
    caseSensitive: booleanArg(args, "caseSensitive"),
    maxResults: boundedNumberArg(args, "maxResults", DEFAULT_MAX_MATCHES, 1, MAX_MATCHES),
  };
}

function appValueMatches(app: InstalledAppInfo, query: string, mode: MatchMode, caseSensitive: boolean): boolean {
  return matchValue(app.label, query, mode, caseSensitive)
    || matchValue(app.packageName, query, mode, caseSensitive);
}

function scoreAppMatch(app: InstalledAppInfo, query: string, mode: MatchMode, caseSensitive: boolean): number {
  const labelScore = matchValue(app.label, query, "exact", caseSensitive)
    ? 120
    : matchValue(app.label, query, mode, caseSensitive)
      ? 80
      : 0;
  const packageScore = matchValue(app.packageName, query, "exact", caseSensitive)
    ? 100
    : matchValue(app.packageName, query, mode, caseSensitive)
      ? 55
      : 0;
  return Math.max(labelScore, packageScore);
}

function compactApp(app: InstalledAppInfo) {
  return {
    label: app.label,
    packageName: app.packageName,
  };
}

function maybeDevicePackages(runtime: OpenPocketPhoneRuntime, deviceId: string | null, includeApps: boolean): InstalledAppInfo[] {
  if (!includeApps) {
    return [];
  }
  return runtime.adb.queryLaunchableApps(deviceId);
}

// --- Tool handlers ------------------------------------------------------

export async function handleOpenPocketPhoneTool(
  name: string,
  rawArgs: unknown,
  runtime: OpenPocketPhoneRuntime,
): Promise<McpToolResult> {
  const args = argsObject(rawArgs);

  try {
    switch (name) {
      case "target_status": {
        const deviceId = optionalStringArg(args, "deviceId");
        const status = runtime.emulator.status();
        let resolvedDeviceId: string | null = null;
        let resolveError: string | null = null;
        try {
          resolvedDeviceId = runtime.adb.resolveDeviceId(deviceId);
        } catch (e: any) {
          resolveError = e?.message ? String(e.message) : String(e);
        }
        return jsonResult({
          targetType: runtime.config.target?.type ?? "emulator",
          configuredDeviceId: runtime.config.agent.deviceId ?? null,
          requestedDeviceId: deviceId,
          ambiguousTarget: !deviceId && !runtime.config.agent.deviceId && status.devices.length > 1,
          resolvedDeviceId,
          resolveError,
          avdName: status.avdName,
          devices: status.devices,
          bootedDevices: status.bootedDevices,
        });
      }

      case "start_emulator": {
        const result = await runtime.emulator.start(
          typeof args.headless === "boolean" ? Boolean(args.headless) : undefined,
        );
        return textResult(result);
      }

      case "stop_emulator": {
        const result = runtime.emulator.stop();
        return textResult(result);
      }

      case "current_app": {
        const deviceId = selectedDeviceId(runtime, args);
        const observation = await runtime.adb.captureQuickObservation(deviceId);
        return jsonResult(observation);
      }

      case "screenshot": {
        const deviceId = selectedDeviceId(runtime, args);
        const includeApps = booleanArg(args, "includeApps");
        const snap = await runtime.adb.captureScreenSnapshot(deviceId);
        const installedApps = maybeDevicePackages(runtime, snap.deviceId, includeApps);
        const metadata = buildSnapshotMetadata(snap, { includeApps, installedApps });
        const content: Array<McpTextContent | McpImageContent> = [];
        if (snap.somScreenshotBase64) {
          content.push({
            type: "image",
            data: snap.somScreenshotBase64,
            mimeType: "image/png",
          });
        }
        content.push({ type: "image", data: snap.screenshotBase64, mimeType: "image/png" });
        content.push({ type: "text", text: JSON.stringify(metadata, null, 2) });
        return { content };
      }

      case "ui_snapshot": {
        const deviceId = selectedDeviceId(runtime, args);
        const includeApps = booleanArg(args, "includeApps");
        const snap = await runtime.adb.captureScreenSnapshot(deviceId);
        const installedApps = maybeDevicePackages(runtime, snap.deviceId, includeApps);
        return jsonResult(buildSnapshotMetadata(snap, { includeApps, installedApps }));
      }

      case "visible_text": {
        const deviceId = selectedDeviceId(runtime, args);
        const includeResourceIds = booleanArg(args, "includeResourceIds");
        const snap = await runtime.adb.captureScreenSnapshot(deviceId);
        return jsonResult({
          deviceId: snap.deviceId,
          currentApp: snap.currentApp,
          capturedAt: snap.capturedAt,
          secureSurfaceDetected: snap.secureSurfaceDetected,
          visibleTextLines: visibleTextLines(snap.uiElements, includeResourceIds),
          visibleText: visibleTextEntries(snap.uiElements, { includeResourceIds }),
        });
      }

      case "find_text": {
        const deviceId = selectedDeviceId(runtime, args);
        const options = queryArgs(args);
        const snap = await runtime.adb.captureScreenSnapshot(deviceId);
        const matches = findMatchingUiElements(snap.uiElements, options);
        return jsonResult({
          deviceId: snap.deviceId,
          currentApp: snap.currentApp,
          capturedAt: snap.capturedAt,
          query: options.query,
          matchMode: options.matchMode,
          field: options.field,
          caseSensitive: options.caseSensitive,
          matchCount: matches.length,
          matches: matches.map(compactMatch),
        });
      }

      case "wait_for_text": {
        const deviceId = selectedDeviceId(runtime, args);
        const options = queryArgs(args);
        const timeoutMs = boundedNumberArg(
          args,
          "timeoutMs",
          DEFAULT_WAIT_FOR_TEXT_TIMEOUT_MS,
          100,
          MAX_WAIT_FOR_TEXT_TIMEOUT_MS,
        );
        const intervalMs = boundedNumberArg(args, "intervalMs", DEFAULT_WAIT_FOR_TEXT_INTERVAL_MS, 100, 5_000);
        const sleepFn = runtime.sleep ?? sleep;
        const startedAt = Date.now();
        let attempts = 0;
        let lastSnap: ScreenSnapshot | null = null;
        let lastMatches: UiElementMatch[] = [];

        while (Date.now() - startedAt <= timeoutMs) {
          attempts += 1;
          const snap = await runtime.adb.captureScreenSnapshot(deviceId);
          lastSnap = snap;
          lastMatches = findMatchingUiElements(snap.uiElements, options);
          if (lastMatches.length > 0) {
            return jsonResult({
              found: true,
              elapsedMs: Date.now() - startedAt,
              attempts,
              deviceId: snap.deviceId,
              currentApp: snap.currentApp,
              query: options.query,
              matchCount: lastMatches.length,
              matches: lastMatches.map(compactMatch),
            });
          }
          const elapsedMs = Date.now() - startedAt;
          if (elapsedMs + intervalMs > timeoutMs) {
            break;
          }
          await sleepFn(intervalMs);
        }

        return jsonResult({
          found: false,
          elapsedMs: Date.now() - startedAt,
          attempts,
          query: options.query,
          lastDeviceId: lastSnap?.deviceId ?? null,
          lastCurrentApp: lastSnap?.currentApp ?? null,
          lastVisibleTextLines: lastSnap ? visibleTextLines(lastSnap.uiElements) : [],
          lastMatchCount: lastMatches.length,
        }, true);
      }

      case "tap_text": {
        const deviceId = selectedDeviceId(runtime, args);
        const options = queryArgs(args);
        const snap = await runtime.adb.captureScreenSnapshot(deviceId);
        const [match] = findMatchingUiElements(snap.uiElements, {
          ...options,
          maxResults: 1,
        });
        if (!match) {
          return jsonResult({
            tapped: false,
            query: options.query,
            currentApp: snap.currentApp,
            visibleTextLines: visibleTextLines(snap.uiElements),
            message: "No matching UI element found.",
          }, true);
        }
        const result = await runtime.adb.executeAction(
          { type: "tap", x: match.element.center.x, y: match.element.center.y },
          snap.deviceId,
        );
        return jsonResult({
          tapped: true,
          result,
          query: options.query,
          matched: compactMatch(match),
        });
      }

      case "tap": {
        const deviceId = selectedDeviceId(runtime, args);
        const result = await runtime.adb.executeAction(
          { type: "tap", x: Number(args.x), y: Number(args.y) },
          deviceId,
        );
        return textResult(result);
      }

      case "tap_element": {
        const deviceId = selectedDeviceId(runtime, args);
        const snap = await runtime.adb.captureScreenSnapshot(deviceId);
        const elementId = stringArg(args, "elementId");
        const element = snap.uiElements.find((item) => item.id === elementId);
        if (!element) {
          return jsonResult({
            tapped: false,
            elementId,
            message: "Element not found. Capture a fresh screenshot or use find_text/tap_text.",
            availableElements: snap.uiElements.map(compactElement),
          }, true);
        }
        const result = await runtime.adb.executeAction(
          { type: "tap", x: element.center.x, y: element.center.y },
          snap.deviceId,
        );
        return jsonResult({
          tapped: true,
          result,
          element: compactElement(element),
          label: elementLabel(element),
        });
      }

      case "swipe": {
        const deviceId = selectedDeviceId(runtime, args);
        const result = await runtime.adb.executeAction(
          {
            type: "swipe",
            x1: Number(args.x1),
            y1: Number(args.y1),
            x2: Number(args.x2),
            y2: Number(args.y2),
            durationMs: args.durationMs ? Number(args.durationMs) : undefined,
          },
          deviceId,
        );
        return textResult(result);
      }

      case "drag": {
        const deviceId = selectedDeviceId(runtime, args);
        const result = await runtime.adb.executeAction(
          {
            type: "drag",
            x1: Number(args.x1),
            y1: Number(args.y1),
            x2: Number(args.x2),
            y2: Number(args.y2),
            durationMs: args.durationMs ? Number(args.durationMs) : undefined,
          },
          deviceId,
        );
        return textResult(result);
      }

      case "long_press_drag": {
        const deviceId = selectedDeviceId(runtime, args);
        const result = await runtime.adb.executeAction(
          {
            type: "long_press_drag",
            x1: Number(args.x1),
            y1: Number(args.y1),
            x2: Number(args.x2),
            y2: Number(args.y2),
            holdMs: args.holdMs ? Number(args.holdMs) : undefined,
            durationMs: args.durationMs ? Number(args.durationMs) : undefined,
          },
          deviceId,
        );
        return textResult(result);
      }

      case "type_text": {
        const deviceId = selectedDeviceId(runtime, args);
        const result = await runtime.adb.executeAction(
          { type: "type", text: String(args.text) },
          deviceId,
        );
        return textResult(result);
      }

      case "key_event": {
        const deviceId = selectedDeviceId(runtime, args);
        const result = await runtime.adb.executeAction(
          { type: "keyevent", keycode: String(args.keycode) },
          deviceId,
        );
        return textResult(result);
      }

      case "open_app": {
        const deviceId = selectedDeviceId(runtime, args);
        const packageName = stringArg(args, "packageName");
        if (packageName) {
          const result = await runtime.adb.executeAction({ type: "launch_app", packageName }, deviceId);
          return jsonResult({ opened: true, packageName, result });
        }

        const query = stringArg(args, "label") || stringArg(args, "query");
        if (!query) {
          return jsonResult({
            opened: false,
            message: "Provide packageName, label, or query.",
          }, true);
        }

        const apps = runtime.adb.queryLaunchableApps(deviceId);
        const mode = matchModeArg(args);
        const caseSensitive = booleanArg(args, "caseSensitive");
        const candidates = apps
          .filter((app) => appValueMatches(app, query, mode, caseSensitive))
          .map((app) => ({ app, score: scoreAppMatch(app, query, mode, caseSensitive) }))
          .sort((a, b) => b.score - a.score || a.app.label.localeCompare(b.app.label));

        if (candidates.length === 0) {
          return jsonResult({
            opened: false,
            query,
            message: "No launchable app matched the requested label or package.",
            availableApps: apps.map(compactApp),
          }, true);
        }

        if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
          return jsonResult({
            opened: false,
            query,
            message: "Multiple apps matched equally. Use packageName to disambiguate.",
            candidates: candidates.slice(0, 8).map((item) => ({ ...compactApp(item.app), score: item.score })),
          }, true);
        }

        const selected = candidates[0].app;
        const result = await runtime.adb.executeAction(
          { type: "launch_app", packageName: selected.packageName },
          deviceId,
        );
        return jsonResult({
          opened: true,
          query,
          app: compactApp(selected),
          result,
        });
      }

      case "launch_app": {
        const deviceId = selectedDeviceId(runtime, args);
        const result = await runtime.adb.executeAction(
          { type: "launch_app", packageName: String(args.packageName) },
          deviceId,
        );
        return textResult(result);
      }

      case "adb_shell": {
        const deviceId = selectedDeviceId(runtime, args);
        const result = await runtime.adb.executeAction(
          {
            type: "shell",
            command: String(args.command),
            useShellWrap: booleanArg(args, "useShellWrap"),
          },
          deviceId,
        );
        return textResult(result);
      }

      case "list_apps": {
        const deviceId = selectedDeviceId(runtime, args);
        return jsonResult(runtime.adb.queryLaunchableApps(deviceId));
      }

      case "list_packages": {
        const deviceId = selectedDeviceId(runtime, args);
        return jsonResult(runtime.adb.queryLaunchablePackages(deviceId));
      }

      case "wait": {
        const ms = boundedNumberArg(args, "durationMs", 1000, 100, 60_000);
        const sleepFn = runtime.sleep ?? sleep;
        await sleepFn(ms);
        return textResult(`Waited ${ms}ms`);
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (e: any) {
    return textResult(`Error: ${e?.message ? String(e.message) : String(e)}`, true);
  }
}

// --- MCP Server --------------------------------------------------------

function configPathFromArgv(argv: string[]): string | undefined {
  const index = argv.indexOf("--config");
  return index >= 0 ? argv[index + 1] : undefined;
}

export function createDefaultRuntime(argv = process.argv): OpenPocketPhoneRuntime {
  const config = loadConfig(configPathFromArgv(argv));
  const emulator = new EmulatorManager(config);
  const adb = new AdbRuntime(config, emulator);
  return { config, emulator, adb };
}

export function createOpenPocketPhoneServer(runtime = createDefaultRuntime()): Server {
  const server = new Server(
    { name: "openpocket-phone", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => (
    handleOpenPocketPhoneTool(request.params.name, request.params.arguments, runtime)
  ));

  return server;
}

export async function runStdioServer(runtime = createDefaultRuntime()): Promise<void> {
  const server = createOpenPocketPhoneServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenPocket Phone MCP Server running on stdio");
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  return path.resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runStdioServer().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
