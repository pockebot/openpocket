import type { AgentAction, ModelStepOutput } from "../types.js";
import { formatDetailedError } from "../utils/error-details.js";
import { normalizeAction } from "./actions.js";

/**
 * GUI-Plus smart_resize coordinate conversion.
 *
 * The GUI-Plus model internally scales images using the smart_resize algorithm
 * (factor=28, min_pixels=3136, max_pixels=1003520) and outputs coordinates
 * in that scaled image space. To convert back to device coordinates:
 *   device_x = model_x / scaled_width * original_width
 *
 * See: https://help.aliyun.com/zh/model-studio/gui-automation
 */

const SMART_RESIZE_FACTOR = 28;
const SMART_RESIZE_MIN_PIXELS = 56 * 56;            // 3,136
const SMART_RESIZE_MAX_PIXELS = 14 * 14 * 4 * 1280; // 1,003,520

function roundByFactor(num: number, factor: number): number {
  return Math.round(num / factor) * factor;
}

function floorByFactor(num: number, factor: number): number {
  return Math.floor(num / factor) * factor;
}

function ceilByFactor(num: number, factor: number): number {
  return Math.ceil(num / factor) * factor;
}

/**
 * Calculate the scaled image dimensions that the GUI-Plus model uses internally.
 * Replicates the Qwen VL smart_resize algorithm.
 */
export function smartResize(
  height: number,
  width: number,
  factor: number = SMART_RESIZE_FACTOR,
  minPixels: number = SMART_RESIZE_MIN_PIXELS,
  maxPixels: number = SMART_RESIZE_MAX_PIXELS,
): { hBar: number; wBar: number } {
  let h = height;
  let w = width;

  const maxLongSide = 8192;
  if (Math.max(h, w) > maxLongSide) {
    const beta = Math.max(h, w) / maxLongSide;
    h = Math.floor(h / beta);
    w = Math.floor(w / beta);
  }

  let hBar = roundByFactor(h, factor);
  let wBar = roundByFactor(w, factor);

  if (hBar * wBar > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    hBar = floorByFactor(height / beta, factor);
    wBar = floorByFactor(width / beta, factor);
  } else if (hBar * wBar < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    hBar = ceilByFactor(height * beta, factor);
    wBar = ceilByFactor(width * beta, factor);
  }

  return { hBar, wBar };
}

function rescaleGuiPlusCoord(modelCoord: number, scaledSize: number, deviceSize: number): number {
  if (scaledSize <= 0) return Math.round(modelCoord);
  return Math.max(0, Math.min(Math.round((modelCoord / scaledSize) * deviceSize), deviceSize - 1));
}

// --- GUI-Plus action types ---

type GuiPlusAction =
  | { action: "CLICK"; parameters: { x: number; y: number; description?: string } }
  | { action: "TYPE"; parameters: { text: string; needs_enter?: boolean } }
  | { action: "SCROLL" | "SWIPE"; parameters: { direction: string; amount: string } }
  | { action: "KEY_PRESS"; parameters: { key: string } }
  | { action: "FINISH"; parameters: { message?: string } }
  | { action: "FAIL"; parameters: { reason?: string } };

// --- Client interfaces ---

export interface AliyunGuiPlusClientOptions {
  apiKey: string;
  baseUrl?: string;
  modelName?: string;
  thoughtLanguage?: string;
  fetchImpl?: typeof fetch;
}

export interface AliyunGuiPlusNextStepParams {
  task: string;
  screenshotBase64: string;
  addInfo?: string;
  thoughtLanguage?: string;
  viewportWidth: number;
  viewportHeight: number;
}

export interface AliyunGuiPlusNextStepResult {
  explanation: string;
  output: ModelStepOutput;
}

// --- Action mapping ---

function parseScrollAmount(amount: string): number {
  switch (amount.toLowerCase()) {
    case "small": return 0.2;
    case "large": return 0.6;
    default: return 0.4; // medium
  }
}

