import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

import type {
  AgentProgressUpdate,
  CronTaskPlan,
  ScheduleIntent,
  GatewayLogLevel,
  OpenPocketConfig,
  TaskExecutionPlan,
  TaskExecutionSurface,
} from "../types.js";
import type { TaskJournalSnapshot } from "../agent/journal/task-journal-store.js";
import { CODEX_CLI_BASE_URL } from "../config/codex-cli.js";
import { getModelProfile, resolveModelAuth } from "../config/index.js";
import { formatDetailedError } from "../utils/error-details.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  isWorkspaceOnboardingCompleted,
  markWorkspaceOnboardingCompleted,
} from "../memory/workspace.js";
import {
  emptyCronManagementPatch,
  emptyCronManagementSelector,
  normalizeCronManagementIntent,
  type CronManagementAction,
  type CronManagementIntent,
} from "./cron-management-intent.js";
import { CronRegistry } from "./cron-registry.js";
import {
  inferScheduleIntentLocale,
  normalizeScheduleIntentDecision,
} from "./schedule-intent.js";

type MsgRole = "user" | "assistant";

interface ChatTurn {
  role: MsgRole;
  content: string;
}

interface BootstrapOnboardingState {
  locale: OnboardingLocale;
  profile: ProfileSnapshot;
  turns: ChatTurn[];
}

interface BootstrapModelDecision {
  reply: string;
  profile?: {
    userPreferredAddress?: string;
    assistantName?: string;
    assistantPersona?: string;
    userName?: string;
    timezone?: string;
    languagePreference?: string;
  };
  writeProfile?: boolean;
  onboardingComplete?: boolean;
}

interface TaskProgressNarrationInput {
  task: string;
  locale: OnboardingLocale;
  progress: AgentProgressUpdate;
  recentProgress: AgentProgressUpdate[];
  lastNotifiedProgress: AgentProgressUpdate | null;
  skippedSteps: number;
}

interface TaskProgressNarrationDecision {
  notify: boolean;
  message: string;
  reason?: string;
}

interface TaskOutcomeNarrationInput {
  task: string;
  locale: OnboardingLocale;
  ok: boolean;
  rawResult: string;
  recentProgress: AgentProgressUpdate[];
  evidenceSnapshot: TaskJournalSnapshot | null;
  skillPath: string | null;
  scriptPath: string | null;
}

interface EscalationNarrationInput {
  event: "human_auth" | "user_decision";
  locale: OnboardingLocale;
  task: string;
  capability?: string | null;
  currentApp?: string | null;
  instruction?: string;
  reason?: string;
  question?: string;
  options?: string[];
  hasWebLink?: boolean;
  isCodeFlow?: boolean;
  includeLocalSecurityAssurance?: boolean;
}

type OnboardingStep = 1 | 2 | 3;
type OnboardingLocale = "zh" | "en";
type OnboardingProfileField = "userPreferredAddress" | "assistantName" | "assistantPersona";

interface ProfileOnboardingState {
  step: OnboardingStep;
  locale: OnboardingLocale;
  userPreferredAddress?: string;
  assistantName?: string;
  assistantPersona?: string;
}

interface ProfileSnapshot {
  userPreferredAddress: string;
  assistantName: string;
  assistantPersona: string;
  userName?: string;
  timezone?: string;
  languagePreference?: string;
}

interface OnboardingPreset {
  value: string;
  aliases: string[];
}

interface OnboardingTemplateCopy {
  questions: Record<OnboardingStep, string>;
  emptyAnswer: string;
  onboardingSaved: string;
  noChange: string;
  updated: string;
  changeJoiner: string;
  changeTemplates: Record<OnboardingProfileField, string>;
  fallbacks: {
    user: string;
    assistant: string;
    persona: string;
  };
  personaPresets: OnboardingPreset[];
}

interface OnboardingTemplate extends OnboardingTemplateCopy {
  version: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROFILE_ONBOARDING_TEMPLATE_FILE = "PROFILE_ONBOARDING.json";
const BARE_SESSION_RESET_TEMPLATE_FILE = "BARE_SESSION_RESET_PROMPT.md";
const TASK_PROGRESS_REPORTER_TEMPLATE_FILE = "TASK_PROGRESS_REPORTER.md";
const TASK_OUTCOME_REPORTER_TEMPLATE_FILE = "TASK_OUTCOME_REPORTER.md";
const CHAT_LOG_LEVEL_RANK: Record<GatewayLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const DEFAULT_SESSION_RESET_PROMPT = [
  "Session reset complete. Run Session Startup first:",
  "1) Reconfirm goal and constraints",
  "2) Read AGENTS.md / SOUL.md / USER.md / IDENTITY.md",
  "3) If BOOTSTRAP.md exists, finish onboarding first",
  "4) Then continue task execution",
].join("\n");

const DEFAULT_ONBOARDING_TEMPLATE: OnboardingTemplate = {
  version: 1,
  questions: {
    1: "Quick setup before we continue: how would you like me to address you? You can also tell me my name and persona in one message.",
    2: "Great. What name would you like to call me?",
    3: [
      "Final step: choose my persona/tone.",
      "You can describe it freely, or pick one preset:",
      "1) Professional & reliable: clear, stable, minimal fluff",
      "2) Fast & direct: action-oriented, concise, high tempo",
      "3) Warm & supportive: patient guidance, softer tone",
      "4) Light & humorous: relaxed tone while staying task-focused",
      "Reply example: `2` or `professional, concise, lightly humorous`",
    ].join("\n"),
  },
  emptyAnswer: "Please answer in one short sentence so I can save your profile.",
  onboardingSaved:
    "Done. I saved your profile to USER.md and IDENTITY.md. I will address you as \"{userPreferredAddress}\", and use \"{assistantName}\" with persona \"{assistantPersona}\".",
  noChange: "These profile settings are already up to date.",
  updated: "Updated. {changes}.",
  changeJoiner: "; ",
  changeTemplates: {
    userPreferredAddress: "I will address you as \"{value}\"",
    assistantName: "my name is now \"{value}\"",
    assistantPersona: "persona updated to \"{value}\"",
  },
  fallbacks: {
    user: "User",
    assistant: "OpenPocket",
    persona: "pragmatic, calm, and reliable",
  },
  personaPresets: [
    {
      value: "professional and reliable: clear, stable, minimal fluff",
      aliases: ["1", "a", "option1"],
    },
    {
      value: "fast and direct: action-oriented, concise, high tempo",
      aliases: ["2", "b", "option2"],
    },
    {
      value: "warm and supportive: patient guidance, softer tone",
      aliases: ["3", "c", "option3"],
    },
    {
      value: "light and humorous: relaxed tone while staying task-focused",
      aliases: ["4", "d", "option4"],
    },
  ],
};

export interface ChatDecision {
  mode: "task" | "chat" | "schedule_intent";
  task: string;
  reply: string;
  taskAcceptedReply?: string;
  confidence: number;
  reason: string;
  requiresExternalObservation?: boolean;
  canAnswerDirectly?: boolean;
  scheduleManagement?: boolean;
  scheduleManagementAction?: CronManagementAction;
  cronManagementIntent?: CronManagementIntent | null;
  scheduleIntent?: ScheduleIntent | null;
}

interface GroundingAuditDecision {
  requiresExternalObservation: boolean;
  canAnswerDirectly: boolean;
  confidence: number;
  reason: string;
}

interface ScheduleIntentExtractionDecision {
  route: "create_schedule" | "manage_schedule";
  task?: string;
  intent?: ScheduleIntent;
  manageAction?: CronManagementAction;
  cronManagementIntent?: CronManagementIntent;
  confidence: number;
  reason: string;
}

const MIN_SCHEDULE_INTENT_CONFIDENCE = 0.7;

function readResponseOutputText(response: unknown): string {
  if (typeof response !== "object" || response === null) {
    return "";
  }

  const withOutputText = response as { output_text?: unknown };
  if (typeof withOutputText.output_text === "string" && withOutputText.output_text.trim()) {
    return withOutputText.output_text.trim();
  }

  const chunks: string[] = [];
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return "";
  }

