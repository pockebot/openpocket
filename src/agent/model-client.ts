/**
 * Model client backed by @mariozechner/pi-ai.
 *
 * Uses `completeSimple` (non-streaming) from pi-ai to call any registered
 * LLM provider. The rest of OpenPocket's agent loop stays synchronous-step
 * oriented — one LLM call per observe-think-act cycle.
 */

import type {
  Model,
  Api,
  AssistantMessage,
  Context,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Tool,
} from "@mariozechner/pi-ai";

import type { AgentAction, ModelProfile, ModelStepOutput, ScreenSnapshot } from "../types.js";
import { normalizeAction } from "./actions.js";
import { buildUserPrompt } from "./prompts.js";
import { TOOL_METAS, toolNameToActionType } from "./tools.js";

// ---------------------------------------------------------------------------
// pi-ai bootstrap (dynamic import to handle ESM-from-CJS edge case)
// ---------------------------------------------------------------------------

let _piAiLoaded = false;

async function ensurePiAiLoaded(): Promise<void> {
  if (_piAiLoaded) return;
  // Importing the module registers all built-in providers (side-effect).
  await import("@mariozechner/pi-ai");
  _piAiLoaded = true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isChatGptBackendUrl(baseUrlLower: string): boolean {
  return baseUrlLower.includes("chatgpt.com/backend-api");
}

function isOpenAiBaseUrl(baseUrlLower: string): boolean {
  return baseUrlLower.includes("openai.com");
}

function isCodexModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase().includes("codex");
}

/** Build a pi-ai Tool[] from our TOOL_METAS (schema-only, no execute). */
function buildPiAiTools(): Tool[] {
  return TOOL_METAS.map((meta) => ({
    name: meta.name,
    description: meta.description,
    parameters: meta.parameters,
  }));
}

/** Extract the first tool call from an AssistantMessage. */
function extractToolCall(msg: AssistantMessage): { toolName: string; args: Record<string, unknown> } | null {
  for (const block of msg.content) {
    if (block.type === "toolCall") {
      return { toolName: block.name, args: block.arguments };
    }
  }
  return null;
}