export function mapGuiPlusActionToAgentAction(params: {
  parsed: GuiPlusAction;
  thought: string;
  viewportWidth: number;
  viewportHeight: number;
  scaledWidth: number;
  scaledHeight: number;
}): AgentAction {
  const { parsed, thought, viewportWidth, viewportHeight, scaledWidth, scaledHeight } = params;
  const reason = thought || undefined;

  switch (parsed.action) {
    case "CLICK": {
      return normalizeAction({
        type: "tap",
        x: rescaleGuiPlusCoord(parsed.parameters.x, scaledWidth, viewportWidth),
        y: rescaleGuiPlusCoord(parsed.parameters.y, scaledHeight, viewportHeight),
        reason,
      });
    }
    case "TYPE": {
      return normalizeAction({
        type: "type",
        text: String(parsed.parameters.text ?? ""),
        reason,
      });
    }
    case "SWIPE":
    case "SCROLL": {
      const dir = String(parsed.parameters.direction ?? "down").toLowerCase();
      const fraction = parseScrollAmount(String(parsed.parameters.amount ?? "medium"));
      const xCenter = Math.round(viewportWidth * 0.5);
      const yCenter = Math.round(viewportHeight * 0.5);
      const yDelta = Math.round(viewportHeight * fraction);
      const xDelta = Math.round(viewportWidth * fraction);
      if (dir === "down") {
        return normalizeAction({ type: "swipe", x1: xCenter, y1: yCenter + Math.round(yDelta / 2), x2: xCenter, y2: yCenter - Math.round(yDelta / 2), reason });
      }
      if (dir === "up") {
        return normalizeAction({ type: "swipe", x1: xCenter, y1: yCenter - Math.round(yDelta / 2), x2: xCenter, y2: yCenter + Math.round(yDelta / 2), reason });
      }
      if (dir === "left") {
        return normalizeAction({ type: "swipe", x1: xCenter + Math.round(xDelta / 2), y1: yCenter, x2: xCenter - Math.round(xDelta / 2), y2: yCenter, reason });
      }
      if (dir === "right") {
        return normalizeAction({ type: "swipe", x1: xCenter - Math.round(xDelta / 2), y1: yCenter, x2: xCenter + Math.round(xDelta / 2), y2: yCenter, reason });
      }
      return normalizeAction({ type: "wait", durationMs: 500, reason: `unsupported scroll direction: ${dir}` });
    }
    case "KEY_PRESS": {
      const raw = String(parsed.parameters.key ?? "").trim();
      const key = raw.toUpperCase().startsWith("KEYCODE_") ? raw.toUpperCase() : `KEYCODE_${raw.replace(/[\s-]+/g, "_").toUpperCase()}`;
      return normalizeAction({ type: "keyevent", keycode: key, reason });
    }
    case "FINISH": {
      return normalizeAction({ type: "finish", message: parsed.parameters.message || thought || "Task finished." });
    }
    case "FAIL": {
      throw new Error(`GUI-Plus reported failure: ${parsed.parameters.reason || thought || "unknown"}`);
    }
    default: {
      return normalizeAction({ type: "wait", durationMs: 1000, reason: `unsupported GUI-Plus action: ${(parsed as { action?: string }).action || "empty"}` });
    }
  }
}

// --- Client ---