  for (const item of output) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const typed = part as { type?: unknown; text?: unknown };
      if ((typed.type === "output_text" || typed.type === "text") && typeof typed.text === "string") {
        chunks.push(typed.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function extractJsonObjectText(output: string): string {
  const fenced = output.match(/```json\s*([\s\S]*?)```/i) ?? output.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return output.slice(start, end + 1);
  }
  return output.trim();
}

export class ChatAssistant {
  private readonly config: OpenPocketConfig;
  private readonly history = new Map<number, ChatTurn[]>();
  private readonly profileOnboarding = new Map<number, ProfileOnboardingState>();
  private readonly bootstrapOnboarding = new Map<number, BootstrapOnboardingState>();
  private readonly pendingProfileUpdates =
    new Map<number, { assistantName: string; locale: OnboardingLocale }>();
  private onboardingTemplateCache:
    | { mtimeMs: number; template: OnboardingTemplate }
    | null = null;
  private modeHint: "responses" | "chat" | "completions" = "responses";
  private piAiLoadPromise: Promise<void> | null = null;

  constructor(config: OpenPocketConfig) {
    this.config = config;
  }

  private buildExistingJobsCatalog(maxJobs = 20, maxTaskChars = 500): string {
    try {
      const registry = new CronRegistry(this.config);
      const jobs = registry.list();
      if (jobs.length === 0) return "";
      const lines = jobs.slice(0, maxJobs).map((job) => {
        const taskPreview = job.payload.task.length > maxTaskChars
          ? `${job.payload.task.slice(0, maxTaskChars)}...`
          : job.payload.task;
        return `- id="${job.id}" name="${job.name}" enabled=${job.enabled} schedule="${job.schedule.summaryText}" task="${taskPreview}"`;
      });
      return [
        `Existing scheduled jobs (${jobs.length} total):`,
        ...lines,
      ].join("\n");
    } catch {
      return "";
    }
  }

  private shouldLogChat(level: GatewayLogLevel): boolean {
    if (!this.config.gatewayLogging.modules.chat) {
      return false;
    }
    const configured = this.config.gatewayLogging.level;
    return CHAT_LOG_LEVEL_RANK[level] <= CHAT_LOG_LEVEL_RANK[configured];
  }

  private clipForLog(text: string, maxChars: number): string {
    const compact = String(text || "").replace(/\s+/g, " ").trim();
    if (compact.length <= maxChars) {
      return compact;
    }
    return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private payloadForChatLog(text: string, maxChars: number): string {
    if (!this.config.gatewayLogging.includePayloads) {
      return "[hidden]";
    }
    const limit = Math.max(40, Math.min(1000, this.config.gatewayLogging.maxPayloadChars || maxChars));
    return this.clipForLog(text, Math.min(maxChars, limit));
  }

  private logChat(level: GatewayLogLevel, message: string): void {
    if (!this.shouldLogChat(level)) {
      return;
    }
    const line = `[OpenPocket][chat][${level}] ${new Date().toISOString()} ${message}`;
    if (level === "warn" || level === "error") {
      // eslint-disable-next-line no-console
      console.warn(line);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(line);
  }

  private shouldUseCodexResponsesTransport(client: OpenAI, model: string): boolean {
    if (!this.isCodexCliCapableModelId(model)) {
      return false;
    }
    const baseUrl = String((client as { baseURL?: string }).baseURL ?? "").toLowerCase();
    return baseUrl.includes("/backend-api/codex");
  }

  private isCodexCliCapableModelId(modelId: string): boolean {
    const model = modelId.trim().toLowerCase();
    return model.includes("codex") || model === "gpt-5.4" || model.startsWith("gpt-5.4-");
  }

  private isOpenAiLikeBaseUrl(baseUrl: string): boolean {
    const lower = baseUrl.toLowerCase();
    return lower.includes("openai.com") || lower.includes("chatgpt.com");
  }

  private readClientApiKey(client: OpenAI): string {
    return String((client as { apiKey?: string }).apiKey ?? "");
  }

  private async ensurePiAiLoaded(): Promise<void> {
    if (!this.piAiLoadPromise) {
      this.piAiLoadPromise = import("@mariozechner/pi-ai").then(() => undefined);
    }
    await this.piAiLoadPromise;
  }

  private extractPiAiAssistantText(message: unknown): string {
    if (!isObject(message)) {
      return "";
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const chunks: string[] = [];
    for (const block of blocks) {
      if (!isObject(block)) {
        continue;
      }
      if (block.type !== "text") {
        continue;
      }
      if (typeof block.text !== "string") {
        continue;
      }
      const text = block.text.trim();
      if (text) {
        chunks.push(text);
      }
    }
    return chunks.join("\n").trim();
  }

  private async callCodexResponsesText(params: {
    apiKey: string;
    model: string;
    maxTokens: number;
    systemPrompt: string;
    turns: ChatTurn[];
    inputText: string;
  }): Promise<string> {
    await this.ensurePiAiLoaded();
    const { completeSimple } = await import("@mariozechner/pi-ai");
    const now = Date.now();
    const messages = [
      ...params.turns.map((turn, idx) => ({
        role: turn.role,
        content: [{ type: "text", text: turn.content }],
        timestamp: now - (params.turns.length - idx + 1),
      })),
      {
        role: "user" as const,
        content: [{ type: "text", text: params.inputText }],
        timestamp: now,
      },
    ];

    const response = await completeSimple(
      {
        id: params.model,
        name: params.model,
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: CODEX_CLI_BASE_URL,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: Math.min(Math.max(32, params.maxTokens), 1200),
      } as never,
      {
        systemPrompt: params.systemPrompt,
        messages,
        tools: [],
      } as never,
      {
        apiKey: params.apiKey,
        maxTokens: Math.min(Math.max(32, params.maxTokens), 1200),
      } as never,
    );

    const text = this.extractPiAiAssistantText(response);
    if (!text) {
      throw new Error("Codex responses transport returned empty text output.");
    }
    return text;
  }

  private isAnthropicEndpoint(client: OpenAI): boolean {
    const baseUrl = String((client as { baseURL?: string }).baseURL ?? "").toLowerCase();
    return baseUrl.includes("api.kimi.com") || baseUrl.includes("anthropic.com");
  }

  private isGoogleEndpoint(client: OpenAI): boolean {
    const baseUrl = String((client as { baseURL?: string }).baseURL ?? "").toLowerCase();
    return baseUrl.includes("generativelanguage.googleapis.com");
  }

  private detectAnthropicProvider(client: OpenAI): string {
    const baseUrl = String((client as { baseURL?: string }).baseURL ?? "").toLowerCase();
    if (baseUrl.includes("api.kimi.com")) {
      return "kimi-coding";
    }
    return "anthropic";
  }

  private async callAnthropicText(params: {
    apiKey: string;
    model: string;
    baseUrl: string;
    provider: string;
    maxTokens: number;
    prompt: string;
  }): Promise<string> {
    await this.ensurePiAiLoaded();
    const { completeSimple } = await import("@mariozechner/pi-ai");

    const headers: Record<string, string> = {};
    if (params.provider === "kimi-coding") {
      headers["user-agent"] = "openpocket/0.2.2 (coding-agent)";
    }

    const response = await completeSimple(
      {
        id: params.model,
        name: params.model,
        api: "anthropic-messages",
        provider: params.provider,
        baseUrl: params.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: Math.min(Math.max(32, params.maxTokens), 4096),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      } as never,
      {
        systemPrompt: "",
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text", text: params.prompt }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      } as never,
      {
        apiKey: params.apiKey,
        maxTokens: Math.min(Math.max(32, params.maxTokens), 4096),
      } as never,
    );

    const text = this.extractPiAiAssistantText(response);
    if (!text) {
      const errMsg = (response as { errorMessage?: string }).errorMessage ?? "";
      throw new Error(errMsg ? `Anthropic transport error: ${errMsg}` : "Anthropic transport returned empty text output.");
    }
    return text;
  }

  private normalizeGoogleGenerativeBaseUrl(baseUrl: string): string {
    const trimmed = String(baseUrl ?? "").trim();
    if (!trimmed) {
      return "https://generativelanguage.googleapis.com/v1beta";
    }
    try {
      const url = new URL(trimmed);
      if (!url.hostname.toLowerCase().includes("generativelanguage.googleapis.com")) {
        return trimmed;
      }
      const pathname = url.pathname.replace(/\/+$/, "");
      if (!pathname) {
        url.pathname = "/v1beta";
        return url.toString().replace(/\/$/, "");
      }
      return trimmed;
    } catch {
      return trimmed;
    }
  }

  private async callGoogleText(params: {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokens: number;
    prompt: string;
  }): Promise<string> {
    await this.ensurePiAiLoaded();
    const { completeSimple } = await import("@mariozechner/pi-ai");

    const response = await completeSimple(
      {
        id: params.model,
        name: params.model,
        api: "google-generative-ai",
        provider: "google",
        baseUrl: this.normalizeGoogleGenerativeBaseUrl(params.baseUrl),
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: Math.min(Math.max(32, params.maxTokens), 4096),
      } as never,
      {
        systemPrompt: "",
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text", text: params.prompt }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      } as never,
      {
        apiKey: params.apiKey,
        maxTokens: Math.min(Math.max(32, params.maxTokens), 4096),
      } as never,
    );

    const text = this.extractPiAiAssistantText(response);
    if (!text) {
      throw new Error("Google transport returned empty text output.");
    }
    return text;
  }

  /**
   * Shared helper: call the model with automatic endpoint-mode fallback.
   * Returns the raw text output or empty string on failure.
   */
  private async callModelRaw(
    client: OpenAI,
    model: string,
    maxTokens: number,
    prompt: string,
    label: string,
  ): Promise<string> {
    if (this.isAnthropicEndpoint(client)) {
      try {
        const apiKey = this.readClientApiKey(client);
        const baseUrl = String((client as { baseURL?: string }).baseURL ?? "");
        const provider = this.detectAnthropicProvider(client);
        return await this.callAnthropicText({ apiKey, model, baseUrl, provider, maxTokens, prompt });
      } catch (error) {
        this.logChat("warn", `${label} failed provider=anthropic error=${formatDetailedError(error)}`);
        return "";
      }
    }

    if (this.isGoogleEndpoint(client)) {
      try {
        const apiKey = this.readClientApiKey(client);
        const baseUrl = String((client as { baseURL?: string }).baseURL ?? "");
        return await this.callGoogleText({ apiKey, model, baseUrl, maxTokens, prompt });
      } catch (error) {
        this.logChat("warn", `${label} failed provider=google-generative-ai error=${formatDetailedError(error)}`);
        return "";
      }
    }

    if (this.shouldUseCodexResponsesTransport(client, model)) {
      const apiKey = this.readClientApiKey(client);
      try {
        const output = await this.callCodexResponsesText({
          apiKey,
          model,
          maxTokens,
          systemPrompt: "",
          turns: [],
          inputText: prompt,
        });
        if (this.modeHint !== "responses") {
          this.modeHint = "responses";
          this.logChat("info", "switched endpoint mode=responses");
        }
        return output;
      } catch (error) {
        this.logChat("warn", `${label} failed provider=codex-responses error=${formatDetailedError(error)}`);
        return "";
      }
    }

    const tryModes: Array<"responses" | "chat" | "completions"> =
      this.modeHint === "responses"
        ? ["responses", "chat", "completions"]
        : this.modeHint === "chat"
          ? ["chat", "responses", "completions"]
          : ["completions", "responses", "chat"];

    let output = "";
    const errors: string[] = [];
    for (const mode of tryModes) {
      try {
        if (mode === "responses") {
          const response = await client.responses.create({
            model,
            max_output_tokens: maxTokens,
            input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          } as never);
          output = readResponseOutputText(response);
        } else if (mode === "chat") {
          const response = await client.chat.completions.create({
            model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: prompt }],
          } as never);
          const msg = response.choices?.[0]?.message as
            | { content?: string; reasoning_content?: string }
            | undefined;
          const text = typeof msg?.content === "string" ? msg.content.trim() : "";
          output = text
            || (typeof msg?.reasoning_content === "string" ? msg.reasoning_content.trim() : "");
        } else {
          const response = await client.completions.create({
            model,
            max_tokens: maxTokens,
            prompt,
          } as never);
          output = (response.choices?.[0]?.text ?? "").trim();
        }

        if (!output) {
          continue;
        }
        if (this.modeHint !== mode) {
          this.modeHint = mode;
          this.logChat("info", `switched endpoint mode=${mode}`);
        }
        break;
      } catch (error) {
        errors.push(`${mode}: ${formatDetailedError(error)}`);
      }
    }

    if (!output) {
      this.logChat("warn", `${label} failed all_endpoints=${errors.join(" | ")}`);
    }
    return output;
  }

  private normalizeTaskExecutionSurface(value: unknown): TaskExecutionSurface {
    if (value === "coding_first" || value === "phone_first" || value === "hybrid") {
      return value;
    }
    return "hybrid";
  }

  private normalizeTaskExecutionPlan(value: Partial<TaskExecutionPlan> | null | undefined): TaskExecutionPlan {
    const surface = this.normalizeTaskExecutionSurface(value?.surface);
    const confidence =
      typeof value?.confidence === "number" && value.confidence >= 0 && value.confidence <= 1
        ? value.confidence
        : 0.5;
    const reason = typeof value?.reason === "string" && value.reason.trim()
      ? this.normalizeOneLine(value.reason).slice(0, 240)
      : "model_execution_surface_fallback";
    return {
      surface,
      confidence,
      reason,
    };
  }

  private async planTaskExecutionWithModel(
    client: OpenAI,
    model: string,
    maxTokens: number,
    task: string,
  ): Promise<TaskExecutionPlan> {
    const prompt = [
      "Plan the initial execution surface for a dual-capability agent.",
      "The agent can use coding/runtime tools and Android phone-use tools.",
      "Output strict JSON only:",
      '{"surface":"coding_first|phone_first|hybrid","confidence":0-1,"reason":"..."}',
      "Rules:",
      "1) Decide from task intent and likely evidence location, not lexical keyword matching.",
      "2) surface=coding_first when first reliable evidence is likely in local runtime/CLI/workspace/logs/config/process state.",
      "3) surface=phone_first when first reliable evidence is likely on current phone UI/device app state.",
      "4) surface=hybrid when both surfaces are likely needed early or uncertainty is high.",
      "5) If uncertain, choose hybrid and lower confidence.",
      `Task: ${task}`,
    ].join("\n");

    const output = await this.callModelRaw(
      client,
      model,
      Math.min(maxTokens, 600),
      prompt,
      "task execution surface planning",
    );
    if (!output) {
      return this.normalizeTaskExecutionPlan(null);
    }
    const jsonText = extractJsonObjectText(output);
    try {
      const parsed = JSON.parse(jsonText) as Partial<TaskExecutionPlan>;
      return this.normalizeTaskExecutionPlan(parsed);
    } catch {
      return this.normalizeTaskExecutionPlan(null);
    }
  }

  async planTaskExecution(task: string): Promise<TaskExecutionPlan | null> {
    const normalizedTask = String(task || "").trim();
    if (!normalizedTask) {
      return null;
    }
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return null;
    }
    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    return this.planTaskExecutionWithModel(client, profile.model, profile.maxTokens, normalizedTask);
  }

  clear(chatId: number): void {
    this.history.delete(chatId);
    this.profileOnboarding.delete(chatId);
    this.bootstrapOnboarding.delete(chatId);
    this.pendingProfileUpdates.delete(chatId);
  }

  consumePendingProfileUpdate(
    chatId: number,
  ): { assistantName: string; locale: OnboardingLocale } | null {
    const payload = this.pendingProfileUpdates.get(chatId) ?? null;
    this.pendingProfileUpdates.delete(chatId);
    return payload;
  }

  isOnboardingPending(): boolean {
    return this.needsBootstrapOnboarding();
  }

  sessionResetPrompt(): string {
    const raw = this.readTextSafe(this.workspaceFilePath(BARE_SESSION_RESET_TEMPLATE_FILE)).trim();
    if (!raw) {
      return DEFAULT_SESSION_RESET_PROMPT;
    }
    const enMatch = raw.match(/(?:^|\n)##\s*en\s*\n([\s\S]*?)(?=\n##\s*\w+\s*\n|$)/i);
    if (enMatch?.[1]?.trim()) {
      return enMatch[1].replace(/\n{3,}/g, "\n\n").trim();
    }
    const zhMatch = raw.match(/(?:^|\n)##\s*zh\s*\n([\s\S]*?)(?=\n##\s*\w+\s*\n|$)/i);
    if (zhMatch?.[1]?.trim()) {
      return zhMatch[1].replace(/\n{3,}/g, "\n\n").trim();
    }
    return raw.replace(/\n{3,}/g, "\n\n").trim() || DEFAULT_SESSION_RESET_PROMPT;
  }

  private workspaceFilePath(name: string): string {
    return path.join(this.config.workspaceDir, name);
  }

  private profileFilePath(name: "IDENTITY.md" | "USER.md"): string {
    return this.workspaceFilePath(name);
  }

  private readTextSafe(filePath: string): string {
    try {
      if (!fs.existsSync(filePath)) {
        return "";
      }
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  private writeTextSafe(filePath: string, content: string): void {
    fs.writeFileSync(filePath, `${content.trim()}\n`, "utf-8");
  }

  private normalizeOneLine(input: string): string {
    return input.replace(/\s+/g, " ").trim();
  }

  private normalizeMultiline(input: string): string {
    return String(input || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private normalizeAssistantName(input: string): string {
    return this.normalizeOneLine(input)
      .replace(/[。！？.!?]+$/g, "")
      .replace(/\s*[?!.]+\s*$/i, "")
      .trim();
  }

  private readStringOrFallback(value: unknown, fallback: string): string {
    if (typeof value !== "string") {
      return fallback;
    }
    const normalized = value.trim();
    return normalized || fallback;
  }

  private readQuestionOrFallback(
    questions: Record<string, unknown>,
    step: OnboardingStep,
    fallback: string,
  ): string {
    const key = `step${step}`;
    if (typeof questions[key] === "string") {
      return this.readStringOrFallback(questions[key], fallback);
    }
    if (typeof questions[String(step)] === "string") {
      return this.readStringOrFallback(questions[String(step)], fallback);
    }
    return fallback;
  }

  private mergePersonaPresets(
    value: unknown,
    fallback: OnboardingPreset[],
  ): OnboardingPreset[] {
    if (!Array.isArray(value)) {
      return fallback;
    }
    const parsed = value
      .map((item) => {
        if (!isObject(item)) {
          return null;
        }
        const presetValue = this.readStringOrFallback(item.value, "");
        if (!presetValue) {
          return null;
        }
        const aliasesRaw = Array.isArray(item.aliases)
          ? item.aliases.map((alias) => this.readStringOrFallback(alias, "")).filter(Boolean)
          : [];
        const aliases = Array.from(
          new Set([presetValue, ...aliasesRaw].map((alias) => alias.toLowerCase())),
        );
        return {
          value: presetValue,
          aliases,
        };
      })
      .filter((item): item is OnboardingPreset => Boolean(item));
    if (parsed.length === 0) {
      return fallback;
    }
    return parsed;
  }

  private mergeTemplateCopy(
    raw: unknown,
    fallback: OnboardingTemplateCopy,
  ): OnboardingTemplateCopy {
    if (!isObject(raw)) {
      return fallback;
    }

    const rawQuestions = isObject(raw.questions) ? raw.questions : {};
    const rawChangeTemplates = isObject(raw.changeTemplates)
      ? raw.changeTemplates
      : {};
    const rawFallbacks = isObject(raw.fallbacks) ? raw.fallbacks : {};

    return {
      questions: {
        1: this.readQuestionOrFallback(rawQuestions, 1, fallback.questions[1]),
        2: this.readQuestionOrFallback(rawQuestions, 2, fallback.questions[2]),
        3: this.readQuestionOrFallback(rawQuestions, 3, fallback.questions[3]),
      },
      emptyAnswer: this.readStringOrFallback(raw.emptyAnswer, fallback.emptyAnswer),
      onboardingSaved: this.readStringOrFallback(raw.onboardingSaved, fallback.onboardingSaved),
      noChange: this.readStringOrFallback(raw.noChange, fallback.noChange),
      updated: this.readStringOrFallback(raw.updated, fallback.updated),
      changeJoiner: this.readStringOrFallback(raw.changeJoiner, fallback.changeJoiner),
      changeTemplates: {
        userPreferredAddress: this.readStringOrFallback(
          rawChangeTemplates.userPreferredAddress,
          fallback.changeTemplates.userPreferredAddress,
        ),
        assistantName: this.readStringOrFallback(
          rawChangeTemplates.assistantName,
          fallback.changeTemplates.assistantName,
        ),
        assistantPersona: this.readStringOrFallback(
          rawChangeTemplates.assistantPersona,
          fallback.changeTemplates.assistantPersona,
        ),
      },
      fallbacks: {
        user: this.readStringOrFallback(rawFallbacks.user, fallback.fallbacks.user),
        assistant: this.readStringOrFallback(
          rawFallbacks.assistant,
          fallback.fallbacks.assistant,
        ),
        persona: this.readStringOrFallback(rawFallbacks.persona, fallback.fallbacks.persona),
      },
      personaPresets: this.mergePersonaPresets(raw.personaPresets, fallback.personaPresets),
    };
  }

  private resolveOnboardingTemplateSource(parsed: unknown): Record<string, unknown> {
    if (!isObject(parsed)) {
      return {};
    }
    const hasDirectTemplateFields = isObject(parsed.questions)
      || typeof parsed.emptyAnswer === "string"
      || typeof parsed.onboardingSaved === "string"
      || typeof parsed.noChange === "string"
      || typeof parsed.updated === "string"
      || typeof parsed.changeJoiner === "string"
      || isObject(parsed.changeTemplates)
      || isObject(parsed.fallbacks)
      || Array.isArray(parsed.personaPresets);
    if (hasDirectTemplateFields) {
      return parsed;
    }

    const rawLocales = isObject(parsed.locales) ? parsed.locales : {};
    if (isObject(rawLocales.en)) {
      return rawLocales.en;
    }
    if (isObject(rawLocales.zh)) {
      return rawLocales.zh;
    }
    return {};
  }

  private loadOnboardingTemplate(): OnboardingTemplate {
    const filePath = this.workspaceFilePath(PROFILE_ONBOARDING_TEMPLATE_FILE);
    let mtimeMs = -1;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return DEFAULT_ONBOARDING_TEMPLATE;
      }
      mtimeMs = stat.mtimeMs;
    } catch {
      return DEFAULT_ONBOARDING_TEMPLATE;
    }

    if (this.onboardingTemplateCache && this.onboardingTemplateCache.mtimeMs === mtimeMs) {
      return this.onboardingTemplateCache.template;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(this.readTextSafe(filePath));
    } catch {
      parsed = null;
    }

    const rawTemplate = this.resolveOnboardingTemplateSource(parsed);
    const merged: OnboardingTemplate = {
      version:
        typeof (parsed as { version?: unknown })?.version === "number"
          ? (parsed as { version: number }).version
          : DEFAULT_ONBOARDING_TEMPLATE.version,
      ...this.mergeTemplateCopy(rawTemplate, DEFAULT_ONBOARDING_TEMPLATE),
    };
    this.onboardingTemplateCache = {
      mtimeMs,
      template: merged,
    };
    return merged;
  }

  private onboardingTemplateCopy(): OnboardingTemplateCopy {
    return this.loadOnboardingTemplate();
  }

  private renderTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => values[key] ?? "");
  }

  private extractBulletValue(content: string, key: string): string {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^-\\s*${escaped}\\s*:\\s*(.*)$`, "i");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    for (const line of lines) {
      const match = line.match(regex);
      if (!match) {
        continue;
      }
      return this.normalizeOneLine(match[1] ?? "");
    }
    return "";
  }

  private isPlaceholderValue(value: string, extra: string[] = []): boolean {
    const normalized = this.normalizeOneLine(value).toLowerCase();
    if (!normalized) {
      return true;
    }
    const placeholders = new Set([
      "unknown",
      "tbd",
      "todo",
      "null",
      "n/a",
      "none",
      "placeholder",
      ...extra.map((v) => v.toLowerCase()),
    ]);
    return placeholders.has(normalized);
  }

  private needsIdentityOnboarding(): boolean {
    const content = this.readTextSafe(this.profileFilePath("IDENTITY.md")).trim();
    if (!content) {
      return true;
    }
    const name = this.extractBulletValue(content, "Name");
    if (this.isPlaceholderValue(name, ["openpocket"])) {
      return true;
    }
    const persona = this.extractBulletValue(content, "Persona");
    if (this.isPlaceholderValue(persona)) {
      return true;
    }
    return false;
  }

  private needsUserOnboarding(): boolean {
    const content = this.readTextSafe(this.profileFilePath("USER.md")).trim();
    if (!content) {
      return true;
    }
    const preferred = this.extractBulletValue(content, "Preferred form of address")
      || this.extractBulletValue(content, "What to call them");
    if (this.isPlaceholderValue(preferred)) {
      return true;
    }
    return false;
  }

  private needsProfileOnboarding(): boolean {
    // Run onboarding if either profile file is missing critical identity fields.
    return this.needsIdentityOnboarding() || this.needsUserOnboarding();
  }

  private bootstrapFilePath(): string {
    return this.workspaceFilePath(DEFAULT_BOOTSTRAP_FILENAME);
  }

  private hasBootstrapOnboardingFile(): boolean {
    return fs.existsSync(this.bootstrapFilePath());
  }

  private needsBootstrapOnboarding(): boolean {
    if (this.hasBootstrapOnboardingFile()) {
      return true;
    }
    if (this.needsProfileOnboarding()) {
      return true;
    }
    // Workspace onboarding not yet marked as completed — treat as pending.
    if (!isWorkspaceOnboardingCompleted(this.config.workspaceDir)) {
      return true;
    }
    return false;
  }

  private isProfileSnapshotComplete(snapshot: ProfileSnapshot): boolean {
    return !this.isPlaceholderValue(snapshot.userPreferredAddress, [this.pickFallback("user")])
      && !this.isPlaceholderValue(
        snapshot.assistantName,
        ["openpocket", this.pickFallback("assistant")],
      )
      && !this.isPlaceholderValue(snapshot.assistantPersona, [this.pickFallback("persona")]);
  }

  private applyModelProfilePatch(
    base: ProfileSnapshot,
    patch: BootstrapModelDecision["profile"] | undefined,
  ): ProfileSnapshot {
    if (!patch) {
      return base;
    }
    const next: ProfileSnapshot = { ...base };
    if (typeof patch.userPreferredAddress === "string" && this.normalizeOneLine(patch.userPreferredAddress)) {
      next.userPreferredAddress = this.normalizeOneLine(patch.userPreferredAddress);
    }
    if (typeof patch.assistantName === "string" && this.normalizeOneLine(patch.assistantName)) {
      next.assistantName = this.normalizeAssistantName(patch.assistantName);
    }
    if (typeof patch.assistantPersona === "string" && this.normalizeOneLine(patch.assistantPersona)) {
      next.assistantPersona = this.resolvePersonaAnswer(this.normalizeOneLine(patch.assistantPersona));
    }
    if (typeof patch.userName === "string" && this.normalizeOneLine(patch.userName)) {
      next.userName = this.normalizeOneLine(patch.userName);
    }
    if (typeof patch.timezone === "string" && this.normalizeOneLine(patch.timezone)) {
      next.timezone = this.normalizeOneLine(patch.timezone);
    }
    if (typeof patch.languagePreference === "string" && this.normalizeOneLine(patch.languagePreference)) {
      next.languagePreference = this.normalizeOneLine(patch.languagePreference);
    }
    return next;
  }

  private detectOnboardingLocale(_input: string): OnboardingLocale {
    return "en";
  }

  private questionForStep(step: OnboardingStep): string {
    return this.onboardingTemplateCopy().questions[step];
  }

  private pickFallback(key: "user" | "assistant" | "persona"): string {
    const fallbacks = this.onboardingTemplateCopy().fallbacks;
    if (key === "user") return fallbacks.user;
    if (key === "assistant") return fallbacks.assistant;
    return fallbacks.persona;
  }

  private completeProfileWithFallbacks(snapshot: ProfileSnapshot): ProfileSnapshot {
    const next: ProfileSnapshot = { ...snapshot };
    if (this.isPlaceholderValue(next.userPreferredAddress, [this.pickFallback("user")])) {
      next.userPreferredAddress = this.pickFallback("user");
    }
    if (
      this.isPlaceholderValue(
        next.assistantName,
        ["openpocket", this.pickFallback("assistant")],
      )
    ) {
      next.assistantName = this.pickFallback("assistant");
    }
    if (this.isPlaceholderValue(next.assistantPersona, [this.pickFallback("persona")])) {
      next.assistantPersona = this.pickFallback("persona");
    }
    return next;
  }

  private extractByPatterns(input: string, patterns: RegExp[]): string {
    for (const pattern of patterns) {
      const match = input.match(pattern);
      if (!match?.[1]) {
        continue;
      }
      const value = this.normalizeOneLine(match[1].replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""));
      if (value) {
        return value;
      }
    }
    return "";
  }

  private parseOnboardingFields(input: string): Partial<Pick<ProfileOnboardingState, "userPreferredAddress" | "assistantName" | "assistantPersona">> {
    const out: Partial<Pick<ProfileOnboardingState, "userPreferredAddress" | "assistantName" | "assistantPersona">> = {};
    const normalized = this.normalizeOneLine(input);
    if (!normalized) {
      return out;
    }

    const userPreferredAddress = this.extractByPatterns(normalized, [
      /(?:call me|address me as|you can call me)\s+([^,.;\n]+)/i,
    ]);
    const assistantName = this.extractByPatterns(normalized, [
      /(?:call you|your name is|i want to call you)\s+([^,.;\n]+)/i,
      /(?:rename yourself to|change your name to|set your name to|call yourself)\s+([^,.;\n]+)/i,
    ]);
    const assistantPersona = this.extractByPatterns(normalized, [
      /(?:\bpersona\b)\s*[:]\s*([^.;\n]+)/i,
      /(?:\bmy persona\b|\byour persona\b|\byour tone\b)\s*(?:is|should be|:)\s*([^.;\n]+)/i,
    ]);

    if (userPreferredAddress) {
      out.userPreferredAddress = userPreferredAddress;
    }
    if (assistantName) {
      out.assistantName = this.normalizeAssistantName(assistantName);
    }
    if (assistantPersona) {
      out.assistantPersona = assistantPersona;
    }

    return out;
  }

  private looksLikeTaskInstruction(input: string): boolean {
    const t = this.normalizeOneLine(input).toLowerCase();
    if (!t) {
      return false;
    }
    return /\b(open|launch|install|download|search|swipe|tap|click|type|go to|login|log in|sign in|use|start|check|query|look up|find)\b/.test(t);
  }

  private hasConcreteExecutableTarget(input: string): boolean {
    const normalized = this.normalizeOneLine(input);
    const lower = normalized.toLowerCase();
    return /(?:^|[\s"'`])(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}(?:$|[\s"'`])/i.test(normalized)
      || /\bcom\.[a-z0-9_.]+\b/i.test(lower)
      || /`[^`]+`/.test(normalized)
      || /\b(?:adb|npm|pnpm|yarn|gradle|python3?|node|shell|bash|keycode_)\b/i.test(lower);
  }

  private hasExplicitExecutionOutputConstraint(input: string): boolean {
    const normalized = this.normalizeOneLine(input);
    return /(with content|write.*file|print|output|install.*emulator|build.*apk)/i
      .test(normalized);
  }

  private looksLikeCapabilityQuestionOnly(input: string): boolean {
    const normalized = this.normalizeOneLine(input);
    if (!normalized) {
      return false;
    }
    const lower = normalized.toLowerCase();
    const startsWithCapabilityLead = /^(?:can you|could you|would you|are you able to|do you know how to)\s*/i
      .test(normalized);
    if (!startsWithCapabilityLead) {
      return false;
    }
    const hasQuestionTone = /[?？]$/.test(normalized)
      || /(can you|could you|would you|possible)/i.test(lower);
    if (!hasQuestionTone) {
      return false;
    }
    const hasImmediateCue = /(for me|go ahead|please)/i.test(normalized);
    return !hasImmediateCue
      && !this.hasConcreteExecutableTarget(normalized)
      && !this.hasExplicitExecutionOutputConstraint(normalized);
  }

  private looksLikeExecutableIntent(input: string): boolean {
    const normalized = this.normalizeOneLine(input);
    if (!normalized) {
      return false;
    }
    const lower = normalized.toLowerCase();
    const hasExecutionVerb = /\b(create|write|edit|modify|build|compile|run|execute|install|open|launch|start|fix|implement|generate|code|script|deploy)\b/i
      .test(lower);
    if (!hasExecutionVerb) {
      return false;
    }
    const hasImperativeCue = /^(?:please|pls|open|launch|start|run|create|write|build|install|execute)/i
      .test(normalized)
      || /(for me|go ahead)/i.test(normalized);
    const hasConcreteTarget = this.hasConcreteExecutableTarget(normalized);
    const hasOutputConstraint = this.hasExplicitExecutionOutputConstraint(normalized);
    if (this.looksLikeCapabilityQuestionOnly(normalized) && !hasImperativeCue && !hasConcreteTarget && !hasOutputConstraint) {
      return false;
    }
    return hasImperativeCue || hasConcreteTarget || hasOutputConstraint;
  }

  private scheduleTimezoneForInput(): string {
    const snapshot = this.readProfileSnapshot();
    const configured = this.normalizeOneLine(snapshot.timezone ?? "");
    if (configured) {
      return configured;
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  private personaPresetFromAnswer(answer: string): string {
    const normalized = this.normalizeOneLine(answer).toLowerCase();
    for (const preset of this.onboardingTemplateCopy().personaPresets) {
      if (preset.aliases.includes(normalized)) {
        return preset.value;
      }
    }
    return "";
  }

  private resolvePersonaAnswer(answer: string): string {
    const preset = this.personaPresetFromAnswer(answer);
    if (preset) {
      return preset;
    }
    return answer;
  }

  private applyThreePartFallback(state: ProfileOnboardingState, answer: string): void {
    if (state.step !== 1) {
      return;
    }
    if (state.userPreferredAddress || state.assistantName || state.assistantPersona) {
      return;
    }
    const parts = answer
      .split(/[,\n;；|]/)
      .map((v) => this.normalizeOneLine(v))
      .filter(Boolean);
    if (parts.length !== 3) {
      return;
    }
    if (parts.some((part) => part.length > 80)) {
      return;
    }
    [state.userPreferredAddress, state.assistantName, state.assistantPersona] = parts;
  }

  private firstMissingStep(state: ProfileOnboardingState): OnboardingStep | null {
    if (!state.userPreferredAddress) return 1;
    if (!state.assistantName) return 2;
    if (!state.assistantPersona) return 3;
    return null;
  }

  private firstMissingSnapshotStep(
    snapshot: ProfileSnapshot,
  ): OnboardingStep | null {
    if (this.isPlaceholderValue(snapshot.userPreferredAddress, [this.pickFallback("user")])) {
      return 1;
    }
    if (
      this.isPlaceholderValue(
        snapshot.assistantName,
        ["openpocket", this.pickFallback("assistant")],
      )
    ) {
      return 2;
    }
    if (this.isPlaceholderValue(snapshot.assistantPersona, [this.pickFallback("persona")])) {
      return 3;
    }
    return null;
  }

  private bootstrapFallbackQuestion(snapshot: ProfileSnapshot): string {
    const step = this.firstMissingSnapshotStep(snapshot);
    if (step === null) {
      return "I already have your onboarding profile. Tell me what you want to do next.";
    }
    return this.questionForStep(step);
  }

  private readBootstrapGuide(): string {
    const bootstrap = this.readTextSafe(this.bootstrapFilePath()).trim();
    if (bootstrap) {
      return bootstrap;
    }
    return [
      "# BOOTSTRAP",
      "",
      "Collect onboarding profile naturally:",
      "1) how to address the user",
      "2) what name the user gives the assistant",
      "3) preferred assistant persona/tone",
      "Persist to IDENTITY.md and USER.md once done.",
    ].join("\n");
  }

  private buildBootstrapOnboardingPrompt(
    state: BootstrapOnboardingState,
    inputText: string,
  ): string {
    const turns = state.turns
      .slice(-16)
      .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
      .join("\n");
    const identity = this.readTextSafe(this.profileFilePath("IDENTITY.md")).trim() || "(empty)";
    const user = this.readTextSafe(this.profileFilePath("USER.md")).trim() || "(empty)";
    const soul = this.readTextSafe(this.workspaceFilePath("SOUL.md")).trim() || "(empty)";

    return [
      "You are OpenPocket onboarding conductor.",
      "Follow BOOTSTRAP guide and continue a natural onboarding conversation.",
      "Ask focused questions and avoid robotic tone.",
      "If user already provided enough info, confirm briefly and complete onboarding.",
      "Output strict JSON only, no markdown:",
      "{",
      '  "reply": "<assistant message to user>",',
      '  "profile": {',
      '    "userPreferredAddress": "<string optional>",',
      '    "assistantName": "<string optional>",',
      '    "assistantPersona": "<string optional>",',
      '    "userName": "<string optional>",',
      '    "timezone": "<string optional>",',
      '    "languagePreference": "<string optional>"',
      "  },",
      '  "writeProfile": true|false,',
      '  "onboardingComplete": true|false',
      "}",
      "Rules:",
      "1) Keep reply concise and in user language.",
      "2) Offer options/examples when asking about persona/tone.",
      "3) Mark onboardingComplete=true only when required fields are all available.",
      "4) Required fields: userPreferredAddress, assistantName, assistantPersona.",
      "5) Do not force a rigid fixed-question script; adapt naturally to what user already provided.",
      `Locale hint: ${state.locale}`,
      `Current profile snapshot: ${JSON.stringify(state.profile, null, 2)}`,
      "",
      "BOOTSTRAP.md:",
      this.readBootstrapGuide(),
      "",
      "SOUL.md:",
      soul,
      "",
      "IDENTITY.md:",
      identity,
      "",
      "USER.md:",
      user,
      "",
      "Conversation so far:",
      turns || "(none)",
      "",
      `Latest user message: ${inputText}`,
    ].join("\n");
  }

  private trimForPrompt(input: string, maxChars: number): string {
    const normalized = this.normalizeOneLine(input);
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private compactProgressForPrompt(progress: AgentProgressUpdate | null): Record<string, unknown> | null {
    if (!progress) {
      return null;
    }
    return {
      step: progress.step,
      maxSteps: progress.maxSteps,
      currentApp: this.trimForPrompt(progress.currentApp || "unknown", 120),
      actionType: this.trimForPrompt(progress.actionType || "unknown", 80),
      message: this.trimForPrompt(progress.message || "", 220),
      thought: this.trimForPrompt(progress.thought || "", 220),
      screenshotPath: progress.screenshotPath ?? null,
    };
  }

  private compactEvidenceSnapshotForPrompt(snapshot: TaskJournalSnapshot | null): Record<string, unknown> | null {
    if (!snapshot) {
      return null;
    }

    const compactTodo = (item: TaskJournalSnapshot["todos"][number]) => ({
      id: this.trimForPrompt(item.id, 64),
      text: this.trimForPrompt(item.text, 180),
      status: item.status,
      tags: item.tags?.slice(0, 6) ?? undefined,
    });

    const compactEvidence = (item: TaskJournalSnapshot["evidence"][number]) => ({
      id: this.trimForPrompt(item.id, 64),
      kind: this.trimForPrompt(item.kind, 64),
      title: this.trimForPrompt(item.title, 220),
      fields: item.fields ?? undefined,
      source: item.source ?? undefined,
      confidence: item.confidence ?? undefined,
    });

    const compactArtifact = (item: TaskJournalSnapshot["artifacts"][number]) => ({
      id: this.trimForPrompt(item.id, 64),
      kind: this.trimForPrompt(item.kind, 64),
      value: this.trimForPrompt(item.value, 220),
      description: item.description ? this.trimForPrompt(item.description, 220) : undefined,
    });

    return {
      version: snapshot.version,
      task: this.trimForPrompt(snapshot.task, 240),
      runId: this.trimForPrompt(snapshot.runId, 64),
      updatedAt: this.trimForPrompt(snapshot.updatedAt, 48),
      todos: snapshot.todos.slice(-10).map(compactTodo),
      evidence: snapshot.evidence.slice(-20).map(compactEvidence),
      artifacts: snapshot.artifacts.slice(-10).map(compactArtifact),
      progress: snapshot.progress,
      completion: snapshot.completion,
    };
  }

  private readTaskProgressReporterGuide(): string {
    const guide = this.readTextSafe(this.workspaceFilePath(TASK_PROGRESS_REPORTER_TEMPLATE_FILE)).trim();
    if (guide) {
      return guide;
    }
    return [
      "# TASK_PROGRESS_REPORTER",
      "",
      "Decide whether user should be notified now.",
      "- notify=false when still repeating on same screen without clear user-visible progress.",
      "- notify=true when app/screen changed, checkpoint reached, auth required, or blocked by error.",
      "- If notify=true, write concise conversational status.",
      "- Avoid step counters unless user explicitly requests telemetry.",
    ].join("\n");
  }

  private readTaskOutcomeReporterGuide(): string {
    const guide = this.readTextSafe(this.workspaceFilePath(TASK_OUTCOME_REPORTER_TEMPLATE_FILE)).trim();
    if (guide) {
      return guide;
    }
    return [
      "# TASK_OUTCOME_REPORTER",
      "",
      "Turn raw outcome into user-facing final answer.",
      "- Lead with concrete result details.",
      "- Avoid boilerplate status text when data is available.",
      "- If reusable artifacts exist, mention saved reuse asset briefly.",
    ].join("\n");
  }

  private buildTaskProgressNarrationPrompt(input: TaskProgressNarrationInput): string {
    const payload = {
      task: this.trimForPrompt(input.task, 240),
      localeHint: input.locale,
      skippedStepsSinceLastNotification: input.skippedSteps,
      lastNotifiedProgress: this.compactProgressForPrompt(input.lastNotifiedProgress),
      recentProgress: input.recentProgress.slice(-6).map((item) => this.compactProgressForPrompt(item)),
      currentProgress: this.compactProgressForPrompt(input.progress),
    };
    const identity = this.readTextSafe(this.profileFilePath("IDENTITY.md")).trim() || "(empty)";
    const user = this.readTextSafe(this.profileFilePath("USER.md")).trim() || "(empty)";
    const soul = this.readTextSafe(this.workspaceFilePath("SOUL.md")).trim() || "(empty)";

    return [
      "You are OpenPocket task-progress narrator.",
      "Decide whether to notify user now. Return strict JSON only:",
      '{"notify": true|false, "message":"...", "reason":"..."}',
      "Rules:",
      "1) notify=false when there is no clear, user-visible progress yet.",
      "2) notify=true when meaningful progress happened (page transition, key checkpoint, auth blocker, error, or completion signal).",
      "3) If notify=true, message must be concise, natural language, and in locale hint.",
      "4) Do not include step counters (8/50, step 8, progress 8) unless user explicitly asked for it.",
      "5) Talk like a helpful friend, not a robot. Vary your phrasing naturally.",
      "6) Never expose internal mechanics: no tool names, action types, model names, JSON, log lines, file paths, or debug output.",
      "7) Never expose Android package names or bundle identifiers (for example com.twitter.android). Use a natural app name only if already obvious; otherwise say 'the current app' or describe the screen generically.",
      "8) Never echo back raw 'thought' or 'observation' text from the progress context. Rephrase in your own words.",
      "9) If notify=false, message must be empty string.",
      "",
      "TASK_PROGRESS_REPORTER.md:",
      this.readTaskProgressReporterGuide(),
      "",
      "SOUL.md:",
      this.trimForPrompt(soul, 1600),
      "",
      "IDENTITY.md:",
      this.trimForPrompt(identity, 1200),
      "",
      "USER.md:",
      this.trimForPrompt(user, 1200),
      "",
      "Progress context JSON:",
      JSON.stringify(payload, null, 2),
    ].join("\n");
  }

  private buildTaskOutcomeNarrationPrompt(input: TaskOutcomeNarrationInput): string {
    const payload = {
      task: this.trimForPrompt(input.task, 300),
      localeHint: input.locale,
      ok: input.ok,
      rawResult: this.trimForPrompt(input.rawResult, 1200),
      evidenceSnapshot: this.compactEvidenceSnapshotForPrompt(input.evidenceSnapshot),
      recentProgress: input.recentProgress.slice(-6).map((item) => this.compactProgressForPrompt(item)),
      artifacts: {
        skillGenerated: Boolean(input.skillPath),
        scriptGenerated: Boolean(input.scriptPath),
      },
    };
    const soul = this.readTextSafe(this.workspaceFilePath("SOUL.md")).trim() || "(empty)";
    const identity = this.readTextSafe(this.profileFilePath("IDENTITY.md")).trim() || "(empty)";
    const user = this.readTextSafe(this.profileFilePath("USER.md")).trim() || "(empty)";

    return [
      "You are OpenPocket final outcome narrator.",
      "Convert raw task outcome to user-facing answer.",
      "Return strict JSON only:",
      '{"message":"..."}',
      "Rules:",
      "1) Lead with concrete findings/result details, not status boilerplate.",
      "2) Prefer evidenceSnapshot for concrete listings/prices/options when present. Use recentProgress only as backup context.",
      "3) If success and rawResult has data (numbers/facts), surface those first.",
      "4) Do not start with 'Task completed' unless no better data exists.",
      "5) If failure, explain key reason and one practical next move.",
      "6) If reusable artifacts were generated, mention reuse in one short natural sentence.",
      "7) Use locale hint language.",
      "8) Keep concise and natural; do not expose internal logs.",
      "9) Preserve line breaks. Use short bullets when listing multiple stores/options.",
      "10) For shopping/comparison tasks, list one seller per line in this shape:",
      '   "- Seller — price — stock — link"',
      "11) If you do not have a reliable direct link, explicitly say 'link unavailable'. Never invent links.",
      "",
      "TASK_OUTCOME_REPORTER.md:",
      this.readTaskOutcomeReporterGuide(),
      "",
      "SOUL.md:",
      this.trimForPrompt(soul, 1200),
      "",
      "IDENTITY.md:",
      this.trimForPrompt(identity, 1000),
      "",
      "USER.md:",
      this.trimForPrompt(user, 1000),
      "",
      "Outcome context JSON:",
      JSON.stringify(payload, null, 2),
    ].join("\n");
  }

  private capabilityLabel(capability: string | null | undefined): string {
    const normalized = String(capability || "").trim().toLowerCase();
    if (!normalized) {
      return "authorization";
    }
    const enMap: Record<string, string> = {
      oauth: "login authorization",
      permission: "permission authorization",
      camera: "camera authorization",
      microphone: "microphone authorization",
      location: "location authorization",
      contacts: "contacts authorization",
      nfc: "NFC authorization",
      sms: "SMS/code authorization",
      "2fa": "2FA authorization",
      otp: "OTP authorization",
      email: "email-code authorization",
      files: "file-access authorization",
      payment: "payment authorization",
      unknown: "authorization",
    };
    return enMap[normalized] || "authorization";
  }

  private buildEscalationNarrationPrompt(input: EscalationNarrationInput): string {
    const payload = {
      event: input.event,
      localeHint: input.locale,
      task: this.trimForPrompt(input.task, 260),
      capability: this.trimForPrompt(String(input.capability || ""), 80),
      capabilityLabel: this.capabilityLabel(input.capability),
      currentApp: this.trimForPrompt(String(input.currentApp || ""), 140),
      instruction: this.trimForPrompt(String(input.instruction || ""), 360),
      reason: this.trimForPrompt(String(input.reason || ""), 280),
      question: this.trimForPrompt(String(input.question || ""), 260),
      options: (input.options || []).slice(0, 8).map((item) => this.trimForPrompt(item, 100)),
      hasWebLink: Boolean(input.hasWebLink),
      isCodeFlow: Boolean(input.isCodeFlow),
      includeLocalSecurityAssurance: Boolean(input.includeLocalSecurityAssurance),
    };
    const identity = this.readTextSafe(this.profileFilePath("IDENTITY.md")).trim() || "(empty)";
    const user = this.readTextSafe(this.profileFilePath("USER.md")).trim() || "(empty)";
    const soul = this.readTextSafe(this.workspaceFilePath("SOUL.md")).trim() || "(empty)";

    return [
      "You are OpenPocket escalation narrator.",
      "Write the user-facing interruption message when automation asks for human input.",
      "Return strict JSON only:",
      '{"message":"..."}',
      "Rules:",
      "1) Keep it concise, natural, and conversational (2-4 short sentences).",
      "2) Lead with what user should do now.",
      "3) Do NOT use rigid labels like 'Instruction:', 'Reason:', 'Request ID:', 'Current app:'.",
      "4) Never expose Android package names or bundle identifiers (for example com.twitter.android). Use a natural app name only if already obvious; otherwise describe it generically.",
      "5) Mention current app only when it is available and meaningful.",
      "6) If includeLocalSecurityAssurance=true, include one short reassurance sentence:",
      "   relay is local on user's machine, channel is private/encrypted, no centralized OpenPocket relay stores credentials.",
      "7) event=human_auth: ask user to open link and approve/reject, unless link unavailable.",
      "8) For human_auth with a web link, do NOT ask user to send an extra confirmation message in Telegram.",
      "9) event=user_decision: ask user to reply with an option clearly and briefly.",
      "10) event with code flow should mention user can reply code directly in Telegram.",
      "11) Use locale hint language and avoid unnecessary long context copy.",
      "",
      "SOUL.md:",
      this.trimForPrompt(soul, 1200),
      "",
      "IDENTITY.md:",
      this.trimForPrompt(identity, 1000),
      "",
      "USER.md:",
      this.trimForPrompt(user, 1000),
      "",
      "Escalation context JSON:",
      JSON.stringify(payload, null, 2),
    ].join("\n");
  }

  private async requestBootstrapOnboardingDecision(
    client: OpenAI,
    model: string,
    maxTokens: number,
    prompt: string,
  ): Promise<BootstrapModelDecision | null> {
    const output = await this.callModelRaw(client, model, Math.min(maxTokens, 1024), prompt, "bootstrap onboarding");
    if (!output) {
      return null;
    }

    const jsonText = extractJsonObjectText(output);
    try {
      const parsed = JSON.parse(jsonText) as Partial<BootstrapModelDecision>;
      const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
      if (!reply) {
        return null;
      }
      return {
        reply,
        profile: isObject(parsed.profile) ? {
          userPreferredAddress:
            typeof parsed.profile.userPreferredAddress === "string"
              ? parsed.profile.userPreferredAddress
              : undefined,
          assistantName:
            typeof parsed.profile.assistantName === "string"
              ? parsed.profile.assistantName
              : undefined,
          assistantPersona:
            typeof parsed.profile.assistantPersona === "string"
              ? parsed.profile.assistantPersona
              : undefined,
          userName:
            typeof parsed.profile.userName === "string"
              ? parsed.profile.userName
              : undefined,
          timezone:
            typeof parsed.profile.timezone === "string"
              ? parsed.profile.timezone
              : undefined,
          languagePreference:
            typeof parsed.profile.languagePreference === "string"
              ? parsed.profile.languagePreference
              : undefined,
        } : undefined,
        writeProfile: Boolean(parsed.writeProfile),
        onboardingComplete: Boolean(parsed.onboardingComplete),
      };
    } catch {
      return null;
    }
  }

  private async requestTaskProgressNarrationDecision(
    client: OpenAI,
    model: string,
    maxTokens: number,
    prompt: string,
  ): Promise<TaskProgressNarrationDecision | null> {
    const output = await this.callModelRaw(client, model, Math.min(maxTokens, 800), prompt, "progress narration");
    if (!output) {
      return null;
    }

    const jsonText = extractJsonObjectText(output);
    try {
      const parsed = JSON.parse(jsonText) as {
        notify?: unknown;
        message?: unknown;
        reason?: unknown;
      };
      const notify = Boolean(parsed.notify);
      const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
      return {
        notify,
        message,
        reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
      };
    } catch {
      return null;
    }
  }

  private async requestTaskOutcomeNarration(
    client: OpenAI,
    model: string,
    maxTokens: number,
    prompt: string,
  ): Promise<string | null> {
    const output = await this.callModelRaw(client, model, Math.min(maxTokens, 1024), prompt, "task outcome narration");
    if (!output) {
      return null;
    }

    const jsonText = extractJsonObjectText(output);
    try {
      const parsed = JSON.parse(jsonText) as { message?: unknown };
      if (typeof parsed.message !== "string") {
        return null;
      }
      const message = parsed.message.trim();
      return message || null;
    } catch {
      return null;
    }
  }

  private async requestEscalationNarration(
    client: OpenAI,
    model: string,
    maxTokens: number,
    prompt: string,
  ): Promise<string | null> {
    const output = await this.callModelRaw(client, model, Math.min(maxTokens, 800), prompt, "escalation narration");
    if (!output) {
      return null;
    }
    const jsonText = extractJsonObjectText(output);
    try {
      const parsed = JSON.parse(jsonText) as { message?: unknown };
      if (typeof parsed.message !== "string") {
        return null;
      }
      const message = parsed.message.trim();
      return message || null;
    } catch {
      return null;
    }
  }

  private buildIdentityFromAnswers(params: {
    assistantName: string;
    assistantPersona: string;
  }): string {
    return [
      "# IDENTITY",
      "",
      "## Agent Identity",
      "",
      `- Name: ${params.assistantName}`,
      "- Role: Android phone-use automation agent",
      `- Persona: ${params.assistantPersona}`,
      "- Primary objective: execute user tasks safely and efficiently",
      "",
      "## Behavioral Defaults",
      "",
      "- Language for model thought/action text: English",
      "- Planning style: sub-goal driven, one deterministic step at a time",
      "- Escalation trigger: request_human_auth when real-device authorization is required",
    ].join("\n");
  }

  private buildUserFromAnswers(params: {
    userPreferredAddress: string;
    assistantName: string;
    assistantPersona: string;
    userName?: string;
    timezone?: string;
    languagePreference?: string;
  }): string {
    return [
      "# USER",
      "",
      "Record user-specific preferences and constraints.",
      "",
      "## Profile",
      "",
      `- Name: ${params.userName ?? ""}`,
      `- Preferred form of address: ${params.userPreferredAddress}`,
      `- Timezone: ${params.timezone ?? ""}`,
      `- Language preference: ${params.languagePreference ?? ""}`,
      "",
      "## Interaction Preferences",
      "",
      "- Verbosity:",
      "- Risk tolerance:",
      "- Confirmation preference for external actions:",
      `- Preferred assistant name: ${params.assistantName}`,
      `- Preferred assistant persona: ${params.assistantPersona}`,
      "",
      "## Task Preferences",
      "",
      "- Preferred apps/services:",
      "- Avoided apps/services:",
      "- Recurring goals:",
      "",
      "## Notes",
      "",
      "- Add durable preferences here.",
      "- Keep sensitive details minimal.",
    ].join("\n");
  }

  private upsertBulletValue(content: string, key: string, value: string): string {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^-\\s*${escaped}\\s*:\\s*.*$`, "i");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!regex.test(lines[i])) {
        continue;
      }
      lines[i] = `- ${key}: ${value}`;
      return lines.join("\n");
    }
    const trimmed = lines.join("\n").trimEnd();
    if (!trimmed) {
      return `- ${key}: ${value}`;
    }
    return `${trimmed}\n- ${key}: ${value}`;
  }

  private readProfileSnapshot(): ProfileSnapshot {
    const identity = this.readTextSafe(this.profileFilePath("IDENTITY.md"));
    const user = this.readTextSafe(this.profileFilePath("USER.md"));

    const userPreferredAddressRaw =
      this.extractBulletValue(user, "Preferred form of address")
      || this.extractBulletValue(user, "What to call them");
    const assistantNameRaw =
      this.extractBulletValue(identity, "Name")
      || this.extractBulletValue(user, "Preferred assistant name");
    const assistantPersonaRaw =
      this.extractBulletValue(identity, "Persona")
      || this.extractBulletValue(user, "Preferred assistant persona");
    const userNameRaw = this.extractBulletValue(user, "Name");
    const timezoneRaw = this.extractBulletValue(user, "Timezone");
    const languagePreferenceRaw = this.extractBulletValue(user, "Language preference");

    return {
      userPreferredAddress: this.isPlaceholderValue(userPreferredAddressRaw)
        ? this.pickFallback("user")
        : userPreferredAddressRaw,
      assistantName: this.isPlaceholderValue(assistantNameRaw, ["openpocket"])
        ? this.pickFallback("assistant")
        : assistantNameRaw,
      assistantPersona: this.isPlaceholderValue(assistantPersonaRaw)
        ? this.pickFallback("persona")
        : assistantPersonaRaw,
      userName: this.isPlaceholderValue(userNameRaw) ? undefined : userNameRaw,
      timezone: this.isPlaceholderValue(timezoneRaw) ? undefined : timezoneRaw,
      languagePreference: this.isPlaceholderValue(languagePreferenceRaw) ? undefined : languagePreferenceRaw,
    };
  }

  private writeProfileSnapshot(snapshot: ProfileSnapshot): void {
    const identityPath = this.profileFilePath("IDENTITY.md");
    const userPath = this.profileFilePath("USER.md");

    const identityCurrent = this.readTextSafe(identityPath).trim();
    const identityBody = identityCurrent
      ? this.upsertBulletValue(
        this.upsertBulletValue(identityCurrent, "Name", snapshot.assistantName),
        "Persona",
        snapshot.assistantPersona,
      )
      : this.buildIdentityFromAnswers({
        assistantName: snapshot.assistantName,
        assistantPersona: snapshot.assistantPersona,
      });

    const userCurrent = this.readTextSafe(userPath).trim();
    const userBody = userCurrent
      ? (() => {
          let body = userCurrent;
          // Only upsert optional fields when they have a value to avoid blank bullet entries.
          if (snapshot.userName) {
            body = this.upsertBulletValue(body, "Name", snapshot.userName);
          }
          body = this.upsertBulletValue(body, "Preferred form of address", snapshot.userPreferredAddress);
          if (snapshot.timezone) {
            body = this.upsertBulletValue(body, "Timezone", snapshot.timezone);
          }
          if (snapshot.languagePreference) {
            body = this.upsertBulletValue(body, "Language preference", snapshot.languagePreference);
          }
          body = this.upsertBulletValue(body, "Preferred assistant name", snapshot.assistantName);
          body = this.upsertBulletValue(body, "Preferred assistant persona", snapshot.assistantPersona);
          return body;
        })()
      : this.buildUserFromAnswers({
        userName: snapshot.userName,
        userPreferredAddress: snapshot.userPreferredAddress,
        timezone: snapshot.timezone,
        languagePreference: snapshot.languagePreference,
        assistantName: snapshot.assistantName,
        assistantPersona: snapshot.assistantPersona,
      });

    this.writeTextSafe(identityPath, identityBody);
    this.writeTextSafe(userPath, userBody);
  }

  private completeWorkspaceBootstrap(snapshot: ProfileSnapshot): void {
    this.writeProfileSnapshot(snapshot);

    const bootstrapPath = this.bootstrapFilePath();
    if (fs.existsSync(bootstrapPath)) {
      try {
        fs.unlinkSync(bootstrapPath);
      } catch {
        // Ignore file deletion errors; profile is already persisted.
      }
    }
    markWorkspaceOnboardingCompleted(this.config.workspaceDir);
  }

  /**
   * Shared helper for the two fallback paths inside applyBootstrapOnboarding:
   * either complete onboarding (if profile is done) or ask the next question.
   */
  private tryCompleteOrFallback(
    chatId: number,
    state: BootstrapOnboardingState,
    locale: OnboardingLocale,
  ): string {
    if (this.isProfileSnapshotComplete(state.profile)) {
      this.completeWorkspaceBootstrap(state.profile);
      this.bootstrapOnboarding.delete(chatId);
      this.profileOnboarding.delete(chatId);
      this.pendingProfileUpdates.set(chatId, {
        assistantName: state.profile.assistantName,
        locale,
      });
      return this.renderTemplate(this.onboardingTemplateCopy().onboardingSaved, {
        userPreferredAddress: state.profile.userPreferredAddress,
        assistantName: state.profile.assistantName,
        assistantPersona: state.profile.assistantPersona,
      });
    }
    this.bootstrapOnboarding.set(chatId, {
      locale,
      profile: state.profile,
      turns: state.turns.slice(-20),
    });
    return this.bootstrapFallbackQuestion(state.profile);
  }

  private async applyBootstrapOnboarding(chatId: number, inputText: string): Promise<string | null> {
    const needs = this.needsBootstrapOnboarding();
    const active = this.bootstrapOnboarding.get(chatId);
    if (!needs && !active) {
      return null;
    }

    const continuingFlow = Boolean(active);
    const locale = active?.locale ?? this.detectOnboardingLocale(inputText);
    const parsedFromInput = this.parseOnboardingFields(inputText);
    const state: BootstrapOnboardingState = active ?? {
      locale,
      profile: this.readProfileSnapshot(),
      turns: [],
    };

    if (parsedFromInput.userPreferredAddress) {
      state.profile.userPreferredAddress = parsedFromInput.userPreferredAddress;
    }
    if (parsedFromInput.assistantName) {
      state.profile.assistantName = this.normalizeAssistantName(parsedFromInput.assistantName);
    }
    if (parsedFromInput.assistantPersona) {
      state.profile.assistantPersona = this.resolvePersonaAnswer(parsedFromInput.assistantPersona);
    }

    const userLine = this.normalizeOneLine(inputText);
    if (userLine) {
      state.turns.push({ role: "user", content: userLine });
    }

    const parsedStructured = Boolean(
      parsedFromInput.userPreferredAddress
      || parsedFromInput.assistantName
      || parsedFromInput.assistantPersona,
    );
    if (userLine && !parsedStructured && this.looksLikeTaskInstruction(userLine)) {
      state.profile = this.completeProfileWithFallbacks(state.profile);
      this.completeWorkspaceBootstrap(state.profile);
      this.bootstrapOnboarding.delete(chatId);
      this.profileOnboarding.delete(chatId);
      this.pendingProfileUpdates.set(chatId, {
        assistantName: state.profile.assistantName,
        locale,
      });
      return null;
    }
    if (continuingFlow && userLine && !parsedStructured) {
      const step = this.firstMissingSnapshotStep(state.profile);
      if (step === 1) {
        state.profile.userPreferredAddress = userLine;
      } else if (step === 2) {
        state.profile.assistantName = this.normalizeAssistantName(userLine);
      } else if (step === 3) {
        state.profile.assistantPersona = this.resolvePersonaAnswer(userLine);
      }
    }

    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return this.tryCompleteOrFallback(chatId, state, locale);
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });

    const prompt = this.buildBootstrapOnboardingPrompt(state, inputText);
    let decision: BootstrapModelDecision | null = null;
    try {
      decision = await this.requestBootstrapOnboardingDecision(
        client,
        profile.model,
        profile.maxTokens,
        prompt,
      );
    } catch {
      decision = null;
    }

    if (!decision?.reply) {
      return this.tryCompleteOrFallback(chatId, state, locale);
    }

    state.profile = this.applyModelProfilePatch(state.profile, decision.profile);
    state.turns.push({ role: "assistant", content: decision.reply });
    this.bootstrapOnboarding.set(chatId, {
      locale,
      profile: state.profile,
      turns: state.turns.slice(-20),
    });

    if (decision.writeProfile) {
      this.writeProfileSnapshot(state.profile);
    }

    const completeByModel = Boolean(decision.onboardingComplete);
    const completeByData =
      this.isProfileSnapshotComplete(state.profile) && !this.hasBootstrapOnboardingFile();
    const shouldComplete =
      (completeByModel && this.isProfileSnapshotComplete(state.profile)) || completeByData;
    if (!shouldComplete) {
      // Guardrail: do not let model wording claim completion when required fields
      // are still incomplete; continue with deterministic next required question.
      return this.bootstrapFallbackQuestion(state.profile);
    }

    this.completeWorkspaceBootstrap(state.profile);
    this.bootstrapOnboarding.delete(chatId);
    this.profileOnboarding.delete(chatId);
    this.pendingProfileUpdates.set(chatId, {
      assistantName: state.profile.assistantName,
      locale,
    });

    return decision.reply;
  }

