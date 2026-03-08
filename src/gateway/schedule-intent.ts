import type { ScheduleIntent } from "../types.js";

export type ScheduleIntentLocale = "zh" | "en";

interface NormalizeScheduleIntentOptions {
  timezone?: string;
  resolveTimezone?: () => string;
  locale?: ScheduleIntentLocale | null;
}

interface ScheduleIntentLocalePack {
  confirmationPrompt(summaryText: string, taskText: string): string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCHEDULE_INTENT_LOCALE_PACKS: Record<ScheduleIntentLocale, ScheduleIntentLocalePack> = {
  zh: {
    confirmationPrompt(summaryText, taskText) {
      return `I understand this as a scheduled job: ${summaryText}, task "${taskText}". Reply "confirm" to create it or "cancel" to discard it.`;
    },
  },
  en: {
    confirmationPrompt(summaryText, taskText) {
      return `I understand this as a scheduled job: ${summaryText}, task "${taskText}". Reply "confirm" to create it or "cancel" to discard it.`;
    },
  },
};

export function inferScheduleIntentLocale(input: string): ScheduleIntentLocale {
  return /[\u3400-\u9fff]/u.test(input) ? "zh" : "en";
}

export function normalizeScheduleIntentCandidate(
  sourceText: string,
  candidate: unknown,
  options: NormalizeScheduleIntentOptions = {},
): ScheduleIntent | null {
  if (!isObject(candidate) || candidate.isScheduleIntent === false) {
    return null;
  }

  const normalizedTask = normalizeOneLine(String(candidate.task ?? ""));
  const schedule = normalizeSchedule(candidate.schedule, options);
  if (!normalizedTask || !schedule) {
    return null;
  }

  const normalizedSourceText = normalizeOneLine(sourceText);
  const locale = options.locale ?? inferScheduleIntentLocale(normalizedSourceText || normalizedTask);
  const localePack = SCHEDULE_INTENT_LOCALE_PACKS[locale];

  return {
    sourceText: normalizedSourceText,
    normalizedTask,
    schedule,
    delivery: null,
    requiresConfirmation: true,
    confirmationPrompt: localePack.confirmationPrompt(schedule.summaryText, normalizedTask),
  };
}

function normalizeSchedule(
  value: unknown,
  options: NormalizeScheduleIntentOptions,
): ScheduleIntent["schedule"] | null {
  if (!isObject(value)) {
    return null;
  }

  const kind = value.kind;
  if (kind !== "cron" && kind !== "at" && kind !== "every") {
    return null;
  }

  const expr = normalizeOptionalString(value.expr);
  const at = normalizeOptionalString(value.at);
  const summaryText = normalizeOneLine(String(value.summaryText ?? ""));
  const everyMs = toFinitePositiveNumber(value.everyMs);
  const tz = normalizeOptionalString(value.tz) ?? resolveScheduleTimezone(options);

  if (!summaryText) {
    return null;
  }
  if (kind === "cron" && !expr) {
    return null;
  }
  if (kind === "at" && !at) {
    return null;
  }
  if (kind === "every" && everyMs === null) {
    return null;
  }

  return {
    kind,
    expr: expr ?? null,
    at: at ?? null,
    everyMs: everyMs ?? null,
    tz,
    summaryText,
  };
}

function normalizeOneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = normalizeOneLine(String(value));
  return normalized || null;
}

function toFinitePositiveNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.max(1, parsed);
}

function resolveScheduleTimezone(options: NormalizeScheduleIntentOptions): string {
  const fromResolver = options.resolveTimezone?.();
  if (fromResolver && fromResolver.trim()) {
    return fromResolver.trim();
  }
  const fromOption = options.timezone?.trim();
  if (fromOption) {
    return fromOption;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
