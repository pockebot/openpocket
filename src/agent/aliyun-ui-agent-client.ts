import type { AgentAction, ModelStepOutput } from "../types.js";
import { formatDetailedError } from "../utils/error-details.js";
import { normalizeAction } from "./actions.js";

/**
 * Aliyun GUI-OWL model outputs coordinates in a 1000x1000 normalized space.
 * These must be rescaled to actual device pixel dimensions before execution.
 */
const ALIYUN_MODEL_COORD_SPACE = 1000;

function rescaleAliyunCoord(modelCoord: number, deviceSize: number): number {
  return Math.round((modelCoord / ALIYUN_MODEL_COORD_SPACE) * deviceSize);
}

export interface AliyunUiAgentClientOptions {
  apiKey: string;
  baseUrl?: string;
  modelName?: string;
  thoughtLanguage?: string;
  fetchImpl?: typeof fetch;
  sessionId?: string | null;
}

export interface AliyunUiAgentNextStepParams {
  task: string;
  screenshotUrl: string;
  addInfo?: string;
  thoughtLanguage?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface AliyunUiAgentNextStepResult {
  sessionId: string | null;
  explanation: string;
  output: ModelStepOutput;
}

type AliyunUiAgentResponse = {
  session_id?: string;
  output?: Array<{
    code?: string;
    content?: Array<{
      data?: {
        Thought?: string;
        Explanation?: string;
        Operation?: string;
      };
    }>;
  }>;
};

function parseNumberList(input: string): number[] {
  return input
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.round(value));
}

function unwrapAliyunTextArgument(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function normalizeAliyunKeycode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "KEYCODE_ENTER";
  }
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  const normalized = trimmed.replace(/[\s-]+/g, "_").toUpperCase();
  const key = normalized.startsWith("KEYCODE_") ? normalized.slice("KEYCODE_".length) : normalized;
  const aliases: Record<string, string> = {
    HOME: "KEYCODE_HOME",
    BACK: "KEYCODE_BACK",
    ENTER: "KEYCODE_ENTER",
    RETURN: "KEYCODE_ENTER",
    MENU: "KEYCODE_MENU",
    POWER: "KEYCODE_POWER",
    VOLUME_UP: "KEYCODE_VOLUME_UP",
    VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
    APP_SWITCH: "KEYCODE_APP_SWITCH",
    RECENT: "KEYCODE_APP_SWITCH",
    RECENTS: "KEYCODE_APP_SWITCH",
    SEARCH: "KEYCODE_SEARCH",
    CAMERA: "KEYCODE_CAMERA",
    DELETE: "KEYCODE_DEL",
    DEL: "KEYCODE_DEL",
    BACKSPACE: "KEYCODE_DEL",
  };
  return aliases[key] ?? `KEYCODE_${key}`;
}

function buildDirectionalScrollAction(params: {
  direction: string;
  viewportWidth?: number;
  viewportHeight?: number;
  reason?: string;
}): AgentAction | null {
  const direction = params.direction.trim().toLowerCase();
  const width = Number.isFinite(params.viewportWidth) && Number(params.viewportWidth) > 0
    ? Math.round(Number(params.viewportWidth))
    : 1080;
  const height = Number.isFinite(params.viewportHeight) && Number(params.viewportHeight) > 0
    ? Math.round(Number(params.viewportHeight))
    : 2400;
  const xCenter = Math.round(width * 0.5);
  const yCenter = Math.round(height * 0.5);
  const xLeft = Math.round(width * 0.25);
  const xRight = Math.round(width * 0.75);
  const yUpper = Math.round(height * 0.25);
  const yLower = Math.round(height * 0.75);

  if (direction === "down") {
    return normalizeAction({
      type: "swipe",
      x1: xCenter,
      y1: yLower,
      x2: xCenter,
      y2: yUpper,
      reason: params.reason,
    });
  }
  if (direction === "up") {
    return normalizeAction({
      type: "swipe",
      x1: xCenter,
      y1: yUpper,
      x2: xCenter,
      y2: yLower,
      reason: params.reason,
    });
  }
  if (direction === "left") {
    return normalizeAction({
      type: "swipe",
      x1: xRight,
      y1: yCenter,
      x2: xLeft,
      y2: yCenter,
      reason: params.reason,
    });
  }
  if (direction === "right") {
    return normalizeAction({
      type: "swipe",
      x1: xLeft,
      y1: yCenter,
      x2: xRight,
      y2: yCenter,
      reason: params.reason,
    });
  }
  return null;
}