  private applyProfileUpdate(chatId: number, inputText: string): string | null {
    const activeOnboarding = this.profileOnboarding.get(chatId);
    if (activeOnboarding || this.bootstrapOnboarding.has(chatId) || this.needsBootstrapOnboarding()) {
      return null;
    }
    if (this.looksLikeTaskInstruction(inputText)) {
      return null;
    }

    const parsed = this.parseOnboardingFields(inputText);
    if (!parsed.userPreferredAddress && !parsed.assistantName && !parsed.assistantPersona) {
      return null;
    }

    const locale = this.detectOnboardingLocale(inputText);
    const template = this.onboardingTemplateCopy();
    const current = this.readProfileSnapshot();
    const next: ProfileSnapshot = {
      userPreferredAddress: parsed.userPreferredAddress ?? current.userPreferredAddress,
      assistantName: parsed.assistantName ?? current.assistantName,
      assistantPersona: parsed.assistantPersona
        ? this.resolvePersonaAnswer(parsed.assistantPersona)
        : current.assistantPersona,
    };

    const assistantNameChanged = next.assistantName !== current.assistantName;
    const updates: string[] = [];
    if (next.userPreferredAddress !== current.userPreferredAddress) {
      updates.push(
        this.renderTemplate(template.changeTemplates.userPreferredAddress, {
          value: next.userPreferredAddress,
        }),
      );
    }
    if (assistantNameChanged) {
      updates.push(
        this.renderTemplate(template.changeTemplates.assistantName, {
          value: next.assistantName,
        }),
      );
    }
    if (next.assistantPersona !== current.assistantPersona) {
      updates.push(
        this.renderTemplate(template.changeTemplates.assistantPersona, {
          value: next.assistantPersona,
        }),
      );
    }

    if (updates.length === 0) {
      return template.noChange;
    }

    this.writeProfileSnapshot(next);
    if (assistantNameChanged) {
      this.pendingProfileUpdates.set(chatId, {
        assistantName: next.assistantName,
        locale,
      });
    }

    return this.renderTemplate(template.updated, {
      changes: updates.join(template.changeJoiner),
    });
  }