export class AliyunGuiPlusClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly thoughtLanguage: string;
  private readonly fetchImpl: typeof fetch;
  private conversationHistory: Array<{ role: string; content: unknown }> = [];

  constructor(options: AliyunGuiPlusClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
    this.modelName = options.modelName ?? "gui-plus";
    this.thoughtLanguage = options.thoughtLanguage ?? "english";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }

  async nextStep(params: AliyunGuiPlusNextStepParams): Promise<AliyunGuiPlusNextStepResult> {
    const { hBar, wBar } = smartResize(params.viewportHeight, params.viewportWidth);

    const userContent: unknown[] = [
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${params.screenshotBase64}`,
        },
      },
      {
        type: "text",
        text: params.task + (params.addInfo ? `\n\n${params.addInfo}` : ""),
      },
    ];

    const systemPrompt = `## 1. 核心角色 (Core Role)
你是一个顶级的AI视觉操作代理。你的任务是分析手机屏幕截图，理解用户的指令，然后将任务分解为单一、精确的GUI原子操作。
**重要**: 你正在操作一部安卓手机，不是电脑。
- 要打开应用程序，请使用CLICK点击屏幕上的应用图标。
- 如果目标应用不在当前屏幕上，使用SCROLL的left/right方向来翻页查找。
- 没有"OPEN"、"SWIPE"、"SYSTEM_BUTTON"等操作，只能使用以下6个工具。
- KEY_PRESS支持安卓键: 'back'(返回), 'home'(主屏幕), 'enter'(确认)。

## 2. [CRITICAL] JSON Schema & 绝对规则
你的输出**必须**是一个严格符合以下规则的JSON对象。**任何偏差都将导致失败**。

- **[R1] 严格的JSON**: 你的回复**必须**是且**只能是**一个JSON对象。禁止在JSON代码块前后添加任何文本、注释或解释。
- **[R2] 严格的Parameters结构**:\`thought\`对象的结构: "在这里用一句话简要描述你的思考过程。"
- **[R3] 精确的Action值**: \`action\`字段的值**必须**是\`## 3. 工具集\`中定义的一个大写字符串（例如 \`"CLICK"\`, \`"TYPE"\`），不允许有任何前导/后置空格或大小写变化。
- **[R4] 严格的Parameters结构**: \`parameters\`对象的结构**必须**与所选Action在\`## 3. 工具集\`中定义的模板**完全一致**。键名、值类型都必须精确匹配。

## 3. 工具集 (Available Actions)

### CLICK
- **功能**: 单击屏幕。
- **Parameters模板**: {"x": <integer>, "y": <integer>, "description": "<string, optional>"}

### TYPE
- **功能**: 输入文本。
- **Parameters模板**: {"text": "<string>", "needs_enter": <boolean>}

### SCROLL
- **功能**: 滚动屏幕。
- **Parameters模板**: {"direction": "<'up', 'down', 'left', or 'right'>", "amount": "<'small', 'medium', or 'large'>"}
- 在手机主屏幕上，使用left/right翻页查找应用；在应用内，使用up/down滚动内容。

### KEY_PRESS
- **功能**: 按下功能键。
- **Parameters模板**: {"key": "<string: e.g., 'enter', 'back', 'home'>"}

### FINISH
- **功能**: 任务成功完成。
- **Parameters模板**: {"message": "<string: 总结任务完成情况>"}

### FAIL
- **功能**: 任务无法完成。
- **Parameters模板**: {"reason": "<string: 清晰解释失败原因>"}

## 4. 思维与决策框架
在生成每一步操作前，请严格遵循以下思考-验证流程：
1. 目标分析: 用户的最终目标是什么？
2. 屏幕观察: 仔细分析截图。你的决策必须基于截图中存在的视觉证据。
3. 行动决策: 基于目标和可见的元素，选择最合适的工具。
4. 最终验证: 我的回复是纯粹的JSON吗？action的值是否正确无误？parameters的结构是否与模板100%一致？`;

    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...this.conversationHistory,
      {
        role: "user",
        content: userContent,
      },
    ];

    const payload = {
      model: this.modelName,
      messages,
      max_tokens: 2048,
      vl_high_resolution_images: true,
    };

    let response: Response;
    const endpoint = `${this.baseUrl}/chat/completions`;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new Error(`GUI-Plus request failed: ${formatDetailedError(error)}`);
    }

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`GUI-Plus request failed ${response.status}: ${rawBody.slice(0, 500)}`);
    }

    let responseJson: {
      choices?: Array<{
        message?: { content?: string; role?: string };
      }>;
    };
    try {
      responseJson = JSON.parse(rawBody);
    } catch {
      throw new Error(`GUI-Plus returned invalid JSON: ${rawBody.slice(0, 500)}`);
    }

    const assistantContent = responseJson.choices?.[0]?.message?.content ?? "";
    if (!assistantContent.trim()) {
      throw new Error(`GUI-Plus returned empty response: ${rawBody.slice(0, 500)}`);
    }

    // Maintain conversation history for multi-turn
    this.conversationHistory.push({ role: "user", content: userContent });
    this.conversationHistory.push({ role: "assistant", content: assistantContent });
    // Keep history bounded
    if (this.conversationHistory.length > 20) {
      this.conversationHistory = this.conversationHistory.slice(-16);
    }

    // Parse the structured JSON response
    let parsed: { thought?: string; action?: string; parameters?: Record<string, unknown> };
    try {
      // Handle potential markdown code block wrapping
      let jsonStr = assistantContent.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new Error(`GUI-Plus returned non-JSON action: ${assistantContent.slice(0, 300)}`);
    }

    const thought = String(parsed.thought ?? "").trim();
    const actionType = String(parsed.action ?? "").trim().toUpperCase();
    const parameters = parsed.parameters ?? {};

    const guiPlusAction = { action: actionType, parameters } as GuiPlusAction;
    const action = mapGuiPlusActionToAgentAction({
      parsed: guiPlusAction,
      thought,
      viewportWidth: params.viewportWidth,
      viewportHeight: params.viewportHeight,
      scaledWidth: wBar,
      scaledHeight: hBar,
    });

    return {
      explanation: thought,
      output: {
        thought,
        action,
        raw: rawBody,
      },
    };
  }
}
