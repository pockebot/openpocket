import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

import type { AgentProgressUpdate, OpenPocketConfig } from "../types";
import { getModelProfile, resolveModelAuth } from "../config";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  isWorkspaceOnboardingCompleted,
  markWorkspaceOnboardingCompleted,
} from "../memory/workspace";

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
  skillPath: string | null;
  scriptPath: string | null;
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

interface OnboardingLocaleTemplate {
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

interface OnboardingTemplate {
  version: number;
  locales: Record<OnboardingLocale, OnboardingLocaleTemplate>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROFILE_ONBOARDING_TEMPLATE_FILE = "PROFILE_ONBOARDING.json";
const BARE_SESSION_RESET_TEMPLATE_FILE = "BARE_SESSION_RESET_PROMPT.md";
const TASK_PROGRESS_REPORTER_TEMPLATE_FILE = "TASK_PROGRESS_REPORTER.md";
const TASK_OUTCOME_REPORTER_TEMPLATE_FILE = "TASK_OUTCOME_REPORTER.md";

const DEFAULT_SESSION_RESET_PROMPT: Record<OnboardingLocale, string> = {
  zh: [
    "会话已重置。请先完成 Session Startup：",
    "1) 确认当前任务目标与约束",
    "2) 读取 AGENTS.md / SOUL.md / USER.md / IDENTITY.md",
    "3) 如果 BOOTSTRAP.md 存在，先完成初始化",
    "4) 然后再进入任务执行",
  ].join("\n"),
  en: [
    "Session reset complete. Run Session Startup first:",
    "1) Reconfirm goal and constraints",
    "2) Read AGENTS.md / SOUL.md / USER.md / IDENTITY.md",
    "3) If BOOTSTRAP.md exists, finish onboarding first",
    "4) Then continue task execution",
  ].join("\n"),
};

const DEFAULT_ONBOARDING_TEMPLATE: OnboardingTemplate = {
  version: 1,
  locales: {
    zh: {
      questions: {
        1: "先做个简短初始化：我该怎么称呼你？如果你愿意，也可以一次告诉我你希望我叫什么和什么人设。",
        2: "收到。那你希望我叫什么名字？",
        3: [
          "最后一步：设定我的人设/语气。",
          "你可以直接描述，也可以选编号：",
          "1) 专业可靠：清晰、稳健、少废话",
          "2) 高效直给：结果导向、节奏快",
          "3) 温和陪伴：耐心解释、语气柔和",
          "4) 幽默轻松：轻松自然，但不影响执行",
          "回复示例：`2` 或 `专业可靠，简洁，必要时幽默`",
        ].join("\n"),
      },
      emptyAnswer: "请用一句话回答，我会帮你写入 profile。",
      onboardingSaved:
        "好，我已经写入 USER.md 和 IDENTITY.md。后续我会称呼你为“{userPreferredAddress}”，我的名字是“{assistantName}”，人设是“{assistantPersona}”。",
      noChange: "这些设定已经是当前值了，不需要改动。",
      updated: "已更新。{changes}。",
      changeJoiner: "；",
      changeTemplates: {
        userPreferredAddress: "我会称呼你为“{value}”",
        assistantName: "我的名字改为“{value}”",
        assistantPersona: "人设改为“{value}”",
      },
      fallbacks: {
        user: "用户",
        assistant: "OpenPocket",
        persona: "务实、冷静、可靠",
      },
      personaPresets: [
        {
          value: "专业可靠：清晰、稳健、少废话",
          aliases: ["1", "a", "选1", "方案1"],
        },
        {
          value: "高效直给：结果导向、节奏快",
          aliases: ["2", "b", "选2", "方案2"],
        },
        {
          value: "温和陪伴：耐心解释、语气柔和",
          aliases: ["3", "c", "选3", "方案3"],
        },
        {
          value: "幽默轻松：轻松自然，但不影响执行",
          aliases: ["4", "d", "选4", "方案4"],
        },
      ],
    },
    en: {
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
    },
  },
};

export interface ChatDecision {
  mode: "task" | "chat";
  task: string;
  reply: string;
  confidence: number;
  reason: string;
}

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

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