  private applyProfileOnboarding(chatId: number, inputText: string): string | null {
    const needs = this.needsProfileOnboarding();
    const current = this.profileOnboarding.get(chatId);
    if (!needs && !current) {
      return null;
    }

    const answer = this.normalizeOneLine(inputText);
    if (!current) {
      const locale = this.detectOnboardingLocale(inputText);
      const state: ProfileOnboardingState = {
        step: 1,
        locale,
      };

      if (answer) {
        const parsed = this.parseOnboardingFields(answer);
        if (parsed.userPreferredAddress) state.userPreferredAddress = parsed.userPreferredAddress;
        if (parsed.assistantName) state.assistantName = parsed.assistantName;
        if (parsed.assistantPersona) {
          state.assistantPersona = this.resolvePersonaAnswer(parsed.assistantPersona);
        }
        this.applyThreePartFallback(state, answer);
        const firstMissing = this.firstMissingStep(state);
        if (firstMissing) {
          state.step = firstMissing;
          this.profileOnboarding.set(chatId, state);
          return this.questionForStep(firstMissing);
        }
        this.profileOnboarding.set(chatId, state);
      } else {
        this.profileOnboarding.set(chatId, state);
        return this.questionForStep(1);
      }
    } else if (!answer) {
      return this.onboardingTemplateCopy().emptyAnswer;
    } else {
      const parsed = this.parseOnboardingFields(answer);

      if (parsed.userPreferredAddress) current.userPreferredAddress = parsed.userPreferredAddress;
      if (parsed.assistantName) current.assistantName = parsed.assistantName;
      if (parsed.assistantPersona) {
        current.assistantPersona = this.resolvePersonaAnswer(parsed.assistantPersona);
      }
      this.applyThreePartFallback(current, answer);

      // If user answered naturally without keywords, map answer to current step.
      if (current.step === 1 && !current.userPreferredAddress) {
        current.userPreferredAddress = answer;
      } else if (current.step === 2 && !current.assistantName) {
        current.assistantName = answer;
      } else if (current.step === 3 && !current.assistantPersona) {
        current.assistantPersona = this.resolvePersonaAnswer(answer);
      }

      const firstMissing = this.firstMissingStep(current);
      if (firstMissing) {
        current.step = firstMissing;
        this.profileOnboarding.set(chatId, current);
        return this.questionForStep(firstMissing);
      }
    }

    const finalized = this.profileOnboarding.get(chatId);
    if (!finalized) {
      return null;
    }
    const userPreferredAddress = finalized.userPreferredAddress ?? this.pickFallback("user");
    const assistantName = finalized.assistantName ?? this.pickFallback("assistant");
    const assistantPersona = finalized.assistantPersona ?? this.pickFallback("persona");
    this.completeWorkspaceBootstrap({
      userPreferredAddress,
      assistantName,
      assistantPersona,
    });
    this.pendingProfileUpdates.set(chatId, {
      assistantName,
      locale: finalized.locale,
    });
    this.profileOnboarding.delete(chatId);
    this.bootstrapOnboarding.delete(chatId);
    return this.renderTemplate(this.onboardingTemplateCopy().onboardingSaved, {
      userPreferredAddress,
      assistantName,
      assistantPersona,
    });
  }

