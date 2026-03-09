import type { CronScheduleSpec } from "../types.js";

export type CronManagementAction = "list" | "update" | "remove" | "enable" | "disable" | "unknown";
export type CronManagementEnabledSelector = "any" | "enabled" | "disabled";

export interface CronManagementSelector {
  all: boolean;
  ids: string[];
  nameContains: string[];
  taskContains: string[];
  scheduleContains: string[];
  enabled: CronManagementEnabledSelector;
}

export interface CronManagementPatch {
  name: string | null;
  task: string | null;
  enabled: boolean | null;
  schedule: CronScheduleSpec | null;
}

export interface CronManagementIntent {
  action: CronManagementAction;
  selector: CronManagementSelector;
  patch: CronManagementPatch;
}

interface NormalizeCronManagementIntentOptions {
  timezone?: string;
  resolveTimezone?: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function normalizeStringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    const next = normalizeOptionalString(item);
    if (!next) {
      continue;
    }
    const key = next.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
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

function resolveScheduleTimezone(options: NormalizeCronManagementIntentOptions): string {
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

function normalizeSchedule(
  value: unknown,
  options: NormalizeCronManagementIntentOptions,
): CronScheduleSpec | null {
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

export function normalizeCronManagementAction(value: unknown): CronManagementAction {
  if (
    value === "list"
    || value === "update"
    || value === "remove"
    || value === "enable"
    || value === "disable"
  ) {
    return value;
  }
  return "unknown";
}

export function emptyCronManagementSelector(): CronManagementSelector {
  return {
    all: false,
    ids: [],
    nameContains: [],
    taskContains: [],
    scheduleContains: [],
    enabled: "any",
  };
}

export function emptyCronManagementPatch(): CronManagementPatch {
  return {
    name: null,
    task: null,
    enabled: null,
    schedule: null,
  };
}

function normalizeSelector(value: unknown): CronManagementSelector {
  if (!isObject(value)) {
    return emptyCronManagementSelector();
  }

  const enabled = value.enabled === "enabled" || value.enabled === "disabled"
    ? value.enabled
    : "any";

  return {
    all: value.all === true,
    ids: normalizeStringList(value.ids),
    nameContains: normalizeStringList(value.nameContains),
    taskContains: normalizeStringList(value.taskContains),
    scheduleContains: normalizeStringList(value.scheduleContains),
    enabled,
  };
}

function normalizePatch(
  value: unknown,
  options: NormalizeCronManagementIntentOptions,
): CronManagementPatch {
  if (!isObject(value)) {
    return emptyCronManagementPatch();
  }

  return {
    name: normalizeOptionalString(value.name),
    task: normalizeOptionalString(value.task),
    enabled: typeof value.enabled === "boolean" ? value.enabled : null,
    schedule: normalizeSchedule(value.schedule, options),
  };
}

export function hasCronManagementSelector(selector: CronManagementSelector): boolean {
  return selector.all
    || selector.ids.length > 0
    || selector.nameContains.length > 0
    || selector.taskContains.length > 0
    || selector.scheduleContains.length > 0
    || selector.enabled !== "any";
}

export function hasCronManagementPatch(patch: CronManagementPatch): boolean {
  return patch.name !== null
    || patch.task !== null
    || patch.enabled !== null
    || patch.schedule !== null;
}

export function normalizeCronManagementIntent(
  candidate: unknown,
  options: NormalizeCronManagementIntentOptions = {},
): CronManagementIntent | null {
  if (!isObject(candidate)) {
    return null;
  }

  const selector = normalizeSelector(candidate.selector);
  const patch = normalizePatch(candidate.patch, options);
  const action = normalizeCronManagementAction(candidate.action ?? candidate.manageAction);

  if (action === "enable" && patch.enabled === null) {
    patch.enabled = true;
  }
  if (action === "disable" && patch.enabled === null) {
    patch.enabled = false;
  }

  return {
    action,
    selector,
    patch,
  };
}