/** Extract thinking text from an AssistantMessage (if any). */
function extractThinking(msg: AssistantMessage): string {
  for (const block of msg.content) {
    if (block.type === "thinking") {
      return (block as ThinkingContent).thinking;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Build a pi-ai Model object from an OpenPocket ModelProfile.
 *
 * This creates a custom Model that routes through the OpenAI-compatible
 * completions API (which covers OpenRouter, Blockrun, and any other
 * OpenAI-compatible endpoint).
 */
export function buildPiAiModel(profile: ModelProfile): Model<Api> {
  // Detect provider / api from baseUrl.
  const baseUrlLower = profile.baseUrl.toLowerCase();

  let api: Api = "openai-completions";
  let provider = "openai";
  let headers: Record<string, string> | undefined;

  if (isChatGptBackendUrl(baseUrlLower) && isCodexModelId(profile.model)) {
    api = "openai-codex-responses";
    provider = "openai-codex";
  } else if (isOpenAiBaseUrl(baseUrlLower) && isCodexModelId(profile.model)) {
    api = "openai-responses";
    provider = "openai";
  } else if (baseUrlLower.includes("openrouter.ai")) {
    provider = "openrouter";
  } else if (baseUrlLower.includes("blockrun.ai")) {
    provider = "openai"; // blockrun is OpenAI-compatible
  } else if (baseUrlLower.includes("anthropic.com")) {
    api = "anthropic-messages";
    provider = "anthropic";
  } else if (baseUrlLower.includes("googleapis.com") || baseUrlLower.includes("generativelanguage.googleapis.com")) {
    api = "google-generative-ai";
    provider = "google";
  } else if (baseUrlLower.includes("api.kimi.com")) {
    api = "anthropic-messages";
    provider = "kimi-coding";
    headers = { "user-agent": "openpocket/0.2.2 (coding-agent)" };
  } else if (baseUrlLower.includes("moonshot.cn") || baseUrlLower.includes("moonshot.ai")) {
    provider = "moonshot";
  } else if (baseUrlLower.includes("api.deepseek.com")) {
    provider = "openai";
  } else if (baseUrlLower.includes("dashscope.aliyuncs.com")) {
    provider = "openai";
  } else if (baseUrlLower.includes("api.minimax.io")) {
    api = "anthropic-messages";
    provider = "minimax";
  } else if (baseUrlLower.includes("volces.com") || baseUrlLower.includes("volcengine.com")) {
    provider = "openai";
  } else if (baseUrlLower.includes("bytepluses.com")) {
    provider = "openai";
  }

  return {
    id: profile.model,
    name: profile.model,
    api,
    provider,
    baseUrl: profile.baseUrl,
    reasoning: profile.reasoningEffort !== null,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: profile.maxTokens,
    ...(headers ? { headers } : {}),
  };
}

// ---------------------------------------------------------------------------
// ModelClient
// ---------------------------------------------------------------------------

export class ModelClient {
  private readonly profile: ModelProfile;
  private readonly apiKey: string;
  private readonly piModel: Model<Api>;
  private readonly piTools: Tool[];

  constructor(
    profile: ModelProfile,
    apiKey: string,
    options?: {
      baseUrl?: string;
      preferredMode?: "chat" | "responses" | "completions";
    },
  ) {
    this.profile = profile;
    this.apiKey = apiKey;

    // Build pi-ai model, optionally overriding baseUrl
    const effectiveProfile = options?.baseUrl
      ? { ...profile, baseUrl: options.baseUrl }
      : profile;

    const baseModel = buildPiAiModel(effectiveProfile);
    const isCodexResponsesModel =
      baseModel.api === "openai-codex-responses" || baseModel.provider === "openai-codex";

    // Handle preferred mode override
    if (isCodexResponsesModel) {
      this.piModel = {
        ...baseModel,
        provider: "openai-codex",
        api: "openai-codex-responses" as Api,
      };
    } else if (options?.preferredMode === "responses") {
      this.piModel = {
        ...baseModel,
        api: "openai-responses" as Api,
      };
    } else if (options?.preferredMode === "completions" || options?.preferredMode === "chat") {
      this.piModel = {
        ...baseModel,
        api: "openai-completions" as Api,
      };
    } else {
      this.piModel = baseModel;
    }

    this.piTools = buildPiAiTools();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async nextStep(params: {
    systemPrompt: string;
    task: string;
    step: number;
    snapshot: ScreenSnapshot;
    recentSnapshots?: ScreenSnapshot[];
    history: string[];
  }): Promise<ModelStepOutput> {
    await ensurePiAiLoaded();

    const { completeSimple } = await import("@mariozechner/pi-ai");

    const userText = buildUserPrompt(
      params.task,
      params.step,
      params.snapshot,
      params.history,
      params.recentSnapshots ?? [],
    );

    // Build multimodal user content with images
    const userContent: Array<TextContent | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: userText },
    ];

    // Add recent snapshot images
    for (const recent of params.recentSnapshots ?? []) {
      if (recent.somScreenshotBase64) {
        userContent.push({ type: "image", data: recent.somScreenshotBase64, mimeType: "image/png" });
      } else {
        userContent.push({ type: "image", data: recent.screenshotBase64, mimeType: "image/png" });
      }
    }

    // Add current snapshot SoM overlay (if available)
    if (params.snapshot.somScreenshotBase64) {
      userContent.push({ type: "image", data: params.snapshot.somScreenshotBase64, mimeType: "image/png" });
    }

    // Add current raw screenshot
    userContent.push({ type: "image", data: params.snapshot.screenshotBase64, mimeType: "image/png" });

    const context: Context = {
      systemPrompt: params.systemPrompt,
      messages: [
        {
          role: "user",
          content: userContent,
          timestamp: Date.now(),
        },
      ],
      tools: this.piTools,
    };

    // Map reasoning effort
    const reasoningMap: Record<string, "low" | "medium" | "high" | "xhigh"> = {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    };
    const reasoning = this.profile.reasoningEffort
      ? reasoningMap[this.profile.reasoningEffort]
      : undefined;

    // toolChoice: "required" forces the model to always return a tool call.
    // pi-ai providers read this from the options bag even though it's not
    // part of the base SimpleStreamOptions type.
    const streamOptions: SimpleStreamOptions & { toolChoice?: string } = {
      apiKey: this.apiKey,
      maxTokens: this.profile.maxTokens,
      reasoning,
      toolChoice: "required",
    };

    if (this.profile.temperature !== null) {
      streamOptions.temperature = this.profile.temperature;
    }

    let response: AssistantMessage;

    try {
      response = await completeSimple(this.piModel, context, streamOptions);
    } catch (error) {
      throw new Error(`Model call failed: ${stringifyError(error)}`);
    }

    if (response.stopReason === "error") {
      throw new Error(`Model returned error: ${response.errorMessage || "unknown"}`);
    }

    // Extract tool call
    const toolCall = extractToolCall(response);
    if (!toolCall) {
      throw new Error("Model response did not contain a tool call.");
    }

    // Extract thought from args (our tools include thought as a parameter)
    const thought = typeof toolCall.args.thought === "string"
      ? toolCall.args.thought
      : extractThinking(response) || "";

    const actionType = toolNameToActionType(toolCall.toolName);

    // Build raw action object for normalizeAction
    const { thought: _t, ...actionArgs } = toolCall.args;
    const actionRaw = { type: actionType, ...actionArgs };

    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][model][decision] tool=${toolCall.toolName} action=${JSON.stringify(actionRaw)}`);
    if (thought.trim()) {
      // eslint-disable-next-line no-console
      console.log(`[OpenPocket][model][thought] ${thought.trim()}`);
    }

    const action: AgentAction = normalizeAction(actionRaw);
    return {
      thought,
      action,
      raw: JSON.stringify({ tool: toolCall.toolName, args: toolCall.args }),
    };
  }
}
