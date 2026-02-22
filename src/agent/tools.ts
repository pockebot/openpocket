/**
 * Tool / function-calling definitions for the OpenPocket agent.
 *
 * Each Android action is expressed as a tool so the model returns structured
 * tool calls instead of free-form JSON text.
 */

// ---------------------------------------------------------------------------
// Shared parameter fragments
// ---------------------------------------------------------------------------

const thoughtParam = {
  type: "string" as const,
  description: "Your reasoning about what to do and why.",
};

const reasonParam = {
  type: "string" as const,
  description: "Short human-readable explanation of this action.",
};

// ---------------------------------------------------------------------------
// Canonical tool list (API-agnostic)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: "tap",
    description: "Tap at the given (x, y) coordinate on the screen.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        x: { type: "number", description: "X coordinate to tap." },
        y: { type: "number", description: "Y coordinate to tap." },
        reason: reasonParam,
      },
      required: ["thought", "x", "y"],
    },
  },
  {
    name: "swipe",
    description: "Swipe from (x1,y1) to (x2,y2) on the screen.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        x1: { type: "number", description: "Start X coordinate." },
        y1: { type: "number", description: "Start Y coordinate." },
        x2: { type: "number", description: "End X coordinate." },
        y2: { type: "number", description: "End Y coordinate." },
        durationMs: { type: "number", description: "Swipe duration in milliseconds (default 300)." },
        reason: reasonParam,
      },
      required: ["thought", "x1", "y1", "x2", "y2"],
    },
  },
  {
    name: "type_text",
    description: "Type text into the currently focused input field.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        text: { type: "string", description: "The text to type." },
        reason: reasonParam,
      },
      required: ["thought", "text"],
    },
  },
  {
    name: "keyevent",
    description: "Send an Android keyevent (e.g. KEYCODE_BACK, KEYCODE_HOME, KEYCODE_ENTER).",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        keycode: { type: "string", description: "Android keycode name." },
        reason: reasonParam,
      },
      required: ["thought", "keycode"],
    },
  },
  {
    name: "launch_app",
    description: "Launch an Android application by package name.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        packageName: { type: "string", description: "Android package name to launch." },
        reason: reasonParam,
      },
      required: ["thought", "packageName"],
    },
  },
  {
    name: "shell",
    description: "Execute a raw adb shell command.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        command: { type: "string", description: "The adb shell command to execute." },
        reason: reasonParam,
      },
      required: ["thought", "command"],
    },
  },
  {
    name: "run_script",
    description: "Run a short deterministic script as a fallback action.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        script: { type: "string", description: "The script content to execute." },
        timeoutSec: { type: "number", description: "Timeout in seconds (default 60)." },
        reason: reasonParam,
      },
      required: ["thought", "script"],
    },
  },
  {
    name: "read",
    description: "Read a workspace file (optionally with line range).",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        path: { type: "string", description: "Workspace-relative path to read." },
        from: { type: "number", description: "1-based start line (default 1)." },
        lines: { type: "number", description: "Max lines to read (default 200)." },
        reason: reasonParam,
      },
      required: ["thought", "path"],
    },
  },
  {
    name: "write",
    description: "Create or overwrite a workspace file. Supports append mode.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        path: { type: "string", description: "Workspace-relative path to write." },
        content: { type: "string", description: "File content to write." },
        append: { type: "boolean", description: "Append instead of overwrite (default false)." },
        reason: reasonParam,
      },
      required: ["thought", "path", "content"],
    },
  },
  {
    name: "edit",
    description: "Apply a precise find/replace edit to a workspace file.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        path: { type: "string", description: "Workspace-relative path to edit." },
        find: { type: "string", description: "Text to find." },
        replace: { type: "string", description: "Replacement text." },
        replaceAll: { type: "boolean", description: "Replace all matches (default false)." },
        reason: reasonParam,
      },
      required: ["thought", "path", "find", "replace"],
    },
  },
  {
    name: "apply_patch",
    description: "Apply a multi-file patch using *** Begin Patch / *** End Patch format.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        input: { type: "string", description: "Patch text in apply_patch format." },
        reason: reasonParam,
      },
      required: ["thought", "input"],
    },
  },
  {
    name: "exec",
    description: "Run a shell command in workspace with optional background continuation.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        command: { type: "string", description: "Shell command to execute." },
        workdir: { type: "string", description: "Optional workspace-relative working directory." },
        yieldMs: { type: "number", description: "Return early after this many ms if still running." },
        background: { type: "boolean", description: "Run in background and return a session id." },
        timeoutSec: { type: "number", description: "Timeout in seconds." },
        reason: reasonParam,
      },
      required: ["thought", "command"],
    },
  },
  {
    name: "process",
    description: "Manage exec background sessions: list, poll, log, write, kill.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        action: {
          type: "string",
          description: "One of: list, poll, log, write, kill.",
        },
        sessionId: { type: "string", description: "Session id for poll/log/write/kill." },
        input: { type: "string", description: "Input payload for write." },
        offset: { type: "number", description: "Log line offset for log action." },
        limit: { type: "number", description: "Max log lines for log action." },
        timeoutMs: { type: "number", description: "Max wait for poll action." },
        reason: reasonParam,
      },
      required: ["thought", "action"],
    },
  },
  {
    name: "memory_search",
    description: "Search MEMORY.md and memory/*.md for relevant snippets before memory-based answers.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        query: { type: "string", description: "What memory to search for." },
        maxResults: { type: "number", description: "Max result count override." },
        minScore: { type: "number", description: "Minimum score threshold (0-1)." },
        reason: reasonParam,
      },
      required: ["thought", "query"],
    },
  },
  {
    name: "memory_get",
    description: "Read a safe snippet from MEMORY.md or memory/*.md with line range.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        path: { type: "string", description: "Path returned by memory_search." },
        from: { type: "number", description: "1-based start line." },
        lines: { type: "number", description: "Maximum lines to read." },
        reason: reasonParam,
      },
      required: ["thought", "path"],
    },
  },
  {
    name: "request_human_auth",
    description:
      "Request human authorization for actions requiring real-device capabilities (camera, SMS/2FA, biometric, payment, OAuth, etc.).",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        capability: {
          type: "string",
          description:
            "The capability that needs authorization: camera, qr, microphone, voice, nfc, sms, 2fa, location, biometric, notification, contacts, calendar, files, oauth, payment, permission, or unknown.",
        },
        instruction: {
          type: "string",
          description: "Clear instruction for the human on what to do.",
        },
        timeoutSec: { type: "number", description: "How long to wait for human response (default 300)." },
        reason: reasonParam,
      },
      required: ["thought", "capability", "instruction"],
    },
  },
  {
    name: "wait",
    description: "Wait / do nothing for a short period, e.g. while content is loading.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        durationMs: { type: "number", description: "Duration to wait in milliseconds (default 1000)." },
        reason: reasonParam,
      },
      required: ["thought"],
    },
  },
  {
    name: "finish",
    description: "Signal that the user task is complete.",
    parameters: {
      type: "object",
      properties: {
        thought: thoughtParam,
        message: { type: "string", description: "Summary of what was accomplished." },
      },
      required: ["thought", "message"],
    },
  },
];

// ---------------------------------------------------------------------------
// Chat Completions format (OpenAI-compatible)
// ---------------------------------------------------------------------------

export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolDef["parameters"];
  };
}

export const CHAT_TOOLS: ChatCompletionTool[] = TOOL_DEFS.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

// ---------------------------------------------------------------------------
// Responses API format
// ---------------------------------------------------------------------------

export interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: ToolDef["parameters"];
}

export const RESPONSES_TOOLS: ResponsesTool[] = TOOL_DEFS.map((t) => ({
  type: "function" as const,
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

// ---------------------------------------------------------------------------
// Tool name to AgentAction type mapping
// ---------------------------------------------------------------------------

/** Map tool call name back to AgentAction type string. */
export function toolNameToActionType(toolName: string): string {
  if (toolName === "type_text") return "type";
  return toolName;
}
