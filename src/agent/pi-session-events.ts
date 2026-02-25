import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

export type PiSessionBridgeEvent =
  | { type: "assistant_text_delta"; delta: string }
  | { type: "assistant_thinking_delta"; delta: string }
  | { type: "tool_execution_start"; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool_execution_update"; toolName: string; toolCallId?: string; args?: unknown; text: string }
  | { type: "tool_execution_end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" };

function toToolName(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized || "unknown";
}

function readToolUpdateText(event: unknown): string {
  const input = event as Record<string, unknown> | undefined;
  const chunks = input?.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    const partialResult = input?.partialResult;
    if (typeof partialResult === "string") {
      return partialResult;
    }
    if (partialResult && typeof partialResult === "object") {
      const partial = partialResult as Record<string, unknown>;
      if (typeof partial.text === "string") {
        return partial.text;
      }
      const content = partial.content;
      if (Array.isArray(content)) {
        return content
          .map((item) => {
            if (!item || typeof item !== "object") {
              return "";
            }
            const text = (item as Record<string, unknown>).text;
            return typeof text === "string" ? text : "";
          })
          .filter(Boolean)
          .join("");
      }
    }
    return "";
  }
  const texts = chunks
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean);
  return texts.join("");
}

function readToolCallId(event: AgentSessionEvent): string | undefined {
  const value = (event as Record<string, unknown>).toolCallId;
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function readToolArgs(event: AgentSessionEvent): unknown {
  return (event as Record<string, unknown>).args;
}

function readToolResult(event: AgentSessionEvent): unknown {
  return (event as Record<string, unknown>).result;
}

export function normalizePiSessionEvent(event: AgentSessionEvent): PiSessionBridgeEvent | null {
  switch (event.type) {
    case "message_update": {
      const evt = event.assistantMessageEvent as Record<string, unknown> | undefined;
      const subtype = String(evt?.type ?? "");
      if (subtype === "text_delta") {
        return { type: "assistant_text_delta", delta: String(evt?.delta ?? "") };
      }
      if (subtype === "thinking_delta") {
        return { type: "assistant_thinking_delta", delta: String(evt?.delta ?? "") };
      }
      return null;
    }
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolName: toToolName((event as Record<string, unknown>).toolName),
        ...(readToolCallId(event) ? { toolCallId: readToolCallId(event) } : {}),
        ...(readToolArgs(event) !== undefined ? { args: readToolArgs(event) } : {}),
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolName: toToolName((event as Record<string, unknown>).toolName),
        ...(readToolCallId(event) ? { toolCallId: readToolCallId(event) } : {}),
        ...(readToolArgs(event) !== undefined ? { args: readToolArgs(event) } : {}),
        text: readToolUpdateText(event as unknown as Record<string, unknown>),
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolName: toToolName((event as Record<string, unknown>).toolName),
        ...(readToolCallId(event) ? { toolCallId: readToolCallId(event) } : {}),
        ...(readToolResult(event) !== undefined ? { result: readToolResult(event) } : {}),
        isError: Boolean((event as Record<string, unknown>).isError),
      };
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end" };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    default:
      return null;
  }
}
