#!/usr/bin/env node

/**
 * OpenPocket Android Emulator MCP Server
 *
 * Exposes emulator control as MCP tools for Claude Code.
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
  { name: "openpocket-emulator", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// --- Tool Definitions --------------------------------------------------

const TOOLS = [
  {
    name: "screenshot",
    description:
      "Capture the current emulator screen. Returns base64 PNG image, current foreground app, screen dimensions, and interactive UI elements with their IDs, text, bounds, and clickability.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deviceId: { type: "string", description: "Target device ID (e.g. emulator-5554). Auto-detected if omitted." },
      },
    },
  },
  {
    name: "tap",
    description: "Tap at pixel coordinates on the emulator screen",
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
    description: "Perform a swipe gesture on the emulator screen",
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
    description: "Type text into the currently focused input field on the emulator. Handles Unicode.",
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
    description: "Execute an arbitrary ADB shell command on the emulator",
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
    description: "List all launchable apps installed on the emulator",
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
          installedPackages: snap.installedPackages,
        };
        return {
          content: [
            { type: "image", data: snap.screenshotBase64, mimeType: "image/png" },
            { type: "text", text: JSON.stringify(metadata, null, 2) },
          ],
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
        const result = await adb.executeAction(
          { type: "tap_element", elementId: String(args.elementId) },
          deviceId,
        );
        return { content: [{ type: "text", text: result }] };
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
  console.error("OpenPocket Emulator MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
