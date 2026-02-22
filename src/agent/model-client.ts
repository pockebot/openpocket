import OpenAI from "openai";

import type { AgentAction, ModelProfile, ModelStepOutput, ScreenSnapshot } from "../types";
import { normalizeAction } from "./actions";
import { buildUserPrompt } from "./prompts";
import { CHAT_TOOLS, RESPONSES_TOOLS, toolNameToActionType } from "./tools";

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Parsed tool call result before conversion to AgentAction. */
interface ToolCallResult {
  toolName: string;
  args: Record<string, unknown>;
}

export class ModelClient {
  private readonly client: OpenAI;
  private readonly profile: ModelProfile;
  private readonly baseUrl: string;
  private modeHint: "chat" | "responses" = "chat";

  constructor(
    profile: ModelProfile,
    apiKey: string,
    options?: {
      baseUrl?: string;
      preferredMode?: "chat" | "responses" | "completions";
    },
  ) {
    this.profile = profile;
    this.baseUrl = options?.baseUrl ?? profile.baseUrl;
    this.client = new OpenAI({ apiKey, baseURL: this.baseUrl });
    if (options?.preferredMode) {
      this.modeHint = options.preferredMode === "completions" ? "chat" : options.preferredMode;
    }
  }

  // -----------------------------------------------------------------------
  // Request builders
  // -----------------------------------------------------------------------