export function mapAliyunOperationToAction(params: {
  operation: string;
  thought?: string;
  explanation?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}): AgentAction {
  const operation = String(params.operation || "").trim();
  const reason = String(params.explanation || params.thought || "").trim() || undefined;

  const vw = params.viewportWidth ?? ALIYUN_MODEL_COORD_SPACE;
  const vh = params.viewportHeight ?? ALIYUN_MODEL_COORD_SPACE;

  const clickMatch = operation.match(/^click\s*\(([^)]+)\)$/i);
  if (clickMatch) {
    const values = parseNumberList(clickMatch[1]);
    if (values.length >= 2) {
      return normalizeAction({
        type: "tap",
        x: rescaleAliyunCoord(values[0], vw),
        y: rescaleAliyunCoord(values[1], vh),
        reason,
      });
    }
  }

  const swipeMatch = operation.match(/^swipe\s*\(([^)]+)\)$/i);
  if (swipeMatch) {
    const values = parseNumberList(swipeMatch[1]);
    if (values.length >= 4) {
      return normalizeAction({
        type: "swipe",
        x1: rescaleAliyunCoord(values[0], vw),
        y1: rescaleAliyunCoord(values[1], vh),
        x2: rescaleAliyunCoord(values[2], vw),
        y2: rescaleAliyunCoord(values[3], vh),
        reason,
      });
    }
  }

  const typeMatch = operation.match(/^type\s*\(([\s\S]*)\)$/i);
  if (typeMatch) {
    return normalizeAction({
      type: "type",
      text: unwrapAliyunTextArgument(typeMatch[1]),
      reason,
    });
  }

  const keyPressMatch = operation.match(/^key[_\s-]*press\s*\(([\s\S]*)\)$/i);
  if (keyPressMatch) {
    return normalizeAction({
      type: "keyevent",
      keycode: normalizeAliyunKeycode(unwrapAliyunTextArgument(keyPressMatch[1])),
      reason,
    });
  }

  const scrollMatch = operation.match(/^scroll\s*\(([\s\S]*)\)$/i);
  if (scrollMatch) {
    const rawArgument = unwrapAliyunTextArgument(scrollMatch[1]);
    const values = parseNumberList(rawArgument);
    if (values.length >= 4) {
      return normalizeAction({
        type: "swipe",
        x1: rescaleAliyunCoord(values[0], vw),
        y1: rescaleAliyunCoord(values[1], vh),
        x2: rescaleAliyunCoord(values[2], vw),
        y2: rescaleAliyunCoord(values[3], vh),
        reason,
      });
    }
    const directionalAction = buildDirectionalScrollAction({
      direction: rawArgument,
      viewportWidth: params.viewportWidth,
      viewportHeight: params.viewportHeight,
      reason,
    });
    if (directionalAction) {
      return directionalAction;
    }
  }

  const doneMatch = operation.match(/^done(?:\s*\(\s*\))?$/i);
  if (doneMatch) {
    return normalizeAction({
      type: "finish",
      message: String(params.explanation || params.thought || "Task finished."),
    });
  }

  return normalizeAction({
    type: "wait",
    durationMs: 1000,
    reason: `unsupported Aliyun UI Agent operation: ${operation || "empty"}`,
  });
}

export function buildAliyunUiAgentPayload(params: {
  screenshotUrl: string;
  task: string;
  sessionId: string;
  modelName: string;
  thoughtLanguage: string;
  addInfo: string;
}): Record<string, unknown> {
  return {
    app_id: "gui-owl",
    input: [
      {
        role: "user",
        content: [
          {
            type: "data",
            data: {
              messages: [
                { image: params.screenshotUrl },
                { instruction: params.task },
                { session_id: params.sessionId },
                { device_type: "mobile" },
                { pipeline_type: "agent" },
                { model_name: params.modelName },
                { thought_language: params.thoughtLanguage },
                { param_list: [{ add_info: params.addInfo }] },
              ],
            },
          },
        ],
      },
    ],
  };
}

export class AliyunUiAgentClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly thoughtLanguage: string;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string;

  constructor(options: AliyunUiAgentClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://dashscope.aliyuncs.com/api/v2/apps/gui-owl/gui_agent_server";
    this.modelName = options.modelName ?? "pre-gui_owl_7b";
    this.thoughtLanguage = options.thoughtLanguage ?? "english";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sessionId = String(options.sessionId ?? "");
  }

  getSessionId(): string | null {
    return this.sessionId || null;
  }

  setSessionId(sessionId: string | null | undefined): void {
    this.sessionId = String(sessionId ?? "");
  }

  async nextStep(params: AliyunUiAgentNextStepParams): Promise<AliyunUiAgentNextStepResult> {
    const payload = buildAliyunUiAgentPayload({
      screenshotUrl: params.screenshotUrl,
      task: params.task,
      sessionId: this.sessionId,
      modelName: this.modelName,
      thoughtLanguage: params.thoughtLanguage ?? this.thoughtLanguage,
      addInfo: String(params.addInfo ?? ""),
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new Error(`Aliyun UI Agent request failed: ${formatDetailedError(error)}`);
    }

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`Aliyun UI Agent request failed ${response.status}: ${rawBody.slice(0, 500)}`);
    }

    let parsed: AliyunUiAgentResponse;
    try {
      parsed = JSON.parse(rawBody) as AliyunUiAgentResponse;
    } catch (error) {
      throw new Error(`Aliyun UI Agent returned invalid JSON: ${formatDetailedError(error)}`);
    }

    const responseSessionId = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
    if (responseSessionId) {
      this.sessionId = responseSessionId;
    }

    const firstMessage = parsed.output?.[0];
    const data = firstMessage?.content?.[0]?.data;
    if (!firstMessage || !data) {
      throw new Error(`Aliyun UI Agent response missing action data: ${rawBody.slice(0, 500)}`);
    }

    const thought = String(data.Thought ?? "").trim();
    const explanation = String(data.Explanation ?? "").trim();
    const operation = String(data.Operation ?? "").trim();
    const responseCode = typeof firstMessage.code === "string" ? firstMessage.code.trim() : "";
    if (responseCode && responseCode !== "200") {
      throw new Error(
        `Aliyun UI Agent returned error code ${responseCode}: ${explanation || thought || operation || rawBody.slice(0, 500)}`,
      );
    }
    if (/^fail(?:\s*\(|$)/i.test(operation)) {
      throw new Error(`Aliyun UI Agent reported failure: ${explanation || thought || operation}`);
    }
    const action = mapAliyunOperationToAction({
      operation,
      thought,
      explanation,
      viewportWidth: params.viewportWidth,
      viewportHeight: params.viewportHeight,
    });

    return {
      sessionId: this.getSessionId(),
      explanation,
      output: {
        thought,
        action,
        raw: rawBody,
      },
    };
  }
}