  constructor(config: OpenPocketConfig) {
    this.config = config;
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

  sessionResetPrompt(locale: OnboardingLocale): string {
    const raw = this.readTextSafe(this.workspaceFilePath(BARE_SESSION_RESET_TEMPLATE_FILE)).trim();
    if (!raw) {
      return DEFAULT_SESSION_RESET_PROMPT[locale];
    }

    const zhMatch = raw.match(/(?:^|\n)##\s*zh\s*\n([\s\S]*?)(?=\n##\s*en\s*\n|$)/i);
    const enMatch = raw.match(/(?:^|\n)##\s*en\s*\n([\s\S]*?)(?=\n##\s*zh\s*\n|$)/i);
    // Preserve multi-line formatting; only collapse excessive blank lines.
    const zh = (zhMatch?.[1] ?? "").replace(/\n{3,}/g, "\n\n").trim();
    const en = (enMatch?.[1] ?? "").replace(/\n{3,}/g, "\n\n").trim();

    if (zh && en) {
      return locale === "zh" ? zh : en;
    }

    return raw.replace(/\n{3,}/g, "\n\n").trim() || DEFAULT_SESSION_RESET_PROMPT[locale];
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

  private normalizeAssistantName(input: string): string {
    return this.normalizeOneLine(input)
      .replace(/[。！？.!?]+$/g, "")
      .replace(/\s*(吧|呀|呢|啦|喔|哦|好吗|可以吗)\s*$/i, "")
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

  private mergeLocaleTemplate(
    localeRaw: unknown,
    fallback: OnboardingLocaleTemplate,
  ): OnboardingLocaleTemplate {
    if (!isObject(localeRaw)) {
      return fallback;
    }

    const rawQuestions = isObject(localeRaw.questions) ? localeRaw.questions : {};
    const rawChangeTemplates = isObject(localeRaw.changeTemplates)
      ? localeRaw.changeTemplates
      : {};
    const rawFallbacks = isObject(localeRaw.fallbacks) ? localeRaw.fallbacks : {};

    return {
      questions: {
        1: this.readQuestionOrFallback(rawQuestions, 1, fallback.questions[1]),
        2: this.readQuestionOrFallback(rawQuestions, 2, fallback.questions[2]),
        3: this.readQuestionOrFallback(rawQuestions, 3, fallback.questions[3]),
      },
      emptyAnswer: this.readStringOrFallback(localeRaw.emptyAnswer, fallback.emptyAnswer),
      onboardingSaved: this.readStringOrFallback(localeRaw.onboardingSaved, fallback.onboardingSaved),
      noChange: this.readStringOrFallback(localeRaw.noChange, fallback.noChange),
      updated: this.readStringOrFallback(localeRaw.updated, fallback.updated),
      changeJoiner: this.readStringOrFallback(localeRaw.changeJoiner, fallback.changeJoiner),
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
      personaPresets: this.mergePersonaPresets(localeRaw.personaPresets, fallback.personaPresets),
    };
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

    const rawLocales = isObject(parsed) && isObject(parsed.locales) ? parsed.locales : {};
    const merged: OnboardingTemplate = {
      version:
        typeof (parsed as { version?: unknown })?.version === "number"
          ? (parsed as { version: number }).version
          : DEFAULT_ONBOARDING_TEMPLATE.version,
      locales: {
        zh: this.mergeLocaleTemplate(rawLocales.zh, DEFAULT_ONBOARDING_TEMPLATE.locales.zh),
        en: this.mergeLocaleTemplate(rawLocales.en, DEFAULT_ONBOARDING_TEMPLATE.locales.en),
      },
    };
    this.onboardingTemplateCache = {
      mtimeMs,
      template: merged,
    };
    return merged;
  }

  private localeTemplate(locale: OnboardingLocale): OnboardingLocaleTemplate {
    return this.loadOnboardingTemplate().locales[locale];
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

  private isProfileSnapshotComplete(snapshot: ProfileSnapshot, locale: OnboardingLocale): boolean {
    return !this.isPlaceholderValue(snapshot.userPreferredAddress, [this.pickFallback(locale, "user")])
      && !this.isPlaceholderValue(
        snapshot.assistantName,
        ["openpocket", this.pickFallback(locale, "assistant")],
      )
      && !this.isPlaceholderValue(snapshot.assistantPersona, [this.pickFallback(locale, "persona")]);
  }

  private applyModelProfilePatch(
    base: ProfileSnapshot,
    patch: BootstrapModelDecision["profile"] | undefined,
    locale: OnboardingLocale,
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
      next.assistantPersona = this.resolvePersonaAnswer(this.normalizeOneLine(patch.assistantPersona), locale);
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

  private detectOnboardingLocale(input: string): OnboardingLocale {
    // Use a simple CJK signal so onboarding language follows the user's first message.
    return /[\u4e00-\u9fff]/.test(input) ? "zh" : "en";
  }

  private questionForStep(step: OnboardingStep, locale: OnboardingLocale): string {
    return this.localeTemplate(locale).questions[step];
  }

  private pickFallback(locale: OnboardingLocale, key: "user" | "assistant" | "persona"): string {
    const fallbacks = this.localeTemplate(locale).fallbacks;
    if (key === "user") return fallbacks.user;
    if (key === "assistant") return fallbacks.assistant;
    return fallbacks.persona;
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
      /(?:叫我|称呼我|你可以叫我|喊我)\s*[:：]?\s*([^,，。;；\n]+)/i,
      /(?:call me|address me as|you can call me)\s+([^,.;\n]+)/i,
    ]);
    const assistantName = this.extractByPatterns(normalized, [
      /(?:你叫|你就叫|称呼你为|我叫你|我希望你叫)\s*[:：]?\s*([^,，。;；\n]+)/i,
      /(?:你(?:把)?(?:你(?:的)?)?名字(?:改成|改为|设为|设置为|叫做?)|你以后叫)\s*[:：]?\s*([^,，。;；\n]+)/i,
      /(?:call you|your name is|i want to call you)\s+([^,.;\n]+)/i,
      /(?:rename yourself to|change your name to|set your name to|call yourself)\s+([^,.;\n]+)/i,
    ]);
    const assistantPersona = this.extractByPatterns(normalized, [
      /(?:人设|风格|语气|设定)\s*[:：]?\s*([^。;；\n]+)/i,
      /(?:persona|tone|style)\s*(?:is|:)?\s*([^.;\n]+)/i,
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

  private personaPresetFromAnswer(answer: string, locale: OnboardingLocale): string {
    const normalized = this.normalizeOneLine(answer).toLowerCase();
    for (const preset of this.localeTemplate(locale).personaPresets) {
      if (preset.aliases.includes(normalized)) {
        return preset.value;
      }
    }
    return "";
  }

  private resolvePersonaAnswer(answer: string, locale: OnboardingLocale): string {
    const preset = this.personaPresetFromAnswer(answer, locale);
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
    locale: OnboardingLocale,
  ): OnboardingStep | null {
    if (this.isPlaceholderValue(snapshot.userPreferredAddress, [this.pickFallback(locale, "user")])) {
      return 1;
    }
    if (
      this.isPlaceholderValue(
        snapshot.assistantName,
        ["openpocket", this.pickFallback(locale, "assistant")],
      )
    ) {
      return 2;
    }
    if (this.isPlaceholderValue(snapshot.assistantPersona, [this.pickFallback(locale, "persona")])) {
      return 3;
    }
    return null;
  }

  private bootstrapFallbackQuestion(locale: OnboardingLocale, snapshot: ProfileSnapshot): string {
    const step = this.firstMissingSnapshotStep(snapshot, locale);
    if (step === null) {
      return locale === "zh"
        ? "初始化信息我已经拿到了。你可以直接告诉我要做什么。"
        : "I already have your onboarding profile. Tell me what you want to do next.";
    }
    return this.questionForStep(step, locale);
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
    return `${normalized.slice(0, Math.max(0, maxChars - 12))}...[truncated]`;
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
      "5) Use conversational tone. Avoid repeating the same opening pattern across updates.",
      "6) Do not expose internal mechanics (model, filters, callbacks, tools).",
      "7) If notify=false, message must be empty string.",
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
      "2) If success and rawResult has data (numbers/facts), surface those first.",
      "3) Do not start with 'Task completed' unless no better data exists.",
      "4) If failure, explain key reason and one practical next move.",
      "5) If reusable artifacts were generated, mention reuse in one short natural sentence.",
      "6) Use locale hint language.",
      "7) Keep concise and natural; do not expose internal logs.",
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

  private async requestBootstrapOnboardingDecision(
    client: OpenAI,
    model: string,
    maxTokens: number,
    prompt: string,
  ): Promise<BootstrapModelDecision | null> {
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
            max_output_tokens: Math.min(maxTokens, 500),
            input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          } as never);
          output = readResponseOutputText(response);
        } else if (mode === "chat") {
          const response = await client.chat.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 500),
            messages: [{ role: "user", content: prompt }],
          } as never);
          output = typeof response.choices?.[0]?.message?.content === "string"
            ? response.choices?.[0]?.message?.content.trim()
            : "";
        } else {
          const response = await client.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 500),
            prompt,
          } as never);
          output = (response.choices?.[0]?.text ?? "").trim();
        }

        if (!output) {
          continue;
        }
        if (this.modeHint !== mode) {
          this.modeHint = mode;
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][chat] switched endpoint mode -> ${mode}`);
        }
        break;
      } catch (error) {
        errors.push(`${mode}: ${stringifyError(error)}`);
      }
    }

    if (!output) {
      // eslint-disable-next-line no-console
      console.warn(`[OpenPocket][chat] bootstrap onboarding failed: ${errors.join(" | ")}`);
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
            max_output_tokens: Math.min(maxTokens, 260),
            input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          } as never);
          output = readResponseOutputText(response);
        } else if (mode === "chat") {
          const response = await client.chat.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 260),
            messages: [{ role: "user", content: prompt }],
          } as never);
          output = typeof response.choices?.[0]?.message?.content === "string"
            ? response.choices?.[0]?.message?.content.trim()
            : "";
        } else {
          const response = await client.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 260),
            prompt,
          } as never);
          output = (response.choices?.[0]?.text ?? "").trim();
        }

        if (!output) {
          continue;
        }
        if (this.modeHint !== mode) {
          this.modeHint = mode;
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][chat] switched endpoint mode -> ${mode}`);
        }
        break;
      } catch (error) {
        errors.push(`${mode}: ${stringifyError(error)}`);
      }
    }

    if (!output) {
      // eslint-disable-next-line no-console
      console.warn(`[OpenPocket][chat] progress narration failed: ${errors.join(" | ")}`);
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
            max_output_tokens: Math.min(maxTokens, 300),
            input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          } as never);
          output = readResponseOutputText(response);
        } else if (mode === "chat") {
          const response = await client.chat.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 300),
            messages: [{ role: "user", content: prompt }],
          } as never);
          output = typeof response.choices?.[0]?.message?.content === "string"
            ? response.choices?.[0]?.message?.content.trim()
            : "";
        } else {
          const response = await client.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 300),
            prompt,
          } as never);
          output = (response.choices?.[0]?.text ?? "").trim();
        }

        if (!output) {
          continue;
        }
        if (this.modeHint !== mode) {
          this.modeHint = mode;
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][chat] switched endpoint mode -> ${mode}`);
        }
        break;
      } catch (error) {
        errors.push(`${mode}: ${stringifyError(error)}`);
      }
    }

    if (!output) {
      // eslint-disable-next-line no-console
      console.warn(`[OpenPocket][chat] task outcome narration failed: ${errors.join(" | ")}`);
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

  private readProfileSnapshot(locale: OnboardingLocale): ProfileSnapshot {
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
        ? this.pickFallback(locale, "user")
        : userPreferredAddressRaw,
      assistantName: this.isPlaceholderValue(assistantNameRaw, ["openpocket"])
        ? this.pickFallback(locale, "assistant")
        : assistantNameRaw,
      assistantPersona: this.isPlaceholderValue(assistantPersonaRaw)
        ? this.pickFallback(locale, "persona")
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
      profile: this.readProfileSnapshot(locale),
      turns: [],
    };

    if (parsedFromInput.userPreferredAddress) {
      state.profile.userPreferredAddress = parsedFromInput.userPreferredAddress;
    }
    if (parsedFromInput.assistantName) {
      state.profile.assistantName = this.normalizeAssistantName(parsedFromInput.assistantName);
    }
    if (parsedFromInput.assistantPersona) {
      state.profile.assistantPersona = this.resolvePersonaAnswer(parsedFromInput.assistantPersona, locale);
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
    if (continuingFlow && userLine && !parsedStructured) {
      const step = this.firstMissingSnapshotStep(state.profile, locale);
      if (step === 1) {
        state.profile.userPreferredAddress = userLine;
      } else if (step === 2) {
        state.profile.assistantName = this.normalizeAssistantName(userLine);
      } else if (step === 3) {
        state.profile.assistantPersona = this.resolvePersonaAnswer(userLine, locale);
      }
    }

    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      if (this.isProfileSnapshotComplete(state.profile, locale)) {
        this.completeWorkspaceBootstrap(state.profile);
        this.bootstrapOnboarding.delete(chatId);
        this.profileOnboarding.delete(chatId);
        this.pendingProfileUpdates.set(chatId, {
          assistantName: state.profile.assistantName,
          locale,
        });
        return this.renderTemplate(this.localeTemplate(locale).onboardingSaved, {
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
      return this.bootstrapFallbackQuestion(locale, state.profile);
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
      if (this.isProfileSnapshotComplete(state.profile, locale)) {
        this.completeWorkspaceBootstrap(state.profile);
        this.bootstrapOnboarding.delete(chatId);
        this.profileOnboarding.delete(chatId);
        this.pendingProfileUpdates.set(chatId, {
          assistantName: state.profile.assistantName,
          locale,
        });
        return this.renderTemplate(this.localeTemplate(locale).onboardingSaved, {
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
      return this.bootstrapFallbackQuestion(locale, state.profile);
    }

    state.profile = this.applyModelProfilePatch(state.profile, decision.profile, locale);
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
      this.isProfileSnapshotComplete(state.profile, locale) && !this.hasBootstrapOnboardingFile();
    const shouldComplete =
      (completeByModel && this.isProfileSnapshotComplete(state.profile, locale)) || completeByData;
    if (!shouldComplete) {
      return decision.reply;
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

    const parsed = this.parseOnboardingFields(inputText);
    if (!parsed.userPreferredAddress && !parsed.assistantName && !parsed.assistantPersona) {
      return null;
    }

    const locale = this.detectOnboardingLocale(inputText);
    const template = this.localeTemplate(locale);
    const current = this.readProfileSnapshot(locale);
    const next: ProfileSnapshot = {
      userPreferredAddress: parsed.userPreferredAddress ?? current.userPreferredAddress,
      assistantName: parsed.assistantName ?? current.assistantName,
      assistantPersona: parsed.assistantPersona
        ? this.resolvePersonaAnswer(parsed.assistantPersona, locale)
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
          state.assistantPersona = this.resolvePersonaAnswer(parsed.assistantPersona, state.locale);
        }
        this.applyThreePartFallback(state, answer);
        const firstMissing = this.firstMissingStep(state);
        if (firstMissing) {
          state.step = firstMissing;
          this.profileOnboarding.set(chatId, state);
          return this.questionForStep(firstMissing, state.locale);
        }
        this.profileOnboarding.set(chatId, state);
      } else {
        this.profileOnboarding.set(chatId, state);
        return this.questionForStep(1, locale);
      }
    } else if (!answer) {
      return this.localeTemplate(current.locale).emptyAnswer;
    } else {
      const parsed = this.parseOnboardingFields(answer);

      if (parsed.userPreferredAddress) current.userPreferredAddress = parsed.userPreferredAddress;
      if (parsed.assistantName) current.assistantName = parsed.assistantName;
      if (parsed.assistantPersona) {
        current.assistantPersona = this.resolvePersonaAnswer(parsed.assistantPersona, current.locale);
      }
      this.applyThreePartFallback(current, answer);

      // If user answered naturally without keywords, map answer to current step.
      if (current.step === 1 && !current.userPreferredAddress) {
        current.userPreferredAddress = answer;
      } else if (current.step === 2 && !current.assistantName) {
        current.assistantName = answer;
      } else if (current.step === 3 && !current.assistantPersona) {
        current.assistantPersona = this.resolvePersonaAnswer(answer, current.locale);
      }

      const firstMissing = this.firstMissingStep(current);
      if (firstMissing) {
        current.step = firstMissing;
        this.profileOnboarding.set(chatId, current);
        return this.questionForStep(firstMissing, current.locale);
      }
    }

    const finalized = this.profileOnboarding.get(chatId);
    if (!finalized) {
      return null;
    }
    const userPreferredAddress = finalized.userPreferredAddress ?? this.pickFallback(finalized.locale, "user");
    const assistantName = finalized.assistantName ?? this.pickFallback(finalized.locale, "assistant");
    const assistantPersona = finalized.assistantPersona ?? this.pickFallback(finalized.locale, "persona");
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
    return this.renderTemplate(this.localeTemplate(finalized.locale).onboardingSaved, {
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
      "Do not expose internal file paths, session files, skills, or scripts in user-facing replies.",
      "For requests that are not device automation tasks, answer directly in chat.",
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

  private async classifyWithModel(
    client: OpenAI,
    model: string,
    maxTokens: number,
    inputText: string,
  ): Promise<ChatDecision> {
    const prompt = [
      "Classify the user message for phone assistant routing.",
      "Output strict JSON only:",
      '{"mode":"task|chat","task":"<task or empty>","reply":"<chat reply or empty>","confidence":0-1,"reason":"..."}',
      "Rules:",
      "1) mode=task when user wants the assistant to operate phone/apps.",
      "2) mode=chat for small talk, explanation, status discussion, and generic questions.",
      "3) task should be executable imperative sentence.",
      "4) for chat mode, reply should be concise.",
      `User message: ${inputText}`,
    ].join("\n");

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
            max_output_tokens: Math.min(maxTokens, 300),
            input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          } as never);
          output = readResponseOutputText(response);
        } else if (mode === "chat") {
          const response = await client.chat.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 300),
            messages: [{ role: "user", content: prompt }],
          } as never);
          output = typeof response.choices?.[0]?.message?.content === "string"
            ? response.choices?.[0]?.message?.content.trim()
            : "";
        } else {
          const response = await client.completions.create({
            model,
            max_tokens: Math.min(maxTokens, 300),
            prompt,
          } as never);
          output = (response.choices?.[0]?.text ?? "").trim();
        }

        if (output) {
          if (this.modeHint !== mode) {
            this.modeHint = mode;
            // eslint-disable-next-line no-console
            console.log(`[OpenPocket][chat] switched endpoint mode -> ${mode}`);
          }
          break;
        }
      } catch (error) {
        errors.push(`${mode}: ${stringifyError(error)}`);
      }
    }

    if (!output) {
      throw new Error(`classify failed: ${errors.join(" | ")}`);
    }

    const jsonText = (() => {
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
    })();

    try {
      const parsed = JSON.parse(jsonText) as Partial<ChatDecision>;
      const mode = parsed.mode === "task" ? "task" : "chat";
      return {
        mode,
        task: typeof parsed.task === "string" ? parsed.task.trim() : "",
        reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
        confidence:
          typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
            ? parsed.confidence
            : 0.5,
        reason: typeof parsed.reason === "string" ? parsed.reason : "model_classify",
      };
    } catch {
      return {
        mode: "chat",
        task: "",
        reply: "",
        confidence: 0.3,
        reason: "model_output_not_json",
      };
    }
  }

  private async askResponses(client: OpenAI, model: string, maxTokens: number, inputText: string, chatId: number): Promise<string> {
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

  private fallbackTaskProgressNarration(input: TaskProgressNarrationInput): TaskProgressNarrationDecision {
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

    const app = this.trimForPrompt(input.progress.currentApp || "unknown", 120);
    const summary = this.trimForPrompt(input.progress.thought || input.progress.message || "", 180);
    const messageText = input.locale === "zh"
      ? `小更新：我还在 ${app}，刚做了 ${input.progress.actionType}${summary ? `，${summary}` : ""}。`
      : `Quick update: still on ${app}, I just ran ${input.progress.actionType}${summary ? `, ${summary}` : ""}.`;

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
      .replace(/^完成(了|。|!|！)?\s*/i, "")
      .trim();
  }

  private fallbackTaskOutcomeNarration(input: TaskOutcomeNarrationInput): string {
    const cleaned = this.sanitizeOutcomeBoilerplate(input.rawResult);
    const base = cleaned || (input.ok
      ? (input.locale === "zh" ? "结果已获取，但可用细节较少。" : "I got the result, but details are limited.")
      : this.trimForPrompt(input.rawResult, 400));
    const reuseNote =
      input.ok && (input.skillPath || input.scriptPath)
        ? (input.locale === "zh"
          ? "另外，我已把这次流程沉淀成可复用的自动化资产，下次可以更快复用。"
          : "Also, I saved this workflow as reusable automation assets for faster reuse next time.")
        : "";
    return reuseNote ? `${base}\n${reuseNote}` : base;
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
      const normalized = this.normalizeOneLine(message);
      return normalized || this.fallbackTaskOutcomeNarration(input);
    } catch {
      return this.fallbackTaskOutcomeNarration(input);
    }
  }

  async reply(chatId: number, inputText: string): Promise<string> {
    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
      const codexHint = profile.model.toLowerCase().includes("codex")
        ? " or login with Codex CLI"
        : "";
      return `API key for model '${profile.model}' is not configured. Configure it${codexHint} and try again.`;
    }

    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: auth.baseUrl ?? profile.baseUrl,
    });

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
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][chat] switched endpoint mode -> ${mode}`);
        }
        break;
      } catch (error) {
        errors.push(`${mode}: ${stringifyError(error)}`);
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

    const profile = getModelProfile(this.config);
    const auth = resolveModelAuth(profile);
    if (!auth) {
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
      const decided = await this.classifyWithModel(
        client,
        profile.model,
        profile.maxTokens,
        normalizedInput,
      );
      if (decided.mode === "task" && !decided.task) {
        decided.task = normalizedInput;
      }
      return decided;
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