  private buildChatRequest(params: {
    systemPrompt: string;
    userText: string;
    snapshot: ScreenSnapshot;
    recentSnapshots?: ScreenSnapshot[];
  }): Record<string, unknown> {
    const recentImages = (params.recentSnapshots ?? []).flatMap((item) => (
      item.somScreenshotBase64
        ? [{
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${item.somScreenshotBase64}` },
        }]
        : [{
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${item.screenshotBase64}` },
        }]
    ));
    const request: Record<string, unknown> = {
      model: this.profile.model,
      max_tokens: this.profile.maxTokens,
      messages: [
        {
          role: "system",
          content: params.systemPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: params.userText,
            },
            ...recentImages,
            ...(params.snapshot.somScreenshotBase64
              ? [{
                type: "image_url" as const,
                image_url: {
                  url: `data:image/png;base64,${params.snapshot.somScreenshotBase64}`,
                },
              }]
              : []),
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${params.snapshot.screenshotBase64}`,
              },
            },
          ],
        },
      ],
      tools: CHAT_TOOLS,
      tool_choice: "required",
    };

    if (this.profile.reasoningEffort) {
      request.reasoning_effort = this.profile.reasoningEffort;
    }
    if (this.profile.temperature !== null) {
      request.temperature = this.profile.temperature;
    }
    return request;
  }

  private buildResponsesRequest(params: {
    systemPrompt: string;
    userText: string;
    snapshot: ScreenSnapshot;
    recentSnapshots?: ScreenSnapshot[];
  }): Record<string, unknown> {
    const recentImages = (params.recentSnapshots ?? []).flatMap((item) => (
      item.somScreenshotBase64
        ? [{
          type: "input_image" as const,
          image_url: `data:image/png;base64,${item.somScreenshotBase64}`,
        }]
        : [{
          type: "input_image" as const,
          image_url: `data:image/png;base64,${item.screenshotBase64}`,
        }]
    ));
    const userContent = [
      { type: "input_text", text: params.userText },
      ...recentImages,
      ...(params.snapshot.somScreenshotBase64
        ? [{
          type: "input_image" as const,
          image_url: `data:image/png;base64,${params.snapshot.somScreenshotBase64}`,
        }]
        : []),
      {
        type: "input_image",
        image_url: `data:image/png;base64,${params.snapshot.screenshotBase64}`,
      },
    ];
    const isCodex = this.isCodexBackend();
    const request: Record<string, unknown> = isCodex
      ? {
          model: this.profile.model,
          instructions: params.systemPrompt,
          input: [
            {
              role: "user",
              content: userContent,
            },
          ],
          tools: RESPONSES_TOOLS,
          tool_choice: "required",
          // chatgpt.com/backend-api/codex/responses requires these flags.
          stream: true,
          store: false,
        }
      : {
          model: this.profile.model,
          max_output_tokens: this.profile.maxTokens,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: params.systemPrompt }],
            },
            {
              role: "user",
              content: userContent,
            },
          ],
          tools: RESPONSES_TOOLS,
          tool_choice: "required",
        };

    if (this.profile.reasoningEffort) {
      request.reasoning = { effort: this.profile.reasoningEffort };
    }
    if (this.profile.temperature !== null) {
      request.temperature = this.profile.temperature;
    }
    return request;
  }

  // -----------------------------------------------------------------------
  // Response parsers
  // -----------------------------------------------------------------------

  private parseChatToolCall(response: unknown): ToolCallResult {
    const resp = response as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };

    const toolCall = resp.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.name) {
      throw new Error("Chat response did not contain a tool call.");
    }

    const args = JSON.parse(toolCall.function.arguments ?? "{}") as Record<string, unknown>;
    return { toolName: toolCall.function.name, args };
  }

  private parseResponsesToolCall(response: unknown): ToolCallResult {
    const resp = response as {
      output?: Array<{
        type?: string;
        name?: string;
        arguments?: string;
      }>;
    };

    const output = resp.output;
    if (!Array.isArray(output)) {
      throw new Error("Responses API returned no output array.");
    }

    const toolCallItem = output.find(
      (item) => item.type === "function_call",
    );
    if (!toolCallItem?.name) {
      throw new Error("Responses API output did not contain a function_call item.");
    }

    const args = JSON.parse(toolCallItem.arguments ?? "{}") as Record<string, unknown>;
    return { toolName: toolCallItem.name, args };
  }

  // -----------------------------------------------------------------------
  // Mode dispatch
  // -----------------------------------------------------------------------

  private isCodexBackend(): boolean {
    return this.baseUrl.toLowerCase().includes("chatgpt.com/backend-api/codex");
  }

  private async requestByMode(
    mode: "chat" | "responses",
    params: {
      systemPrompt: string;
      userText: string;
      snapshot: ScreenSnapshot;
      recentSnapshots?: ScreenSnapshot[];
    },
  ): Promise<ToolCallResult> {
    if (mode === "chat") {
      const response = await this.client.chat.completions.create(
        this.buildChatRequest(params) as never,
      );
      return this.parseChatToolCall(response);
    }

    // responses mode
    const request = this.buildResponsesRequest(params);
    const response = this.isCodexBackend()
      ? await this.client.responses.stream(request as never).finalResponse()
      : await this.client.responses.create(request as never);
    return this.parseResponsesToolCall(response);
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
    const userText = buildUserPrompt(
      params.task,
      params.step,
      params.snapshot,
      params.history,
      params.recentSnapshots ?? [],
    );
    const modes: Array<"chat" | "responses"> = this.isCodexBackend()
      ? ["responses"]
      : this.modeHint === "chat"
        ? ["chat", "responses"]
        : ["responses", "chat"];

    let toolCall: ToolCallResult | null = null;
    const errors: string[] = [];

    for (const mode of modes) {
      try {
        toolCall = await this.requestByMode(mode, {
          systemPrompt: params.systemPrompt,
          userText,
          snapshot: params.snapshot,
          recentSnapshots: params.recentSnapshots,
        });
        if (this.modeHint !== mode) {
          this.modeHint = mode;
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][model] switched endpoint mode -> ${mode}`);
        }
        break;
      } catch (error) {
        errors.push(`${mode}: ${stringifyError(error)}`);
      }
    }

    if (!toolCall) {
      throw new Error(`All model endpoints failed. ${errors.join(" | ")}`);
    }

    // Extract thought from args, map tool name to action type.
    const thought = typeof toolCall.args.thought === "string" ? toolCall.args.thought : "";
    const actionType = toolNameToActionType(toolCall.toolName);

    // Build raw action object for normalizeAction.
    const { thought: _t, ...actionArgs } = toolCall.args;
    const actionRaw = { type: actionType, ...actionArgs };

    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][model] parsed action: ${JSON.stringify(actionRaw)}`);

    const action: AgentAction = normalizeAction(actionRaw);
    return {
      thought,
      action,
      raw: JSON.stringify({ tool: toolCall.toolName, args: toolCall.args }),
    };
  }
}
