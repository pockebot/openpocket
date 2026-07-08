#!/usr/bin/env node

/**
 * OpenPocket Android Phone MCP Server
 *
 * Exposes Android target control as MCP tools for Codex, Claude Code, and
 * other MCP clients.
 * Usage: node dist/mcp/server.js [--config path/to/config.json]
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "../config/index.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import { AdbRuntime } from "../device/adb-runtime.js";

// --- Bootstrap ---------------------------------------------------------

const configPath = process.argv.includes("--config")
  ? process.argv[process.argv.indexOf("--config") + 1]
  : undefined;

const config = loadConfig(configPath);
const emulator = new EmulatorManager(config);
const adb = new AdbRuntime(config, emulator);

// --- MCP Server --------------------------------------------------------

const server = new Server(
  { name: "openpocket-phone", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// --- Tool Definitions --------------------------------------------------

const TOOLS = [
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
    name: "screenshot",
    description:
      "Capture the current Android target screen. Returns PNG image content, current foreground app, screen dimensions, and interactive UI elements with IDs, text, bounds, and clickability.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID (for example emulator-5554 or a physical device serial). Auto-detected if omitted." },
      },
    },
  },
  {
    name: "tap",
    description: "Tap at pixel coordinates on the Android target screen",
    inputSchema: {
      type: "object" as const,
      properties: {
        x: { type: "number", description: "X coordinate (original device pixels)" },
        y: { type: "number", description: "Y coordinate (original device pixels)" },
        deviceId: { type: "string", description: "Target device ID" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "tap_element",
    description: "Tap a UI element by its ID (from screenshot uiElements). More reliable than coordinate taps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        elementId: { type: "string", description: "Element ID from uiElements (e.g. 'e1', 'e2')" },
        deviceId: { type: "string", description: "Target device ID" },
      },
      required: ["elementId"],
    },
  },
  {
    name: "swipe",
    description: "Perform a swipe gesture on the Android target screen",
    inputSchema: {
      type: "object" as const,
      properties: {
        x1: { type: "number", description: "Start X coordinate" },
        y1: { type: "number", description: "Start Y coordinate" },
        x2: { type: "number", description: "End X coordinate" },
        y2: { type: "number", description: "End Y coordinate" },
        durationMs: { type: "number", description: "Swipe duration in ms (default: 300)" },
        deviceId: { type: "string", description: "Target device ID" },
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
        text: { type: "string", description: "Text to type" },
        deviceId: { type: "string", description: "Target device ID" },
      },
      required: ["text"],
    },
  },
  {
    name: "key_event",
    description: "Send an Android key event (e.g. KEYCODE_BACK, KEYCODE_HOME, KEYCODE_ENTER)",
    inputSchema: {
      type: "object" as const,
      properties: {
        keycode: { type: "string", description: "Android keycode name (e.g. KEYCODE_BACK, KEYCODE_HOME, KEYCODE_ENTER)" },
        deviceId: { type: "string", description: "Target device ID" },
      },
      required: ["keycode"],
    },
  },
  {
    name: "launch_app",
    description: "Launch an installed app by package name",
    inputSchema: {
      type: "object" as const,
      properties: {
        packageName: { type: "string", description: "Android package name (e.g. com.android.chrome)" },
        deviceId: { type: "string", description: "Target device ID" },
      },
      required: ["packageName"],
    },
  },
  {
    name: "adb_shell",
    description: "Execute an arbitrary ADB shell command on the Android target",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        deviceId: { type: "string", description: "Target device ID" },
      },
      required: ["command"],
    },
  },
  {
    name: "list_packages",
    description: "List all launchable apps installed on the Android target",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID" },
      },
    },
  },
  {
    name: "wait",
    description: "Wait for a specified duration (useful between actions)",
    inputSchema: {
      type: "object" as const,
      properties: {
        durationMs: { type: "number", description: "Duration in milliseconds (default: 1000)" },
      },
    },
  },
];

// --- Handlers ----------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const deviceId = (args.deviceId as string) || null;

  try {
    switch (name) {
      case "target_status": {
        const status = emulator.status();
        let resolvedDeviceId: string | null = null;
        let resolveError: string | null = null;
        try {
          resolvedDeviceId = adb.resolveDeviceId(deviceId);
        } catch (e: any) {
          resolveError = e?.message ? String(e.message) : String(e);
        }
        const metadata = {
          targetType: config.target?.type ?? "emulator",
          configuredDeviceId: config.agent.deviceId ?? null,
          requestedDeviceId: deviceId,
          resolvedDeviceId,
          resolveError,
          avdName: status.avdName,
          devices: status.devices,
          bootedDevices: status.bootedDevices,
        };
        return { content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }] };
      }

      case "start_emulator": {
        const result = await emulator.start(
          typeof args.headless === "boolean" ? Boolean(args.headless) : undefined,
        );
        return { content: [{ type: "text", text: result }] };
      }

      case "stop_emulator": {
        const result = emulator.stop();
        return { content: [{ type: "text", text: result }] };
      }

      case "screenshot": {
        const snap = await adb.captureScreenSnapshot(deviceId);
        const metadata = {
          deviceId: snap.deviceId,
          currentApp: snap.currentApp,
          width: snap.width,
          height: snap.height,
          scaledWidth: snap.scaledWidth,
          scaledHeight: snap.scaledHeight,
          scaleX: snap.scaleX,
          scaleY: snap.scaleY,
          capturedAt: snap.capturedAt,
          uiElements: snap.uiElements,
          installedApps: snap.installedApps,
          installedPackages: snap.installedPackages,
        };
        const content = [];
        if (snap.somScreenshotBase64) {
          content.push({
            type: "image" as const,
            data: snap.somScreenshotBase64,
            mimeType: "image/png",
          });
        }
        content.push({ type: "image" as const, data: snap.screenshotBase64, mimeType: "image/png" });
        content.push({ type: "text" as const, text: JSON.stringify(metadata, null, 2) });
        return {
          content,
        };
      }

      case "tap": {
        const result = await adb.executeAction(
          { type: "tap", x: Number(args.x), y: Number(args.y) },
          deviceId,
        );
        return { content: [{ type: "text", text: result }] };
      }

      case "tap_element": {
        const snap = await adb.captureScreenSnapshot(deviceId);
        const elementId = String(args.elementId);
        const element = snap.uiElements.find((item) => item.id === elementId);
        if (!element) {
          return {
            content: [{
              type: "text",
              text: `Element not found: ${elementId}. Capture a fresh screenshot and use one of its uiElements IDs.`,
            }],
            isError: true,
          };
        }
        const result = await adb.executeAction(
          { type: "tap", x: element.center.x, y: element.center.y },
          snap.deviceId,
        );
        return {
          content: [{
            type: "text",
            text: `${result} via element ${element.id} (${element.text || element.contentDesc || element.resourceId || element.className})`,
          }],
        };
      }

      case "swipe": {
        const result = await adb.executeAction(
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
        return { content: [{ type: "text", text: result }] };
      }

      case "type_text": {
        const result = await adb.executeAction(
          { type: "type", text: String(args.text) },
          deviceId,
        );
        return { content: [{ type: "text", text: result }] };
      }

      case "key_event": {
        const result = await adb.executeAction(
          { type: "keyevent", keycode: String(args.keycode) },
          deviceId,
        );
        return { content: [{ type: "text", text: result }] };
      }

      case "launch_app": {
        const result = await adb.executeAction(
          { type: "launch_app", packageName: String(args.packageName) },
          deviceId,
        );
        return { content: [{ type: "text", text: result }] };
      }

      case "adb_shell": {
        const result = await adb.executeAction(
          { type: "shell", command: String(args.command) },
          deviceId,
        );
        return { content: [{ type: "text", text: result }] };
      }

      case "list_packages": {
        const packages = adb.queryLaunchablePackages(deviceId);
        return { content: [{ type: "text", text: JSON.stringify(packages, null, 2) }] };
      }

      case "wait": {
        const ms = Number(args.durationMs) || 1000;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { content: [{ type: "text", text: `Waited ${ms}ms` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e: any) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

// --- Start -------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenPocket Phone MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
