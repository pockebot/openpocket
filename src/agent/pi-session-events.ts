import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

export type PiSessionBridgeEvent =
  | { type: "assistant_text_delta"; delta: string }
  | { type: "assistant_thinking_delta"; delta: string }
  | { type: "tool_execution_start"; toolName: string }
  | { type: "tool_execution_update"; toolName: string; text: string }
  | { type: "tool_execution_end"; toolName: string; isError: boolean }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" };

function toToolName(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized || "unknown";
}

function readToolUpdateText(event: unknown): string {
  const chunks = (event as Record<string, unknown>)?.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
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
      return { type: "tool_execution_start", toolName: toToolName((event as Record<string, unknown>).toolName) };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolName: toToolName((event as Record<string, unknown>).toolName),
        text: readToolUpdateText(event as unknown as Record<string, unknown>),
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolName: toToolName((event as Record<string, unknown>).toolName),
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
