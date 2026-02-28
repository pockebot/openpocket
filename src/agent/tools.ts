/**
 * Tool / function-calling definitions for the OpenPocket agent.
 *
 * Each Android action is expressed as an AgentTool (pi-agent-core) with
 * TypeBox schemas for parameter validation and type safety.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Shared parameter fragments
// ---------------------------------------------------------------------------

const ThoughtParam = Type.String({ description: "Your reasoning about what to do and why." });
const ReasonParam = Type.Optional(Type.String({ description: "Short human-readable explanation of this action." }));

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

export const tapSchema = Type.Object({
  thought: ThoughtParam,
  x: Type.Number({ description: "X coordinate to tap." }),
  y: Type.Number({ description: "Y coordinate to tap." }),
  reason: ReasonParam,
});

export const tapElementSchema = Type.Object({
  thought: ThoughtParam,
  elementId: Type.String({ description: "Element id (e.g. 3) from the prompt's UI candidates list." }),
  reason: ReasonParam,
});

export const swipeSchema = Type.Object({
  thought: ThoughtParam,
  x1: Type.Number({ description: "Start X coordinate." }),
  y1: Type.Number({ description: "Start Y coordinate." }),
  x2: Type.Number({ description: "End X coordinate." }),
  y2: Type.Number({ description: "End Y coordinate." }),
  durationMs: Type.Optional(Type.Number({ description: "Swipe duration in milliseconds (default 300)." })),
  reason: ReasonParam,
});

export const typeTextSchema = Type.Object({
  thought: ThoughtParam,
  text: Type.String({ description: "The text to type." }),
  reason: ReasonParam,
});

export const keyeventSchema = Type.Object({
  thought: ThoughtParam,
  keycode: Type.String({ description: "Android keycode name." }),
  reason: ReasonParam,
});

export const launchAppSchema = Type.Object({
  thought: ThoughtParam,
  packageName: Type.String({ description: "Android package name to launch." }),
  reason: ReasonParam,
});

export const shellSchema = Type.Object({
  thought: ThoughtParam,
  command: Type.String({ description: "The adb shell command to execute." }),
  useShellWrap: Type.Optional(Type.Boolean({
    description: "When true, run as sh -lc '<command>' for complex shell syntax (redirects/heredoc/operators).",
  })),
  reason: ReasonParam,
});

const batchActionItemSchema = Type.Union([
  Type.Object({
    type: Type.Literal("tap"),
    x: Type.Number({ description: "X coordinate to tap." }),
    y: Type.Number({ description: "Y coordinate to tap." }),
    reason: ReasonParam,
  }),
  Type.Object({
    type: Type.Literal("tap_element"),
    elementId: Type.String({ description: "Element id from the current UI candidate list." }),
    reason: ReasonParam,
  }),
  Type.Object({
    type: Type.Literal("swipe"),
    x1: Type.Number({ description: "Start X coordinate." }),
    y1: Type.Number({ description: "Start Y coordinate." }),
    x2: Type.Number({ description: "End X coordinate." }),
    y2: Type.Number({ description: "End Y coordinate." }),
    durationMs: Type.Optional(Type.Number({ description: "Swipe duration in milliseconds (default 300)." })),
    reason: ReasonParam,
  }),
  Type.Object({
    type: Type.Literal("type"),
    text: Type.String({ description: "The text to type." }),
    reason: ReasonParam,
  }),
  Type.Object({
    type: Type.Literal("keyevent"),
    keycode: Type.String({ description: "Android keycode name." }),
    reason: ReasonParam,
  }),
  Type.Object({
    type: Type.Literal("wait"),
    durationMs: Type.Optional(Type.Number({ description: "Duration to wait in milliseconds (default 1000)." })),
    reason: ReasonParam,
  }),
]);

export const batchActionsSchema = Type.Object({
  thought: ThoughtParam,
  actions: Type.Array(batchActionItemSchema, {
    minItems: 1,
    maxItems: 6,
    description:
      "A short stable sequence of low-risk UI actions for the current screen. Use only when intermediate re-planning is unlikely to be needed.",
  }),
  reason: ReasonParam,
});

export const runScriptSchema = Type.Object({
  thought: ThoughtParam,
  script: Type.String({ description: "The script content to execute." }),
  timeoutSec: Type.Optional(Type.Number({ description: "Timeout in seconds (default 60)." })),
  reason: ReasonParam,
});

export const readSchema = Type.Object({
  thought: ThoughtParam,
  path: Type.String({ description: "Workspace-relative path to read." }),
  from: Type.Optional(Type.Number({ description: "1-based start line (default 1)." })),
  lines: Type.Optional(Type.Number({ description: "Max lines to read (default 200)." })),
  reason: ReasonParam,
});

export const writeSchema = Type.Object({
  thought: ThoughtParam,
  path: Type.String({ description: "Workspace-relative path to write." }),
  content: Type.String({ description: "File content to write." }),
  append: Type.Optional(Type.Boolean({ description: "Append instead of overwrite (default false)." })),
  reason: ReasonParam,
});

export const editSchema = Type.Object({
  thought: ThoughtParam,
  path: Type.String({ description: "Workspace-relative path to edit." }),
  find: Type.String({ description: "Text to find." }),
  replace: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(Type.Boolean({ description: "Replace all matches (default false)." })),
  reason: ReasonParam,
});

export const applyPatchSchema = Type.Object({
  thought: ThoughtParam,
  input: Type.String({ description: "Patch text in apply_patch format." }),
  reason: ReasonParam,
});

export const execSchema = Type.Object({
  thought: ThoughtParam,
  command: Type.String({ description: "Shell command to execute." }),
  workdir: Type.Optional(Type.String({ description: "Optional workspace-relative working directory." })),
  yieldMs: Type.Optional(Type.Number({ description: "Return early after this many ms if still running." })),
  background: Type.Optional(Type.Boolean({ description: "Run in background and return a session id." })),
  timeoutSec: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
  reason: ReasonParam,
});

export const processSchema = Type.Object({
  thought: ThoughtParam,
  action: Type.String({ description: "One of: list, poll, log, write, kill." }),
  sessionId: Type.Optional(Type.String({ description: "Session id for poll/log/write/kill." })),
  input: Type.Optional(Type.String({ description: "Input payload for write." })),
  offset: Type.Optional(Type.Number({ description: "Log line offset for log action." })),
  limit: Type.Optional(Type.Number({ description: "Max log lines for log action." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Max wait for poll action." })),
  reason: ReasonParam,
});

export const memorySearchSchema = Type.Object({
  thought: ThoughtParam,
  query: Type.String({ description: "What memory to search for." }),
  maxResults: Type.Optional(Type.Number({ description: "Max result count override." })),
  minScore: Type.Optional(Type.Number({ description: "Minimum score threshold (0-1)." })),
  reason: ReasonParam,
});

export const memoryGetSchema = Type.Object({
  thought: ThoughtParam,
  path: Type.String({ description: "Path returned by memory_search." }),
  from: Type.Optional(Type.Number({ description: "1-based start line." })),
  lines: Type.Optional(Type.Number({ description: "Maximum lines to read." })),
  reason: ReasonParam,
});

export const requestHumanAuthSchema = Type.Object({
  thought: ThoughtParam,
  capability: Type.String({
    description:
      "The capability that needs authorization: camera, qr, microphone, voice, nfc, sms, 2fa, location, biometric, notification, contacts, calendar, files, oauth, payment, permission, or unknown.",
  }),
  instruction: Type.String({
    description: "Clear instruction for the human on what to do.",
  }),
  timeoutSec: Type.Optional(Type.Number({ description: "How long to wait for human response (default 300)." })),
  reason: ReasonParam,
  uiTemplate: Type.Optional(Type.Any({
    description:
      "Optional dynamic portal template. Can define title/summary/style/form fields/artifact rules and agent-generated middleHtml/middleScript/approveScript for Human Auth page rendering.",
  })),
  templatePath: Type.Optional(Type.String({
    description:
      "Optional workspace-relative JSON template path generated by coding tools. Runtime loads this file and merges it before creating Human Auth request.",
  })),
});

export const requestUserDecisionSchema = Type.Object({
  thought: ThoughtParam,
  question: Type.String({ description: "Question shown to the user." }),
  options: Type.Array(Type.String(), { description: "2-8 concise options the user can choose from." }),
  timeoutSec: Type.Optional(Type.Number({ description: "How long to wait for user input (default 300)." })),
  reason: ReasonParam,
});

export const requestUserInputSchema = Type.Object({
  thought: ThoughtParam,
  question: Type.String({ description: "Question shown to the user." }),
  placeholder: Type.Optional(Type.String({ description: "Optional hint showing expected input format." })),
  timeoutSec: Type.Optional(Type.Number({ description: "How long to wait for user input (default 300)." })),
  reason: ReasonParam,
});

export const waitSchema = Type.Object({
  thought: ThoughtParam,
  durationMs: Type.Optional(Type.Number({ description: "Duration to wait in milliseconds (default 1000)." })),
  reason: ReasonParam,
});

export const finishSchema = Type.Object({
  thought: ThoughtParam,
  message: Type.String({ description: "Summary of what was accomplished." }),
});

// ---------------------------------------------------------------------------
// Exported types (Static inference from TypeBox schemas)
// ---------------------------------------------------------------------------

export type TapParams = Static<typeof tapSchema>;
export type TapElementParams = Static<typeof tapElementSchema>;
export type SwipeParams = Static<typeof swipeSchema>;
export type TypeTextParams = Static<typeof typeTextSchema>;
export type KeyeventParams = Static<typeof keyeventSchema>;
export type LaunchAppParams = Static<typeof launchAppSchema>;
export type ShellParams = Static<typeof shellSchema>;
export type BatchActionsParams = Static<typeof batchActionsSchema>;
export type RunScriptParams = Static<typeof runScriptSchema>;
export type ReadParams = Static<typeof readSchema>;
export type WriteParams = Static<typeof writeSchema>;
export type EditParams = Static<typeof editSchema>;
export type ApplyPatchParams = Static<typeof applyPatchSchema>;
export type ExecParams = Static<typeof execSchema>;
export type ProcessParams = Static<typeof processSchema>;
export type MemorySearchParams = Static<typeof memorySearchSchema>;
export type MemoryGetParams = Static<typeof memoryGetSchema>;
export type RequestHumanAuthParams = Static<typeof requestHumanAuthSchema>;
export type RequestUserDecisionParams = Static<typeof requestUserDecisionSchema>;
export type RequestUserInputParams = Static<typeof requestUserInputSchema>;
export type WaitParams = Static<typeof waitSchema>;
export type FinishParams = Static<typeof finishSchema>;

// ---------------------------------------------------------------------------
// Tool metadata list (name, description, schema) — used to build AgentTool[]
// ---------------------------------------------------------------------------

export interface ToolMeta {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
}

export const TOOL_METAS: ToolMeta[] = [
  { name: "tap", description: "Tap at the given (x, y) coordinate on the screen.", parameters: tapSchema },
  { name: "tap_element", description: "Tap a UI element by id from the current UI candidate list.", parameters: tapElementSchema },
  { name: "swipe", description: "Swipe from (x1,y1) to (x2,y2) on the screen.", parameters: swipeSchema },
  { name: "type_text", description: "Type text into the currently focused input field.", parameters: typeTextSchema },
  { name: "keyevent", description: "Send an Android keyevent (e.g. KEYCODE_BACK, KEYCODE_HOME, KEYCODE_ENTER).", parameters: keyeventSchema },
  { name: "launch_app", description: "Launch an Android application by package name.", parameters: launchAppSchema },
  { name: "shell", description: "Execute an adb shell command (optionally wrapped with sh -lc).", parameters: shellSchema },
  { name: "batch_actions", description: "Execute a short batch of low-risk UI actions on the current screen without re-planning between each action.", parameters: batchActionsSchema },
  { name: "run_script", description: "Run a short deterministic script as a fallback action.", parameters: runScriptSchema },
  { name: "read", description: "Read a workspace file (optionally with line range).", parameters: readSchema },
  { name: "write", description: "Create or overwrite a workspace file. Supports append mode.", parameters: writeSchema },
  { name: "edit", description: "Apply a precise find/replace edit to a workspace file.", parameters: editSchema },
  { name: "apply_patch", description: "Apply a multi-file patch using *** Begin Patch / *** End Patch format.", parameters: applyPatchSchema },
  { name: "exec", description: "Run a shell command in workspace with optional background continuation.", parameters: execSchema },
  { name: "process", description: "Manage exec background sessions: list, poll, log, write, kill.", parameters: processSchema },
  { name: "memory_search", description: "Search MEMORY.md and memory/*.md for relevant snippets before memory-based answers.", parameters: memorySearchSchema },
  { name: "memory_get", description: "Read a safe snippet from MEMORY.md or memory/*.md with line range.", parameters: memoryGetSchema },
  { name: "request_human_auth", description: "Request human authorization for actions requiring real-device capabilities (camera, SMS/2FA, biometric, payment, OAuth, etc.).", parameters: requestHumanAuthSchema },
  { name: "request_user_decision", description: "Ask user to choose one option during task execution (mixed-initiative flow).", parameters: requestUserDecisionSchema },
  { name: "request_user_input", description: "Ask user for a short non-sensitive text input needed to continue the task.", parameters: requestUserInputSchema },
  { name: "wait", description: "Wait / do nothing for a short period, e.g. while content is loading.", parameters: waitSchema },
  { name: "finish", description: "Signal that the user task is complete.", parameters: finishSchema },
];

// ---------------------------------------------------------------------------
// Compatibility: Chat Completions format (for legacy/direct OpenAI usage)
// ---------------------------------------------------------------------------

export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const CHAT_TOOLS: ChatCompletionTool[] = TOOL_METAS.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as Record<string, unknown>,
  },
}));

// ---------------------------------------------------------------------------
// Responses API format
// ---------------------------------------------------------------------------

export interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const RESPONSES_TOOLS: ResponsesTool[] = TOOL_METAS.map((t) => ({
  type: "function" as const,
  name: t.name,
  description: t.description,
  parameters: t.parameters as unknown as Record<string, unknown>,
}));

// ---------------------------------------------------------------------------
// Tool name to AgentAction type mapping
// ---------------------------------------------------------------------------

/** Map tool call name back to AgentAction type string. */
export function toolNameToActionType(toolName: string): string {
  if (toolName === "type_text") return "type";
  return toolName;
}

// ---------------------------------------------------------------------------
// Helper: create a text-only tool result
// ---------------------------------------------------------------------------

export function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
