import type { ModelProfile } from "../types.js";

export type ModelProviderPreset = {
  key: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  defaultModelId: string;
  suggestedModelIds: string[];
  matchHosts: string[];
};

const MODEL_PROVIDER_PRESETS: ReadonlyArray<ModelProviderPreset> = [
  {
    key: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModelId: "gpt-5.2-codex",
    suggestedModelIds: ["gpt-5.2-codex", "gpt-5.3-codex"],
    matchHosts: ["api.openai.com"],
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModelId: "claude-opus-4.6",
    suggestedModelIds: ["claude-opus-4.6", "claude-sonnet-4.6"],
    matchHosts: ["openrouter.ai"],
  },
  {
    key: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModelId: "claude-opus-4-6",
    suggestedModelIds: ["claude-opus-4-6", "claude-sonnet-4-5"],
    matchHosts: ["api.anthropic.com", "anthropic.com"],
  },
  {
    key: "google",
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModelId: "gemini-3.1-pro-preview",
    suggestedModelIds: ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-2.0-flash"],
    matchHosts: ["generativelanguage.googleapis.com", "googleapis.com"],
  },
  {
    key: "zai",
    label: "Z.AI (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    defaultModelId: "glm-5",
    suggestedModelIds: ["glm-5", "glm-4.7", "glm-4.7-flash"],
    matchHosts: ["api.z.ai", "bigmodel.cn"],
  },
  {
    key: "moonshot",
    label: "Moonshot AI",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModelId: "kimi-k2.5",
    suggestedModelIds: ["kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo"],
    matchHosts: ["moonshot.cn", "moonshot.ai"],
  },
  {
    key: "kimi-coding",
    label: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding",
    apiKeyEnv: "KIMI_API_KEY",
    defaultModelId: "k2p5",
    suggestedModelIds: ["k2p5"],
    matchHosts: ["api.kimi.com"],
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModelId: "deepseek-chat",
    suggestedModelIds: ["deepseek-chat", "deepseek-reasoner"],
    matchHosts: ["api.deepseek.com"],
  },
  {
    key: "qwen",
    label: "Qwen (DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "QWEN_API_KEY",
    defaultModelId: "qwen-max",
    suggestedModelIds: ["qwen-max", "qwen-plus", "qwen-coder-plus"],
    matchHosts: ["dashscope.aliyuncs.com"],
  },
  {
    key: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    defaultModelId: "MiniMax-M2.5",
    suggestedModelIds: ["MiniMax-M2.5", "MiniMax-M2.1"],
    matchHosts: ["api.minimax.io", "api.minimaxi.com"],
  },
  {
    key: "volcengine",
    label: "Volcano Engine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "VOLCENGINE_API_KEY",
    defaultModelId: "doubao-seed-1-8-251228",
    suggestedModelIds: ["doubao-seed-1-8-251228", "deepseek-v3-2-251201"],
    matchHosts: ["volces.com", "volcengine.com"],
  },
  {
    key: "blockrun",
    label: "BlockRun",
    baseUrl: "https://api.blockrun.ai/v1",
    apiKeyEnv: "BLOCKRUN_API_KEY",
    defaultModelId: "openai/gpt-4o",
    suggestedModelIds: ["openai/gpt-4o", "anthropic/claude-sonnet-4", "google/gemini-2.0-flash-exp"],
    matchHosts: ["blockrun.ai"],
  },
  {
    key: "byteplus",
    label: "BytePlus",
    baseUrl: "https://ark.bytepluses.com/api/v3",
    apiKeyEnv: "BYTEPLUS_API_KEY",
    defaultModelId: "seed-1-8-251228",
    suggestedModelIds: ["seed-1-8-251228"],
    matchHosts: ["bytepluses.com"],
  },
];

function inferReasoningEffort(modelId: string): ModelProfile["reasoningEffort"] {
  const lower = modelId.toLowerCase();
  if (
    lower.includes("gpt-5")
    || lower.includes("codex")
    || lower.includes("reason")
    || lower.includes("thinking")
    || lower.includes("opus")
  ) {
    return "medium";
  }
  return null;
}

function sanitizeProfileSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^[-/.]+|[-/.]+$)/g, "");
}

function normalizeReasoningEffort(input: unknown): ModelProfile["reasoningEffort"] {
  return input === "low" || input === "medium" || input === "high" || input === "xhigh"
    ? input
    : null;
}

export function listModelProviderPresets(): ReadonlyArray<ModelProviderPreset> {
  return MODEL_PROVIDER_PRESETS;
}

export function resolveModelProviderPreset(providerKey: string): ModelProviderPreset | null {
  const normalized = providerKey.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.key === normalized) ?? null;
}

export function resolveModelProviderPresetByBaseUrl(baseUrl: string): ModelProviderPreset | null {
  const lower = baseUrl.toLowerCase();
  for (const preset of MODEL_PROVIDER_PRESETS) {
    if (preset.matchHosts.some((host) => lower.includes(host))) {
      return preset;
    }
  }
  return null;
}

export function listModelProviderPresetKeys(): string[] {
  return MODEL_PROVIDER_PRESETS.map((preset) => preset.key);
}

export function deriveModelProfileKey(
  providerKey: string,
  modelId: string,
  models: Record<string, ModelProfile>,
): string {
  const providerPart = sanitizeProfileSegment(providerKey) || "provider";
  const modelPart = sanitizeProfileSegment(modelId) || "model";
  const baseKey = `${providerPart}/${modelPart}`;
  if (!models[baseKey]) {
    return baseKey;
  }
  let suffix = 2;
  while (models[`${baseKey}-${suffix}`]) {
    suffix += 1;
  }
  return `${baseKey}-${suffix}`;
}

export function buildModelProfileFromPreset(
  preset: ModelProviderPreset,
  modelId: string,
  existing?: ModelProfile,
): ModelProfile {
  const normalizedModelId = modelId.trim();
  return {
    baseUrl: preset.baseUrl,
    model: normalizedModelId,
    apiKey: existing?.apiKey ?? "",
    apiKeyEnv: preset.apiKeyEnv,
    maxTokens: Number.isFinite(existing?.maxTokens) ? Number(existing?.maxTokens) : 4096,
    reasoningEffort: normalizeReasoningEffort(existing?.reasoningEffort) ?? inferReasoningEffort(normalizedModelId),
    temperature: Number.isFinite(existing?.temperature) ? Number(existing?.temperature) : null,
  };
}