  private systemPrompt(): string {
    return [
      "You are OpenPocket conversational assistant.",
      "Keep answers concise and practical.",
      "Users can talk naturally without command syntax.",
      "Assume operation requests are phone actions by default unless the user clearly asks for advice-only chat.",
      "Treat questions about current runtime/device/app/environment/version/status as state-dependent and require executable verification.",
      "Do not expose internal file paths, session files, skills, or scripts in user-facing replies.",
      "Only answer directly in chat when no external observation or execution is needed.",
    ].join("\n");
  }

  private recentTurns(chatId: number): ChatTurn[] {
    return (this.history.get(chatId) ?? []).slice(-12);
  }

  private pushTurn(chatId: number, role: MsgRole, content: string): void {
    const turns = this.history.get(chatId) ?? [];
    turns.push({ role, content });
    this.history.set(chatId, turns.slice(-20));
  }

  private buildRoutingContextTranscript(chatId: number, limit = 8): string {
    const turns = this.recentTurns(chatId).slice(-limit);
    return turns
      .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
      .join("\n");
  }

  appendExternalTurn(chatId: number, role: "user" | "assistant", content: string): void {
    const normalized = String(content || "").trim();
    if (!normalized) {
      return;
    }
    this.pushTurn(chatId, role, normalized);
  }

