import type { CronTimezoneSource, ScheduleIntent } from "../types.js";
import {
  normalizeCronManagementIntent,
  type CronManagementAction,
  type CronManagementIntent,
} from "./cron-management-intent.js";

export type ScheduleIntentLocale = "zh" | "en";
export type ScheduleManageAction = CronManagementAction;
export type NormalizedScheduleIntentDecision =
  | { route: "create_schedule"; intent: ScheduleIntent }
  | {
    route: "manage_schedule";
    task: string;
    manageAction: ScheduleManageAction;
    cronManagement: CronManagementIntent;
  };

interface NormalizeScheduleIntentOptions {
  timezone?: string;
  resolveTimezone?: () => string;
}

type NormalizedScheduleValue = {
  schedule: ScheduleIntent["schedule"];
  timezoneSource: CronTimezoneSource;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inferScheduleIntentLocale(input: string): ScheduleIntentLocale {
  return /[㐀-鿿]/u.test(input) ? "zh" : "en";
}

export function normalizeScheduleIntentDecision(
  sourceText: string,
  candidate: unknown,
  options: NormalizeScheduleIntentOptions = {},
): NormalizedScheduleIntentDecision | null {
  if (!isObject(candidate)) {
    return null;
  }

  if (candidate.route === "manage_schedule") {
    const normalizedTask = normalizeOneLine(String(candidate.task ?? sourceText));
    const cronManagementSource = isObject(candidate.manageIntent)
      ? {
        ...candidate.manageIntent,
        action: candidate.manageIntent.action ?? candidate.action ?? candidate.manageAction,
      }
      : candidate;
    const cronManagement = normalizeCronManagementIntent(cronManagementSource, options);
    if (!normalizedTask) {
      return null;
    }
    if (!cronManagement) {
      return null;
    }
    return {
      route: "manage_schedule",
      task: normalizedTask,
      manageAction: cronManagement.action,
      cronManagement,
    };
  }

  const isCreateSchedule = candidate.route === "create_schedule" || candidate.isScheduleIntent === true;
  if (!isCreateSchedule || candidate.isScheduleIntent === false) {
    return null;
  }

  const normalizedTask = normalizeOneLine(String(candidate.task ?? ""));
  const normalizedSchedule = normalizeSchedule(candidate.schedule, options);
  if (!normalizedTask || !normalizedSchedule) {
    return null;
  }
  const { schedule, timezoneSource } = normalizedSchedule;

  const normalizedSourceText = normalizeOneLine(sourceText);

  return {
    route: "create_schedule",
    intent: {
      sourceText: normalizedSourceText,
      normalizedTask,
      schedule,
      timezoneSource,
      delivery: null,
      requiresConfirmation: true,
      confirmationPrompt: buildScheduleIntentConfirmationPrompt(
        schedule.summaryText,
        schedule.tz,
        normalizedTask,
        timezoneSource,
      ),
    },
  };
}

export function normalizeScheduleIntentCandidate(
  sourceText: string,
  candidate: unknown,
  options: NormalizeScheduleIntentOptions = {},
): ScheduleIntent | null {
  const decision = normalizeScheduleIntentDecision(sourceText, candidate, options);
  return decision?.route === "create_schedule" ? decision.intent : null;
}

export function buildScheduleIntentConfirmationPrompt(
  summaryText: string,
  timezone: string,
  taskText: string,
  timezoneSource: CronTimezoneSource = "explicit",
): string {
  if (timezoneSource === "default") {
    return [
      `I understand this as a scheduled job: ${summaryText} (${timezone}), task "${taskText}".`,
      "I used your default timezone because you did not specify one.",
      'Reply "confirm" to create it, "cancel" to discard it, or send a different timezone such as "Asia/Shanghai".',
    ].join(" ");
  }
  return `I understand this as a scheduled job: ${summaryText} (${timezone}), task "${taskText}". Reply "confirm" to create it or "cancel" to discard it.`;
}

function normalizeSchedule(
  value: unknown,
  options: NormalizeScheduleIntentOptions,
): NormalizedScheduleValue | null {
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
  const suppliedTimezone = normalizeOptionalString(value.tz);
  const tz = suppliedTimezone ?? resolveScheduleTimezone(options);
  const declaredTimezoneSource = normalizeTimezoneSource(value.timezoneSource);
  const timezoneSource: CronTimezoneSource =
    suppliedTimezone && declaredTimezoneSource === "explicit"
      ? "explicit"
      : "default";

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
    schedule: {
      kind,
      expr: expr ?? null,
      at: at ?? null,
      everyMs: everyMs ?? null,
      tz,
      summaryText,
    },
    timezoneSource,
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

function normalizeTimezoneSource(value: unknown): CronTimezoneSource | null {
  return value === "explicit" || value === "default" ? value : null;
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
