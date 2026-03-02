import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";

import type { AdbRuntime } from "../device/adb-runtime.js";
import type { AgentAction } from "../types.js";
import {
  dragSchema,
  keyeventSchema,
  longPressDragSchema,
  launchAppSchema,
  shellSchema,
  swipeSchema,
  tapSchema,
  typeTextSchema,
} from "./tools.js";

export const ANDROID_CUSTOM_TOOL_NAMES = [
  "tap",
  "swipe",
  "drag",
  "long_press_drag",
  "type_text",
  "keyevent",
  "launch_app",
  "shell",
] as const;

type AndroidCustomToolName = (typeof ANDROID_CUSTOM_TOOL_NAMES)[number];
type AndroidActionType = Extract<AgentAction["type"], "tap" | "swipe" | "drag" | "long_press_drag" | "type" | "keyevent" | "launch_app" | "shell">;

type AndroidAction = Extract<AgentAction, { type: AndroidActionType }>;

const STATE_CHANGING_ANDROID_ACTIONS = new Set<AndroidActionType>([
  "tap",
  "swipe",
  "drag",
  "long_press_drag",
  "type",
  "keyevent",
  "launch_app",
  "shell",
]);

export interface AndroidCustomToolDetails {
  actionType: AndroidActionType;
  ok: boolean;
  stateChanging: boolean;
  output?: string;
  error?: string;
}

export interface AndroidCustomToolsOptions {
  adb: Pick<AdbRuntime, "executeAction">;
  preferredDeviceId?: string | null;
  onStateChange?: (params: { action: AndroidAction; output: string }) => Promise<void> | void;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || "unknown error");
}

function asToolResult(
  text: string,
  details: AndroidCustomToolDetails,
): AgentToolResult<AndroidCustomToolDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

async function executeAndroidAction(
  options: AndroidCustomToolsOptions,
  action: AndroidAction,
): Promise<AgentToolResult<AndroidCustomToolDetails>> {
  const stateChanging = STATE_CHANGING_ANDROID_ACTIONS.has(action.type);
  try {
    const output = await options.adb.executeAction(action, options.preferredDeviceId);
    if (stateChanging && options.onStateChange) {
      await options.onStateChange({ action, output });
    }
    return asToolResult(output, {
      actionType: action.type,
      ok: true,
      stateChanging,
      output,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    return asToolResult(`Action execution error: ${message}`, {
      actionType: action.type,
      ok: false,
      stateChanging,
      error: message,
    });
  }
}

export function ensureAndroidCustomToolNames(
  availableToolNames?: string[],
): string[] | undefined {
  if (!Array.isArray(availableToolNames) || availableToolNames.length === 0) {
    return availableToolNames;
  }
  const deduped = new Set(
    availableToolNames
      .map((item) => String(item).trim())
      .filter(Boolean),
  );
  for (const name of ANDROID_CUSTOM_TOOL_NAMES) {
    deduped.add(name);
  }
  return Array.from(deduped);
}

export function createAndroidCustomTools(
  options: AndroidCustomToolsOptions,
): Array<ToolDefinition<any, AndroidCustomToolDetails>> {
  return [
    {
      name: "tap",
      label: "tap",
      description: "Tap at (x, y) on the Android screen.",
      parameters: tapSchema,
      execute: async (_toolCallId: string, params: Static<typeof tapSchema>) => {
        return executeAndroidAction(options, {
          type: "tap",
          x: params.x,
          y: params.y,
          reason: params.reason,
        });
      },
    },
    {
      name: "swipe",
      label: "swipe",
      description: "Swipe from (x1, y1) to (x2, y2) on the Android screen.",
      parameters: swipeSchema,
      execute: async (_toolCallId: string, params: Static<typeof swipeSchema>) => {
        return executeAndroidAction(options, {
          type: "swipe",
          x1: params.x1,
          y1: params.y1,
          x2: params.x2,
          y2: params.y2,
          durationMs: params.durationMs,
          reason: params.reason,
        });
      },
    },
    {
      name: "drag",
      label: "drag",
      description: "Drag from (x1, y1) to (x2, y2) on the Android screen.",
      parameters: dragSchema,
      execute: async (_toolCallId: string, params: Static<typeof dragSchema>) => {
        return executeAndroidAction(options, {
          type: "drag",
          x1: params.x1,
          y1: params.y1,
          x2: params.x2,
          y2: params.y2,
          durationMs: params.durationMs,
          reason: params.reason,
        });
      },
    },
    {
      name: "long_press_drag",
      label: "long_press_drag",
      description: "Long-press at start point, then drag to target point.",
      parameters: longPressDragSchema,
      execute: async (_toolCallId: string, params: Static<typeof longPressDragSchema>) => {
        return executeAndroidAction(options, {
          type: "long_press_drag",
          x1: params.x1,
          y1: params.y1,
          x2: params.x2,
          y2: params.y2,
          holdMs: params.holdMs,
          durationMs: params.durationMs,
          reason: params.reason,
        });
      },
    },
    {
      name: "type_text",
      label: "type_text",
      description: "Type text into the currently focused Android input field.",
      parameters: typeTextSchema,
      execute: async (_toolCallId: string, params: Static<typeof typeTextSchema>) => {
        return executeAndroidAction(options, {
          type: "type",
          text: params.text,
          reason: params.reason,
        });
      },
    },
    {
      name: "keyevent",
      label: "keyevent",
      description: "Send an Android keyevent (for example KEYCODE_BACK).",
      parameters: keyeventSchema,
      execute: async (_toolCallId: string, params: Static<typeof keyeventSchema>) => {
        return executeAndroidAction(options, {
          type: "keyevent",
          keycode: params.keycode,
          reason: params.reason,
        });
      },
    },
    {
      name: "launch_app",
      label: "launch_app",
      description: "Launch an Android app by package name.",
      parameters: launchAppSchema,
      execute: async (_toolCallId: string, params: Static<typeof launchAppSchema>) => {
        return executeAndroidAction(options, {
          type: "launch_app",
          packageName: params.packageName,
          reason: params.reason,
        });
      },
    },
    {
      name: "shell",
      label: "shell",
      description: "Execute adb shell command. Set useShellWrap=true for complex shell syntax.",
      parameters: shellSchema,
      execute: async (_toolCallId: string, params: Static<typeof shellSchema>) => {
        return executeAndroidAction(options, {
          type: "shell",
          command: params.command,
          useShellWrap: Boolean(params.useShellWrap),
          reason: params.reason,
        });
      },
    },
  ];
}

export function isAndroidCustomToolName(name: string): name is AndroidCustomToolName {
  return (ANDROID_CUSTOM_TOOL_NAMES as readonly string[]).includes(name);
}