  private async extractScheduleIntentWithModel(
    client: OpenAI,
    model: string,
    maxTokens: number,
    chatId: number,
    inputText: string,
  ): Promise<ScheduleIntentExtractionDecision | null> {
    const locale: OnboardingLocale = inferScheduleIntentLocale(inputText);
    const recentContext = this.buildRoutingContextTranscript(chatId);
    const prompt = [
      "Determine whether the user message asks to create a scheduled job, manage an existing scheduled job, or neither.",
      "Output strict JSON only:",
      '{"route":"create_schedule|manage_schedule|none","task":"<task or empty>","manageIntent":{"action":"list|update|remove|enable|disable|unknown","selector":{"all":true|false,"ids":["<job id>"],"nameContains":["<name fragment>"],"taskContains":["<task fragment>"],"scheduleContains":["<schedule fragment>"],"enabled":"any|enabled|disabled"},"patch":{"name":"<new name or empty>","task":"<new task or empty>","enabled":true|false|null,"schedule":{"kind":"cron|at|every","expr":"<cron expr or empty>","at":"<RFC3339 datetime or empty>","everyMs":number|null,"tz":"<IANA timezone or empty>","summaryText":"<short schedule summary>"}}},"schedule":{"kind":"cron|at|every","expr":"<cron expr or empty>","at":"<RFC3339 datetime or empty>","everyMs":number|null,"tz":"<IANA timezone or empty>","summaryText":"<concise schedule summary in the user language>"},"confidence":0-1,"reason":"..."}',
      "Rules:",
      "1) Return route=create_schedule for explicit or implicit requests to create a new recurring or one-shot scheduled task/reminder.",
      "2) Return route=manage_schedule for requests to inspect, list, modify, rename, enable, disable, delete, or otherwise manage an existing cron job or scheduled task.",
      "3) Return route=none for translation, explanation, troubleshooting, capability, or meta questions about schedule-shaped text.",
      "4) For route=create_schedule, task must contain only the executable action, not the time phrase.",
      "5) For route=manage_schedule, task should contain the management instruction itself.",
      "6) For route=manage_schedule, populate manageIntent.action as list, update, remove, enable, disable, or unknown.",
      "7) For route=manage_schedule, populate selector.all=true only when the user clearly targets every matching job (for example, all scheduled jobs or all disabled jobs).",
      "8) For route=manage_schedule, populate selector.ids when the user names specific job IDs, and populate nameContains/taskContains/scheduleContains with the best matching fragments when the user refers to a job by description.",
      "8.1) When the user refers to 'the task', 'this job', or uses other anaphoric references without specifying a name or ID, resolve the reference using conversation context and the existing jobs list below. Prefer populating selector.ids with the resolved job ID.",
      "9) For route=manage_schedule, use enabled=enabled or disabled only when the request explicitly filters by current enabled state; otherwise use any.",
      "10) For route=manage_schedule, populate patch only with the requested changes. Use patch.enabled for update/enable/disable requests that change enabled state.",
      "10.1) When patch.task is set, include ONLY the user's requested change or amendment — NOT the full original task. The system merges it into the original task server-side. Example: if the user says 'make it more casual', patch.task should be 'use a casual and brief style' — do NOT reproduce the entire existing task text.",
      "11) Use kind=cron for recurring calendar schedules when you can express them with a standard 5-field cron expression.",
      "12) Use kind=every only for fixed interval schedules and set everyMs.",
      "13) Use kind=at only for one-shot future schedules when you can provide an RFC3339 datetime.",
      "14) summaryText must be short and in the user's language when route=create_schedule.",
      "15) If the schedule is ambiguous or any required field is missing for route=create_schedule, return route=none instead of guessing.",
      `User locale hint: ${locale}`,
      this.buildExistingJobsCatalog(),
      recentContext ? `Recent conversation context:\n${recentContext}` : "",
      `User message: ${inputText}`,
    ].join("\n");

    const output = await this.callModelRaw(
      client,
      model,
      Math.min(maxTokens, 1024),
      prompt,
      "schedule classify",
    );
    if (!output) {
      throw new Error("schedule classify failed: all endpoint modes returned empty output");
    }

    const jsonText = extractJsonObjectText(output);
    this.logChat(
      "debug",
      `schedule_classify raw_output_chars=${output.length} preview=${JSON.stringify(this.payloadForChatLog(output, 500))}`,
    );

    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const decision = normalizeScheduleIntentDecision(inputText, parsed, {
        resolveTimezone: () => this.scheduleTimezoneForInput(),
      });
      if (!decision) {
        return null;
      }
      const confidence =
        typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
          ? parsed.confidence
          : 0.9;
      const reason = typeof parsed.reason === "string" ? parsed.reason : "schedule_model";
      if (decision.route === "manage_schedule") {
        return {
          route: "manage_schedule",
          task: decision.task,
          manageAction: decision.manageAction,
          cronManagementIntent: decision.cronManagement,
          confidence,
          reason,
        };
      }
      return {
        route: "create_schedule",
        intent: decision.intent,
        confidence,
        reason,
      };
    } catch {
      this.logChat(
        "warn",
        `schedule_classify parse failed json=${JSON.stringify(this.payloadForChatLog(jsonText, 300))}`,
      );
      return null;
    }
  }

  private async classifyWithModel(
    client: OpenAI,
    model: string,
    maxTokens: number,
    chatId: number,
    inputText: string,
  ): Promise<ChatDecision> {
    const recentContext = this.buildRoutingContextTranscript(chatId);
    const prompt = [
      "Classify the user message for phone assistant routing.",
      "Output strict JSON only:",
      '{"mode":"task|chat","task":"<task or empty>","reply":"<chat reply or empty>","taskAcceptedReply":"<one-line start ack for task mode, else empty>","confidence":0-1,"reason":"...","requiresExternalObservation":true|false,"canAnswerDirectly":true|false,"scheduleManagement":true|false,"scheduleManagementAction":"list|update|remove|enable|disable|unknown","scheduleManagementIntent":{"action":"list|update|remove|enable|disable|unknown","selector":{"all":true|false,"ids":["<job id>"],"nameContains":["<name fragment>"],"taskContains":["<task fragment>"],"scheduleContains":["<schedule fragment>"],"enabled":"any|enabled|disabled"},"patch":{"name":"<new name or empty>","task":"<new task or empty>","enabled":true|false|null,"schedule":{"kind":"cron|at|every","expr":"<cron expr or empty>","at":"<RFC3339 datetime or empty>","everyMs":number|null,"tz":"<IANA timezone or empty>","summaryText":"<short schedule summary>"}}}}',
      "Rules:",
      "1) mode=task when user wants the assistant to operate phone/apps.",
      "1.1) Treat operation as happening on phone by default.",
      "1.2) Short imperative app commands (e.g., 'open duolingo', 'launch instagram', 'go to settings') must be mode=task.",
      "1.3) Question-like phrasing (for example, 'can you ...?') must still be mode=task when it asks for executable outputs (create/write/build/run/install/open).",
      "1.4) Requests to list/show/modify/update/delete/disable/enable existing cron jobs or scheduled tasks are mode=task management actions.",
      "2) requiresExternalObservation=true when correctness depends on current real-world/device/runtime/tool state.",
      "2.1) This includes requests about what is currently running, which device/environment/version/status is active, what is installed/connected/open right now, or any runtime fact that must be verified.",
      "3) canAnswerDirectly=true only when the answer can be produced reliably from conversation context and stable general knowledge alone.",
      "4) mode=chat only when canAnswerDirectly=true and no phone/tool execution is needed.",
      "5) If uncertain between chat and task, set confidence lower and prefer task semantics.",
      "6) task should be executable imperative sentence.",
      "7) for chat mode, reply should be concise.",
      "8) If requiresExternalObservation=true, prefer mode=task.",
      "9) scheduleManagement=true only when the user is asking to inspect or modify existing cron jobs / scheduled tasks. Otherwise false.",
      "10) If scheduleManagement=true, set scheduleManagementAction and scheduleManagementIntent.action consistently.",
      "11) If scheduleManagement=true, populate scheduleManagementIntent.selector and scheduleManagementIntent.patch with the best structured target and change data you can infer from the user request.",
      "11.1) When the user refers to 'the task', 'this job', or uses other anaphoric references without specifying a name or ID, resolve the reference using conversation context and the existing jobs list below. Prefer populating selector.ids with the resolved job ID.",
      "11.2) When patch.task is set, include ONLY the user's requested change or amendment — NOT the full original task. The system merges it into the original task server-side. Example: if the user says 'also post tweets from my account', patch.task should be 'also post tweets from my account' — do NOT reproduce the entire existing task text.",
      "12) If mode=task, taskAcceptedReply must be one short natural sentence that confirms execution starts now.",
      "13) If mode=chat, taskAcceptedReply must be empty.",
      this.buildExistingJobsCatalog(),
      recentContext ? `Recent conversation context:\n${recentContext}` : "",
      `User message: ${inputText}`,
    ].join("\n");

    const output = await this.callModelRaw(client, model, Math.min(maxTokens, 2048), prompt, "classify");
    if (!output) {
      throw new Error("classify failed: all endpoint modes returned empty output");
    }

    const jsonText = extractJsonObjectText(output);
    this.logChat(
      "debug",
      `classify raw_output_chars=${output.length} preview=${JSON.stringify(this.payloadForChatLog(output, 500))}`,
    );

    try {
      const parsed = JSON.parse(jsonText) as Partial<ChatDecision> & {
        scheduleManagementIntent?: unknown;
      };
      const mode = parsed.mode === "task" ? "task" : "chat";
      const scheduleManagement = mode === "task" && parsed.scheduleManagement === true;
      const scheduleManagementIntent = scheduleManagement
        ? normalizeCronManagementIntent(
          isObject(parsed.scheduleManagementIntent)
            ? {
              ...parsed.scheduleManagementIntent,
              action: parsed.scheduleManagementIntent.action ?? parsed.scheduleManagementAction,
            }
            : { action: parsed.scheduleManagementAction },
          {
            resolveTimezone: () => this.scheduleTimezoneForInput(),
          },
        ) ?? {
          action: "unknown",
          selector: emptyCronManagementSelector(),
          patch: emptyCronManagementPatch(),
        }
        : null;
      const scheduleManagementAction = scheduleManagementIntent?.action ?? "unknown";
      const result: ChatDecision = {
        mode,
        task: typeof parsed.task === "string" ? parsed.task.trim() : "",
        reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
        taskAcceptedReply: typeof parsed.taskAcceptedReply === "string"
          ? this.normalizeOneLine(parsed.taskAcceptedReply)
          : "",
        confidence:
          typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
            ? parsed.confidence
            : 0.5,
        reason: typeof parsed.reason === "string" ? parsed.reason : "model_classify",
        requiresExternalObservation: parsed.requiresExternalObservation === true,
        canAnswerDirectly: parsed.canAnswerDirectly !== false,
        scheduleManagement,
        scheduleManagementAction: scheduleManagement ? scheduleManagementAction : undefined,
        cronManagementIntent: scheduleManagement ? scheduleManagementIntent : undefined,
      };
      this.logChat("debug", `classify parsed mode=${result.mode} confidence=${result.confidence} reason=${result.reason}`);
      return result;
    } catch {
      this.logChat(
        "warn",
        `classify parse failed json=${JSON.stringify(this.payloadForChatLog(jsonText, 300))}`,
      );
      return {
        mode: "chat",
        task: "",
        reply: "",
        confidence: 0.3,
        reason: "model_output_not_json",
        requiresExternalObservation: false,
        canAnswerDirectly: true,
      };
    }
  }

  private async auditGroundingNeed(
    client: OpenAI,
    model: string,
    maxTokens: number,
    inputText: string,
    firstPass: ChatDecision,
  ): Promise<GroundingAuditDecision> {
    const prompt = [
      "You are a routing auditor for a phone-use agent.",
      "Determine whether the user request can be answered directly or needs external observation/execution.",
      "Output strict JSON only:",
      '{"requiresExternalObservation":true|false,"canAnswerDirectly":true|false,"confidence":0-1,"reason":"..."}',
      "Rules:",
      "1) requiresExternalObservation=true when correctness depends on current real-world/device/runtime/tool state.",
      "2) requiresExternalObservation=true for requests that need phone actions, app inspection, script execution, log checking, or any state verification.",
      "2.1) requiresExternalObservation=true for state-dependent factual questions about the current assistant instance (runtime environment, active device, app state, versions, connectivity, installed packages, process/log state).",
      "3) canAnswerDirectly=true only when answer is reliable from conversation context and stable general knowledge alone.",
      "4) If uncertain, choose requiresExternalObservation=true and lower confidence.",
      "5) Examples:",
      "- 'What Android version is the connected phone currently running?' => requiresExternalObservation=true",
      "- 'Which app is open right now?' => requiresExternalObservation=true",
      "- 'Explain what ADB is.' => requiresExternalObservation=false",
      "",
      "First-pass decision JSON:",
      JSON.stringify({
        mode: firstPass.mode,
        confidence: firstPass.confidence,
        reason: firstPass.reason,
        requiresExternalObservation: firstPass.requiresExternalObservation ?? false,
        canAnswerDirectly: firstPass.canAnswerDirectly ?? true,
      }),
      `User message: ${inputText}`,
    ].join("\n");

    const output = await this.callModelRaw(client, model, Math.min(maxTokens, 800), prompt, "grounding audit");
    if (!output) {
      throw new Error("grounding audit failed: all endpoint modes returned empty output");
    }

    const jsonText = extractJsonObjectText(output);
    const parsed = JSON.parse(jsonText) as Partial<GroundingAuditDecision>;
    return {
      requiresExternalObservation: parsed.requiresExternalObservation === true,
      canAnswerDirectly: parsed.canAnswerDirectly !== false,
      confidence:
        typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
          ? parsed.confidence
          : 0.5,
      reason: typeof parsed.reason === "string" ? parsed.reason : "grounding_audit",
    };
  }

  private async refineChatDecisionWithGroundingAudit(
    client: OpenAI,
    model: string,
    maxTokens: number,
    inputText: string,
    decided: ChatDecision,
  ): Promise<ChatDecision> {
    if (decided.mode !== "chat") {
      return decided;
    }

    const reasonPrefix = decided.reason ? `${decided.reason};` : "";
    try {
      const audit = await this.auditGroundingNeed(client, model, maxTokens, inputText, decided);
      return {
        ...decided,
        confidence: Math.min(decided.confidence, audit.confidence),
        reason: `${reasonPrefix}grounding_audit:${audit.reason}`,
        requiresExternalObservation: decided.requiresExternalObservation === true || audit.requiresExternalObservation,
        canAnswerDirectly: decided.canAnswerDirectly !== false && audit.canAnswerDirectly,
      };
    } catch {
      return {
        ...decided,
        confidence: Math.min(decided.confidence, 0.65),
        reason: `${reasonPrefix}grounding_audit_failed`,
      };
    }
  }

  private arbitrateRoutingDecision(inputText: string, decided: ChatDecision): ChatDecision {
    const normalizedInput = inputText.trim();
    if (decided.mode === "schedule_intent") {
      return {
        ...decided,
        task: decided.task || normalizedInput,
      };
    }
    if (decided.mode === "task") {
      if (!decided.task) {
        return { ...decided, task: normalizedInput };
      }
      return decided;
    }

    const reasonPrefix = decided.reason ? `${decided.reason};` : "";
    if (this.looksLikeExecutableIntent(normalizedInput)) {
      return {
        mode: "task",
        task: normalizedInput,
        reply: "",
        confidence: Math.max(0.85, decided.confidence),
        reason: `${reasonPrefix}executable_intent_task_bias`,
      };
    }

    const requiresExternalObservation =
      decided.requiresExternalObservation === true || decided.canAnswerDirectly === false;
    if (requiresExternalObservation) {
      return {
        mode: "task",
        task: normalizedInput,
        reply: "",
        confidence: Math.max(0.8, decided.confidence),
        reason: `${reasonPrefix}requires_external_observation`,
      };
    }

    if (this.looksLikeCapabilityQuestionOnly(normalizedInput)) {
      return {
        mode: "chat",
        task: "",
        reply: decided.reply || "",
        confidence: Math.max(0.75, decided.confidence),
        reason: `${reasonPrefix}capability_only_chat`,
      };
    }

    if (decided.confidence < 0.6) {
      return {
        mode: "task",
        task: normalizedInput,
        reply: "",
        confidence: 0.6,
        reason: `${reasonPrefix}low_confidence_task_fallback`,
      };
    }

    return {
      ...decided,
      reply: decided.reply || "",
    };
  }

  private async askResponses(client: OpenAI, model: string, maxTokens: number, inputText: string, chatId: number): Promise<string> {
    if (this.shouldUseCodexResponsesTransport(client, model)) {
      const apiKey = this.readClientApiKey(client);
      return this.callCodexResponsesText({
        apiKey,
        model,
        maxTokens: Math.min(maxTokens, 800),
        systemPrompt: this.systemPrompt(),
        turns: this.recentTurns(chatId),
        inputText,
      });
    }

    const input: Array<Record<string, unknown>> = [
      {
        role: "system",
        content: [{ type: "input_text", text: this.systemPrompt() }],
      },
      ...this.recentTurns(chatId).map((turn) => ({
        role: turn.role,
        content: [{ type: "input_text", text: turn.content }],
      })),
      {
        role: "user",
        content: [{ type: "input_text", text: inputText }],
      },
    ];

    const response = await client.responses.create({
      model,
      max_output_tokens: Math.min(maxTokens, 800),
      input,
    } as never);

    const text = readResponseOutputText(response);
    if (!text) {
      throw new Error("Responses API returned empty text output.");
    }
    return text;
  }

  private async askChat(client: OpenAI, model: string, maxTokens: number, inputText: string, chatId: number): Promise<string> {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: this.systemPrompt() },
      ...this.recentTurns(chatId).map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: inputText },
    ];

    const response = await client.chat.completions.create({
      model,
      max_tokens: Math.min(maxTokens, 800),
      messages,
    } as never);

    const content = response.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const text = content
        .map((item) => (typeof item === "object" && item && "text" in item ? String((item as { text?: unknown }).text ?? "") : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
    throw new Error("Chat Completions API returned empty text output.");
  }

  private async askCompletions(client: OpenAI, model: string, maxTokens: number, inputText: string, chatId: number): Promise<string> {
    const transcript = this.recentTurns(chatId)
      .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
      .join("\n");

    const prompt = [
      this.systemPrompt(),
      transcript ? `\nConversation:\n${transcript}` : "",
      `\nUSER: ${inputText}`,
      "ASSISTANT:",
    ].join("\n");

    const response = await client.completions.create({
      model,
      max_tokens: Math.min(maxTokens, 800),
      prompt,
    } as never);

    const text = (response.choices?.[0]?.text ?? "").trim();
    if (!text) {
      throw new Error("Completions API returned empty text output.");
    }
    return text;
  }

  private cleanProgressSummaryForUser(raw: string, maxChars = 320): string {
    const oneLine = this.normalizeOneLine(raw);
    if (!oneLine) {
      return "";
    }
    // Take the first meaningful clause as a concise summary.
    // No content-based keyword stripping — the narration model handles tone;
    // this fallback path only needs to truncate safely.
    const firstClause = oneLine.split(/(?:\s*[;；]\s*|\s+\|\s+|\s+[.。]\s+)/)[0]?.trim() ?? "";
    const normalized = firstClause || oneLine;
    return this.trimForPrompt(normalized, maxChars);
  }

  fallbackTaskProgressNarration(input: TaskProgressNarrationInput): TaskProgressNarrationDecision {
    const action = String(input.progress.actionType || "").toLowerCase();
    const message = String(input.progress.message || "");
    const isErrorLike = /(error|failed|timeout|interrupted|not completed|rejected)/i.test(message);
    const shouldNotify =
      input.progress.step === 1
      || action === "launch_app"
      || action === "request_human_auth"
      || action === "run_script"
      || action === "finish"
      || isErrorLike
      || input.skippedSteps >= 10;

    if (!shouldNotify) {
      return {
        notify: false,
        message: "",
        reason: "fallback_skip",
      };
    }

    const summary = isErrorLike
      ? this.cleanProgressSummaryForUser(
        input.progress.message || input.progress.thought || "",
        280,
      )
      : "";
    const messageText = summary
      ? `Still working on it — hit a snag: ${summary}`
      : "Still working on it. I will share the result shortly.";

    return {
      notify: true,
      message: messageText,
      reason: "fallback_notify",
    };
  }

  private sanitizeOutcomeBoilerplate(raw: string): string {
    return String(raw || "")
      .replace(/^task completed[.!:\s-]*/i, "")
      .replace(/^completed[.!:\s-]*/i, "")
      .trim();
  }

  private looksLikeShoppingTask(task: string): boolean {
    const text = String(task || "");
    return /(where\s+to\s+buy|where\s+can\s+i\s+buy|buy\s+\w|purchase\s+\w|shop\s+for|shopping\s+for|for\s+sale)/i
      .test(text);
  }

  private deriveShoppingQuery(task: string, base: string, context: string): string {
    const candidates: string[] = [];
    const quoted = `${base}\n${context}`.match(/[“"]([^”"\n]{4,120})[”"]/);
    if (quoted?.[1]) {
      candidates.push(quoted[1]);
    }
    const firstLine = String(base || "").split("\n")[0] || "";
    if (firstLine) {
      const lineMatch = firstLine.match(/(?:buy|for)\s+(.+?)(?:\s+\(matches|\s+\(likely|:|$)/i);
      if (lineMatch?.[1]) {
        candidates.push(lineMatch[1]);
      }
    }
    candidates.push(String(task || ""));
    for (const raw of candidates) {
      const cleaned = raw
        .replace(/^find\s+/i, "")
        .replace(/^search(?:\s+for)?\s+/i, "")
        .replace(/^look(?:\s+for)?\s+/i, "")
        .replace(/^where\s+(?:can\s+i\s+)?buy\s+/i, "")
        .replace(/^where\s+to\s+buy\s+/i, "")
        .replace(/\bwhere\s+is\s+available\s+to\s+buy\b/gi, " ")
        .replace(/\bwhere\s+to\s+buy\b/gi, " ")
        .replace(/\bavailable\s+to\s+buy\b/gi, " ")
        .replace(/\bavailability\b/gi, " ")
        .replace(/,?\s*where\s+is\s+available\b/gi, "")
        .replace(/\bfor\s+(men|women|kids|sale)\b/gi, "")
        .replace(/[,:;]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned.length >= 4) {
        return cleaned.slice(0, 120);
      }
    }
    return "product";
  }

  private extractUrls(text: string): string[] {
    const matches = String(text || "").match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [];
    const cleaned = matches
      .map((url) => url.replace(/[),.;!?]+$/g, ""))
      .filter((url) => url.length > 0);
    return Array.from(new Set(cleaned));
  }

  private isLikelySearchUrl(url: string): boolean {
    const lower = String(url || "").toLowerCase();
    return /[?&](q|query|s|_nkw|vst)=/.test(lower)
      || /\/search(?:\/|$|\?)/.test(lower)
      || /\/sch\/i\.html/.test(lower);
  }

  private buildStoreSearchLink(storeLabel: string, query: string): string {
    const encoded = encodeURIComponent(query);
    const normalized = storeLabel.toLowerCase();
    if (normalized === "goat") {
      return `https://www.goat.com/search?query=${encoded}`;
    }
    if (normalized === "stockx") {
      return `https://stockx.com/search?s=${encoded}`;
    }
    if (normalized === "farfetch") {
      return `https://www.farfetch.com/shopping/men/search/items.aspx?q=${encoded}`;
    }
    if (normalized === "ebay") {
      return `https://www.ebay.com/sch/i.html?_nkw=${encoded}`;
    }
    if (normalized === "nike") {
      return `https://www.nike.com/w?q=${encoded}&vst=${encoded}`;
    }
    if (normalized === "flight club") {
      return `https://www.google.com/search?q=site%3Awww.flightclub.com+${encoded}`;
    }
    return `https://www.google.com/search?q=${encoded}`;
  }

  private downgradeShoppingClaimsWhenUnverified(message: string): string {
    const lines = this.normalizeMultiline(message).split("\n");
    const transformed = lines.map((line, idx) => {
      let next = line;
      if (idx === 0) {
        next = next
          .replace(/^available to buy now for\b/i, "Observed listings for")
          .replace(/^available now for\b/i, "Observed listings for")
          .replace(/^available places to buy\b/i, "Observed listings for");
      }
      next = next
        .replace(/\bin stock online\b/gi, "listed as in stock (unverified)")
        .replace(/\bin stock\b/gi, "listed as in stock (unverified)");
      return next;
    });
    const disclaimer = "Note: No verifiable direct product URLs were captured; price/stock come from listing snippets and may change.";
    return `${transformed.join("\n")}\n${disclaimer}`.trim();
  }

  private appendShoppingLinksIfNeeded(input: TaskOutcomeNarrationInput, message: string): string {
    const base = String(message || "").trim();
    if (!base || !input.ok || !this.looksLikeShoppingTask(input.task)) {
      return base;
    }

    const context = [
      base,
      String(input.rawResult || ""),
      ...input.recentProgress.map((item) => String(item.message || "")),
      ...input.recentProgress.map((item) => String(item.thought || "")),
    ].join("\n");

    const stores: Array<{ label: string; regex: RegExp; domains: string[] }> = [
      {
        label: "GOAT",
        regex: /\bgoat\b/i,
        domains: ["goat.com"],
      },
      {
        label: "StockX",
        regex: /\bstockx\b/i,
        domains: ["stockx.com"],
      },
      {
        label: "Farfetch",
        regex: /\bfarfetch\b/i,
        domains: ["farfetch.com"],
      },
      {
        label: "eBay",
        regex: /\bebay\b/i,
        domains: ["ebay.com"],
      },
      {
        label: "Flight Club",
        regex: /\bflight\s*club\b/i,
        domains: ["flightclub.com"],
      },
      {
        label: "Nike",
        regex: /\bnike\b/i,
        domains: ["nike.com"],
      },
    ];

    const baseUrls = this.extractUrls(base);
    const contextUrls = this.extractUrls(context);
    const linkLines: string[] = [];
    const missingStores: string[] = [];
    let verifiedDirectCount = 0;

    for (const store of stores) {
      if (!store.regex.test(context)) {
        continue;
      }

      const baseHasDirect = baseUrls.some((url) => store.domains.some((domain) => url.toLowerCase().includes(domain))
        && !this.isLikelySearchUrl(url));
      if (baseHasDirect) {
        verifiedDirectCount += 1;
        continue;
      }

      const directFromContext = contextUrls.find((url) => store.domains.some((domain) => url.toLowerCase().includes(domain))
        && !this.isLikelySearchUrl(url));
      if (directFromContext) {
        verifiedDirectCount += 1;
        linkLines.push(`- ${store.label}: ${directFromContext}`);
        continue;
      }
      const unavailable = "link unavailable";
      linkLines.push(`- ${store.label}: ${unavailable}`);
      missingStores.push(store.label);
    }

    if (linkLines.length === 0) {
      return base;
    }

    const allMissingDirectLinks = verifiedDirectCount === 0;
    const summary = allMissingDirectLinks
      ? this.downgradeShoppingClaimsWhenUnverified(base)
      : base;

    const title = allMissingDirectLinks ? "Store links:" : "Store links (verified):";
    const query = this.deriveShoppingQuery(input.task, base, context);
    const searchTitle = "Quick search links (not direct product pages):";
    const searchLines = missingStores
      .map((store) => `- ${store}: ${this.buildStoreSearchLink(store, query)}`);
    const searchSection = searchLines.length > 0
      ? `\n\n${searchTitle}\n${searchLines.join("\n")}`
      : "";
    return `${summary}\n\n${title}\n${linkLines.join("\n")}${searchSection}`;
  }

  private fallbackTaskOutcomeNarration(input: TaskOutcomeNarrationInput): string {
    const cleaned = this.sanitizeOutcomeBoilerplate(input.rawResult);
    const base = cleaned || (input.ok
      ? "I got the result, but details are limited."
      : this.trimForPrompt(input.rawResult, 400));
    const enrichedBase = this.appendShoppingLinksIfNeeded(input, base);
    const reuseNote =
      input.ok && (input.skillPath || input.scriptPath)
        ? "Also, I saved this workflow as reusable automation assets for faster reuse next time."
        : "";
    return reuseNote ? `${enrichedBase}\n${reuseNote}` : enrichedBase;
  }

  private fallbackEscalationNarration(input: EscalationNarrationInput): string {
    const locale = input.locale;
    const capabilityLabel = this.capabilityLabel(input.capability);
    const appLine = "";
    const securityLine = input.includeLocalSecurityAssurance
      ? "Security note: this auth page connects to your local OpenPocket relay; credentials stay in a private encrypted channel and are not stored in a centralized relay."
      : "";

    if (input.event === "human_auth") {
      const actionLine = input.hasWebLink
        ? "Open the link below and approve or reject."
        : "Web link is unavailable; reply in Telegram with your decision.";
      const codeLine = input.isCodeFlow
        ? "This is a code flow: you can also reply with the 4-10 digit code directly."
        : "";
      const intro = `I need your help for ${capabilityLabel}; automation is paused.`;
      return [intro, actionLine, codeLine, appLine, securityLine].filter(Boolean).join(" ");
    }

    const optionsLine = Array.isArray(input.options) && input.options.length > 0
      ? `Options: ${input.options.slice(0, 6).join(" / ")}.`
      : "";
    const questionLine = input.question
      ? `Question: ${input.question}`
      : "";
    const actionLine = "Reply with the option number or text, and I will continue.";
    return [questionLine, optionsLine, actionLine].filter(Boolean).join(" ");
  }

  private fallbackStartReadyReply(): string {
    return "I am ready. Send what you want done on the phone directly, or use /help for commands.";
  }

  private fallbackSessionResetUserReply(): string {
    return "Started a fresh session. Tell me what you want to do now, or use /help for commands.";
  }

  private stableHash(input: string): number {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  taskAcceptedFallbackReply(task: string): string {
    const fallbackTask = "this task";
    const taskLine = this.trimForPrompt(String(task || "").replace(/\s+/g, " ").trim(), 160) || fallbackTask;
    const templates = [
      `Starting now: ${taskLine}.`,
      `Task received. Beginning now: ${taskLine}.`,
      `I am starting this now: ${taskLine}.`,
      `Working on it now: ${taskLine}.`,
    ];
    const index = this.stableHash(taskLine) % templates.length;
    return templates[index];
  }

  async startReadyReply(locale: OnboardingLocale): Promise<string> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return this.fallbackStartReadyReply();
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    const prompt = [
      "You are OpenPocket conversational assistant.",
      "The user just sent /start in Telegram and onboarding is already complete.",
      "Write one short welcome sentence in the target locale.",
      "Include exactly these intents: user can send requests directly; /help shows commands.",
      "Do not mention API keys, endpoints, providers, or internal implementation details.",
      `Locale: ${locale}`,
    ].join("\n");

    try {
      const output = await this.callModelRaw(
        client,
        profile.model,
        Math.min(profile.maxTokens, 120),
        prompt,
        "start welcome",
      );
      const normalized = this.normalizeOneLine(output);
      return normalized || this.fallbackStartReadyReply();
    } catch {
      return this.fallbackStartReadyReply();
    }
  }

  async sessionResetUserReply(locale: OnboardingLocale): Promise<string> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return this.fallbackSessionResetUserReply();
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    const prompt = [
      "You are OpenPocket conversational assistant.",
      "The user just started a fresh session using /new or /reset in Telegram.",
      "Write one short user-facing message in the target locale.",
      "Required intent: session is fresh; user can send a task directly; /help shows commands.",
      "Do not mention AGENTS.md, SOUL.md, USER.md, IDENTITY.md, BOOTSTRAP.md, prompts, files, tools, startup flows, or any internal implementation details.",
      `Locale: ${locale}`,
    ].join("\n");

    try {
      const output = await this.callModelRaw(
        client,
        profile.model,
        Math.min(profile.maxTokens, 120),
        prompt,
        "session reset user reply",
      );
      const normalized = this.normalizeOneLine(output);
      return normalized || this.fallbackSessionResetUserReply();
    } catch {
      return this.fallbackSessionResetUserReply();
    }
  }

  async taskAcceptedReply(task: string, locale: OnboardingLocale): Promise<string> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return this.taskAcceptedFallbackReply(task);
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    const prompt = [
      "You are OpenPocket task-start narrator.",
      "A new user task was just accepted and is about to run.",
      "Write one short user-facing sentence in the target locale.",
      "The sentence must acknowledge that execution has started right now.",
      "Do not include progress numbers, internal tool names, or policy text.",
      "Do not mention prompts, files, models, APIs, or implementation details.",
      `Task: ${task}`,
      `Locale: ${locale}`,
    ].join("\n");

    try {
      const output = await this.callModelRaw(
        client,
        profile.model,
        Math.min(profile.maxTokens, 120),
        prompt,
        "task accepted reply",
      );
      const normalized = this.normalizeOneLine(output);
      return normalized || this.taskAcceptedFallbackReply(task);
    } catch {
      return this.taskAcceptedFallbackReply(task);
    }
  }

  async narrateScheduledTaskStart(jobName: string, task: string): Promise<string> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return `Starting scheduled task: ${jobName}`;
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    const prompt = [
      "You are OpenPocket, a phone-use agent notifying the user that a recurring scheduled task is starting now.",
      "Write one casual, brief sentence telling the user what you are about to do.",
      "Vary your wording each time — do not repeat the same phrasing.",
      "Do not quote the full task verbatim; paraphrase it naturally.",
      "Do not mention cron, job IDs, schedules, or implementation details.",
      "Write entirely in English.",
      `Job name: ${jobName}`,
      `Task: ${task}`,
    ].join("\n");

    try {
      const output = await this.callModelRaw(
        client,
        profile.model,
        Math.min(profile.maxTokens, 100),
        prompt,
        "scheduled task start narration",
      );
      const normalized = this.normalizeOneLine(output);
      return normalized || `Starting scheduled task: ${jobName}`;
    } catch {
      return `Starting scheduled task: ${jobName}`;
    }
  }

  private buildFallbackCronTaskPlan(task: string): CronTaskPlan {
    const normalizedTask = this.normalizeOneLine(task);
    const summary = normalizedTask
      ? `I will do one focused pass on "${normalizedTask.slice(0, 80)}" and then stop.`
      : "I will do one focused scheduled pass and then stop.";
    return {
      summary,
      steps: [
        "Inspect the most relevant current state and gather the first concrete evidence.",
        "Take one or two high-value actions that directly advance the scheduled task.",
        "If the first path is blocked or not useful, try one reasonable alternative path.",
        "Capture any meaningful result or confirmation before ending the run.",
        "Stop after this focused pass and leave remaining work for the next scheduled trigger.",
      ],
      stepBudget: 30,
      completionCriteria: "Finish after one focused pass, once meaningful progress is made, or when the step budget is exhausted.",
    };
  }

  private normalizeCronTaskPlan(task: string, value: Partial<CronTaskPlan> | null | undefined): CronTaskPlan {
    const fallback = this.buildFallbackCronTaskPlan(task);
    const steps = Array.isArray(value?.steps)
      ? value.steps
        .map((step) => this.normalizeOneLine(String(step || "")))
        .filter(Boolean)
        .slice(0, 8)
      : [];
    return {
      summary: this.normalizeOneLine(String(value?.summary || "")) || fallback.summary,
      steps: steps.length > 0 ? steps : fallback.steps,
      stepBudget: Math.max(20, Math.min(60, Number(value?.stepBudget) || fallback.stepBudget)),
      completionCriteria: this.normalizeOneLine(String(value?.completionCriteria || "")) || fallback.completionCriteria,
    };
  }

  private static readonly CRON_TASK_MAX_CHARS = 2000;

  /**
   * Merge an original cron task with a user amendment into a single consolidated task.
   * Uses the LLM to rewrite intelligently; falls back to simple append on failure.
   */
  async consolidateCronTaskUpdate(originalTask: string, amendment: string): Promise<string> {
    const fallback = `${originalTask}\n\nAdditional instruction: ${amendment}`;
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return fallback.slice(0, ChatAssistant.CRON_TASK_MAX_CHARS);
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });

    const prompt = [
      "You are rewriting a scheduled task description for a phone-use agent.",
      "The user has requested a change to an existing scheduled task. Your job is to produce ONE clean, consolidated task description that integrates the amendment into the original.",
      "",
      "Rules:",
      "1) Output ONLY the final consolidated task text — no JSON, no labels, no explanation.",
      "2) Preserve ALL original instructions that are not contradicted by the amendment.",
      "3) Integrate the amendment naturally into the text instead of appending it.",
      "4) If the amendment contradicts part of the original, the amendment takes priority.",
      "5) Remove any redundant or duplicated instructions.",
      `6) Keep the result under ${ChatAssistant.CRON_TASK_MAX_CHARS} characters.`,
      "7) Maintain the same language and tone as the original task.",
      "8) Do not add instructions that were not in the original or the amendment.",
      "",
      "--- ORIGINAL TASK ---",
      originalTask,
      "",
      "--- USER AMENDMENT ---",
      amendment,
      "",
      "--- CONSOLIDATED TASK ---",
    ].join("\n");

    try {
      const output = await this.callModelRaw(
        client,
        profile.model,
        Math.min(profile.maxTokens, 2048),
        prompt,
        "cron task consolidation",
      );
      const consolidated = (output || "").trim();
      if (!consolidated || consolidated.length < 20) {
        return fallback.slice(0, ChatAssistant.CRON_TASK_MAX_CHARS);
      }
      return consolidated.slice(0, ChatAssistant.CRON_TASK_MAX_CHARS);
    } catch {
      return fallback.slice(0, ChatAssistant.CRON_TASK_MAX_CHARS);
    }
  }

  /**
   * Generate a bounded execution plan for a cron-triggered task.
   * Always returns a bounded plan, with a deterministic fallback when model planning is unavailable.
   */
  async planCronTask(task: string): Promise<CronTaskPlan> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return this.buildFallbackCronTaskPlan(task);
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });

    const prompt = [
      "You are a task planner for OpenPocket, a phone-use agent that controls an Android device.",
      "A recurring scheduled task is about to start. Your job is to create a concrete, bounded execution plan so the agent knows exactly what to do and when to stop.",
      "",
      "Output strict JSON only:",
      '{',
      '  "steps": ["step 1 description", "step 2 description", ...],',
      '  "stepBudget": <number 20-60>,',
      '  "completionCriteria": "when to call finish",',
      '  "summary": "one-line plan summary for the user"',
      '}',
      "",
      "Rules:",
      "1) Break the task into 3-8 concrete, actionable steps. Each step should be specific (e.g. 'Open X app and scroll the home feed for 2-3 posts related to Open Pocket' not 'Browse feed').",
      "2) Set stepBudget to a realistic number of agent steps needed (typically 20-60). Open-ended monitoring tasks should be capped, not infinite.",
      "3) completionCriteria must be clear and achievable within a single session. The task will trigger again later, so do NOT try to be exhaustive.",
      "4) For social media tasks: plan specific interactions (e.g. 'comment on 2-3 relevant posts', 'check profile for new replies'), not open-ended browsing.",
      "5) For monitoring tasks: do one focused pass, not continuous monitoring. The cron schedule handles repetition.",
      "6) summary should be casual and brief, suitable for sending to the user.",
      "",
      `Task: ${task}`,
    ].join("\n");

    try {
      const output = await this.callModelRaw(
        client,
        profile.model,
        Math.min(profile.maxTokens, 800),
        prompt,
        "cron task planning",
      );
      if (!output) {
        return this.buildFallbackCronTaskPlan(task);
      }

      const jsonText = extractJsonObjectText(output);
      const parsed = JSON.parse(jsonText) as Partial<CronTaskPlan>;
      return this.normalizeCronTaskPlan(task, parsed);
    } catch {
      return this.buildFallbackCronTaskPlan(task);
    }
  }

  async narrateTaskProgress(input: TaskProgressNarrationInput): Promise<TaskProgressNarrationDecision> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return this.fallbackTaskProgressNarration(input);
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    const prompt = this.buildTaskProgressNarrationPrompt(input);

    try {
      const decision = await this.requestTaskProgressNarrationDecision(
        client,
        profile.model,
        profile.maxTokens,
        prompt,
      );
      if (!decision) {
        return this.fallbackTaskProgressNarration(input);
      }
      if (!decision.notify) {
        return {
          notify: false,
          message: "",
          reason: decision.reason ?? "model_skip",
        };
      }
      const message = this.normalizeOneLine(decision.message);
      if (!message) {
        return this.fallbackTaskProgressNarration(input);
      }
      return {
        notify: true,
        message,
        reason: decision.reason ?? "model_notify",
      };
    } catch {
      return this.fallbackTaskProgressNarration(input);
    }
  }

  async narrateTaskOutcome(input: TaskOutcomeNarrationInput): Promise<string> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return this.fallbackTaskOutcomeNarration(input);
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    const prompt = this.buildTaskOutcomeNarrationPrompt(input);

    try {
      const message = await this.requestTaskOutcomeNarration(
        client,
        profile.model,
        profile.maxTokens,
        prompt,
      );
      if (!message) {
        return this.fallbackTaskOutcomeNarration(input);
      }
      const normalized = this.normalizeMultiline(message);
      if (!normalized) {
        return this.fallbackTaskOutcomeNarration(input);
      }
      return this.appendShoppingLinksIfNeeded(input, normalized);
    } catch {
      return this.fallbackTaskOutcomeNarration(input);
    }
  }

  async narrateEscalation(input: EscalationNarrationInput): Promise<string> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      return this.fallbackEscalationNarration(input);
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    const prompt = this.buildEscalationNarrationPrompt(input);

    try {
      const message = await this.requestEscalationNarration(
        client,
        profile.model,
        profile.maxTokens,
        prompt,
      );
      if (!message) {
        return this.fallbackEscalationNarration(input);
      }
      const normalized = this.normalizeOneLine(message);
      return normalized || this.fallbackEscalationNarration(input);
    } catch {
      return this.fallbackEscalationNarration(input);
    }
  }

  async reply(chatId: number, inputText: string): Promise<string> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      const codexHint = this.isOpenAiLikeBaseUrl(profile.baseUrl) && this.isCodexCliCapableModelId(profile.model)
        ? " or login with Codex CLI"
        : "";
      return `API key for model '${profile.model}' is not configured. Configure it${codexHint} and try again.`;
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });

    if (this.shouldUseCodexResponsesTransport(client, profile.model)) {
      try {
        const reply = await this.askResponses(client, profile.model, profile.maxTokens, inputText, chatId);
        this.modeHint = "responses";
        this.pushTurn(chatId, "user", inputText);
        this.pushTurn(chatId, "assistant", reply);
        return reply;
      } catch (error) {
        return `Conversation failed: codex-responses: ${formatDetailedError(error)}`;
      }
    }

    const modes: Array<"responses" | "chat" | "completions"> =
      this.modeHint === "responses"
        ? ["responses", "chat", "completions"]
        : this.modeHint === "chat"
          ? ["chat", "responses", "completions"]
          : ["completions", "responses", "chat"];

    let reply = "";
    const errors: string[] = [];

    for (const mode of modes) {
      try {
        if (mode === "responses") {
          reply = await this.askResponses(client, profile.model, profile.maxTokens, inputText, chatId);
        } else if (mode === "chat") {
          reply = await this.askChat(client, profile.model, profile.maxTokens, inputText, chatId);
        } else {
          reply = await this.askCompletions(client, profile.model, profile.maxTokens, inputText, chatId);
        }
        if (this.modeHint !== mode) {
          this.modeHint = mode;
          this.logChat("info", `switched endpoint mode=${mode}`);
        }
        break;
      } catch (error) {
        errors.push(`${mode}: ${formatDetailedError(error)}`);
      }
    }

    if (!reply) {
      return `Conversation failed: ${errors.join(" | ")}`;
    }

    this.pushTurn(chatId, "user", inputText);
    this.pushTurn(chatId, "assistant", reply);
    return reply;
  }

  async decide(chatId: number, inputText: string): Promise<ChatDecision> {
    const normalizedInput = inputText.trim();
    if (!normalizedInput) {
      return {
        mode: "chat",
        task: "",
        reply: "Please share a request and I will respond.",
        confidence: 1,
        reason: "empty_input",
      };
    }

    const onboardingReply = await this.applyBootstrapOnboarding(chatId, normalizedInput);
    if (onboardingReply) {
      this.pushTurn(chatId, "user", normalizedInput);
      this.pushTurn(chatId, "assistant", onboardingReply);
      return {
        mode: "chat",
        task: "",
        reply: onboardingReply,
        confidence: 1,
        reason: "profile_onboarding",
      };
    }

    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      const profileUpdateReply = this.applyProfileUpdate(chatId, normalizedInput);
      if (profileUpdateReply) {
        this.pushTurn(chatId, "user", normalizedInput);
        this.pushTurn(chatId, "assistant", profileUpdateReply);
        return {
          mode: "chat",
          task: "",
          reply: profileUpdateReply,
          confidence: 1,
          reason: "profile_update",
        };
      }
      return {
        mode: "chat",
        task: "",
        reply: "API key not configured. I can still answer basic questions.",
        confidence: 0.4,
        reason: "no_api_key",
      };
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });
    try {
      let extractedSchedule: ScheduleIntentExtractionDecision | null = null;
      try {
        extractedSchedule = await this.extractScheduleIntentWithModel(
          client,
          profile.model,
          profile.maxTokens,
          chatId,
          normalizedInput,
        );
      } catch (error) {
        this.logChat("warn", `schedule extraction failed error=${formatDetailedError(error)}`);
        extractedSchedule = null;
      }
      if (extractedSchedule && extractedSchedule.confidence >= MIN_SCHEDULE_INTENT_CONFIDENCE) {
        if (extractedSchedule.route === "manage_schedule") {
          return {
            mode: "task",
            task: extractedSchedule.task || normalizedInput,
            reply: "",
            taskAcceptedReply: "",
            confidence: extractedSchedule.confidence,
            reason: `schedule_manage;${extractedSchedule.reason}`,
            requiresExternalObservation: false,
            canAnswerDirectly: false,
            scheduleManagement: true,
            scheduleManagementAction: extractedSchedule.manageAction ?? "unknown",
            cronManagementIntent: extractedSchedule.cronManagementIntent ?? null,
          };
        }
        return {
          mode: "schedule_intent",
          task: extractedSchedule.intent?.normalizedTask || normalizedInput,
          reply: extractedSchedule.intent?.confirmationPrompt || "",
          taskAcceptedReply: "",
          confidence: extractedSchedule.confidence,
          reason: `schedule_intent:${extractedSchedule.intent?.schedule.kind ?? "unknown"};${extractedSchedule.reason}`,
          requiresExternalObservation: false,
          canAnswerDirectly: false,
          scheduleIntent: extractedSchedule.intent ?? null,
        };
      }

      const classified = await this.classifyWithModel(
        client,
        profile.model,
        profile.maxTokens,
        chatId,
        normalizedInput,
      );
      const audited = await this.refineChatDecisionWithGroundingAudit(
        client,
        profile.model,
        profile.maxTokens,
        normalizedInput,
        classified,
      );
      const decision = this.arbitrateRoutingDecision(normalizedInput, audited);

      if (decision.mode === "chat") {
        const profileUpdateReply = this.applyProfileUpdate(chatId, normalizedInput);
        if (profileUpdateReply) {
          this.pushTurn(chatId, "user", normalizedInput);
          this.pushTurn(chatId, "assistant", profileUpdateReply);
          return {
            mode: "chat",
            task: "",
            reply: profileUpdateReply,
            confidence: 1,
            reason: "profile_update",
          };
        }
      }

      return decision;
    } catch {
      return {
        mode: "task",
        task: normalizedInput,
        reply: "",
        confidence: 0.5,
        reason: "fallback_task",
      };
    }
  }
}
