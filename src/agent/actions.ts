import type { AgentAction, BatchableAgentAction, HumanAuthCapability } from "../types.js";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toOptionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

const HUMAN_AUTH_CAPABILITIES = new Set([
  "camera",
  "photos",
  "qr",
  "microphone",
  "voice",
  "nfc",
  "sms",
  "2fa",
  "location",
  "biometric",
  "notification",
  "contacts",
  "calendar",
  "files",
  "oauth",
  "payment",
  "permission",
  "unknown",
]);

function normalizeBatchActionItem(input: unknown): BatchableAgentAction | null {
  if (!isObject(input)) {
    return null;
  }
  const rawType = String(input.type ?? input.actionType ?? "").trim();
  const type = rawType === "type_text" ? "type" : rawType;

  if (type === "tap") {
    let x = toNumber(input.x, NaN);
    let y = toNumber(input.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const arr = Array.isArray(input.coordinate) ? input.coordinate
        : Array.isArray(input.position) ? input.position
        : null;
      if (arr && arr.length >= 2) {
        x = toNumber(arr[0], 0);
        y = toNumber(arr[1], 0);
      } else {
        x = Number.isFinite(x) ? x : 0;
        y = Number.isFinite(y) ? y : 0;
      }
    }
    return {
      type,
      x,
      y,
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "tap_element") {
    return {
      type,
      elementId: String(input.elementId ?? input.id ?? "").trim(),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "swipe") {
    return {
      type,
      x1: toNumber(input.x1, 0),
      y1: toNumber(input.y1, 0),
      x2: toNumber(input.x2, 0),
      y2: toNumber(input.y2, 0),
      durationMs: toNumber(input.durationMs, 300),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "drag") {
    return {
      type,
      x1: toNumber(input.x1, 0),
      y1: toNumber(input.y1, 0),
      x2: toNumber(input.x2, 0),
      y2: toNumber(input.y2, 0),
      durationMs: toNumber(input.durationMs, 360),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "long_press_drag") {
    return {
      type,
      x1: toNumber(input.x1, 0),
      y1: toNumber(input.y1, 0),
      x2: toNumber(input.x2, 0),
      y2: toNumber(input.y2, 0),
      holdMs: toNumber(input.holdMs, 450),
      durationMs: toNumber(input.durationMs, 300),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "type") {
    return {
      type,
      text: String(input.text ?? ""),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "keyevent") {
    return {
      type,
      keycode: String(input.keycode ?? "KEYCODE_ENTER"),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "wait") {
    return {
      type,
      durationMs: toNumber(input.durationMs, 1000),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  return null;
}

export function normalizeAction(input: unknown): AgentAction {
  if (!isObject(input)) {
    return { type: "wait", durationMs: 1000, reason: "invalid action payload" };
  }

  const type = String(input.type ?? "").trim();

  if (type === "tap") {
    let x = toNumber(input.x, NaN);
    let y = toNumber(input.y, NaN);
    // Some models return coordinates as an array: coordinate: [x, y] or position: [x, y]
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const arr = Array.isArray(input.coordinate) ? input.coordinate
        : Array.isArray(input.position) ? input.position
        : null;
      if (arr && arr.length >= 2) {
        x = toNumber(arr[0], 0);
        y = toNumber(arr[1], 0);
      } else {
        x = Number.isFinite(x) ? x : 0;
        y = Number.isFinite(y) ? y : 0;
      }
    }
    return {
      type,
      x,
      y,
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "tap_element") {
    return {
      type,
      elementId: String(input.elementId ?? input.id ?? "").trim(),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "swipe") {
    return {
      type,
      x1: toNumber(input.x1, 0),
      y1: toNumber(input.y1, 0),
      x2: toNumber(input.x2, 0),
      y2: toNumber(input.y2, 0),
      durationMs: toNumber(input.durationMs, 300),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "drag") {
    return {
      type,
      x1: toNumber(input.x1, 0),
      y1: toNumber(input.y1, 0),
      x2: toNumber(input.x2, 0),
      y2: toNumber(input.y2, 0),
      durationMs: toNumber(input.durationMs, 360),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "long_press_drag") {
    return {
      type,
      x1: toNumber(input.x1, 0),
      y1: toNumber(input.y1, 0),
      x2: toNumber(input.x2, 0),
      y2: toNumber(input.y2, 0),
      holdMs: toNumber(input.holdMs, 450),
      durationMs: toNumber(input.durationMs, 300),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "type") {
    return {
      type,
      text: String(input.text ?? ""),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "keyevent") {
    return {
      type,
      keycode: String(input.keycode ?? "KEYCODE_ENTER"),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "launch_app") {
    return {
      type,
      packageName: String(input.packageName ?? ""),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "shell") {
    return {
      type,
      command: String(input.command ?? ""),
      useShellWrap: Boolean(input.useShellWrap),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "batch_actions") {
    const items = Array.isArray(input.actions)
      ? input.actions
        .map((item) => normalizeBatchActionItem(item))
        .filter((item): item is BatchableAgentAction => item !== null)
        .slice(0, 6)
      : [];
    return {
      type,
      actions: items.length > 0 ? items : [{ type: "wait", durationMs: 500, reason: "empty batch" }],
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "run_script") {
    return {
      type,
      script: String(input.script ?? ""),
      timeoutSec: toNumber(input.timeoutSec, 60),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "cron_add") {
    return {
      type,
      id: String(input.id ?? ""),
      name: String(input.name ?? ""),
      schedule: {
        kind:
          input.schedule && isObject(input.schedule) && typeof input.schedule.kind === "string"
            ? (input.schedule.kind === "cron" || input.schedule.kind === "at" || input.schedule.kind === "every"
              ? input.schedule.kind
              : "cron")
            : "cron",
        expr: input.schedule && isObject(input.schedule) ? toOptionalTrimmedString(input.schedule.expr) ?? null : null,
        at: input.schedule && isObject(input.schedule) ? toOptionalTrimmedString(input.schedule.at) ?? null : null,
        everyMs: input.schedule && isObject(input.schedule) && input.schedule.everyMs != null
          ? toNumber(input.schedule.everyMs, 0)
          : null,
        tz: input.schedule && isObject(input.schedule)
          ? String(input.schedule.tz ?? "UTC")
          : "UTC",
        summaryText: input.schedule && isObject(input.schedule)
          ? String(input.schedule.summaryText ?? "")
          : "",
      },
      task: String(input.task ?? ""),
      channel: toOptionalTrimmedString(input.channel),
      to: toOptionalTrimmedString(input.to),
      model: toOptionalTrimmedString(input.model),
      promptMode:
        input.promptMode === "full" || input.promptMode === "minimal" || input.promptMode === "none"
          ? input.promptMode
          : undefined,
      runOnStartup: input.runOnStartup === true,
      createdBy: toOptionalTrimmedString(input.createdBy),
      sourceChannel: toOptionalTrimmedString(input.sourceChannel),
      sourcePeerId: toOptionalTrimmedString(input.sourcePeerId),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "cron_list") {
    return {
      type,
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "cron_remove") {
    return {
      type,
      id: String(input.id ?? ""),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "cron_update") {
    return {
      type,
      id: String(input.id ?? ""),
      name: toOptionalTrimmedString(input.name),
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
      task: toOptionalTrimmedString(input.task),
      schedule: input.schedule && isObject(input.schedule)
        ? {
          kind:
            typeof input.schedule.kind === "string" &&
              (input.schedule.kind === "cron" || input.schedule.kind === "at" || input.schedule.kind === "every")
              ? input.schedule.kind
              : "cron",
          expr: toOptionalTrimmedString(input.schedule.expr) ?? null,
          at: toOptionalTrimmedString(input.schedule.at) ?? null,
          everyMs: input.schedule.everyMs != null ? toNumber(input.schedule.everyMs, 0) : null,
          tz: String(input.schedule.tz ?? "UTC"),
          summaryText: String(input.schedule.summaryText ?? ""),
        }
        : undefined,
      channel: toOptionalTrimmedString(input.channel),
      to: toOptionalTrimmedString(input.to),
      model: toOptionalTrimmedString(input.model),
      promptMode:
        input.promptMode === "full" || input.promptMode === "minimal" || input.promptMode === "none"
          ? input.promptMode
          : undefined,
      runOnStartup: typeof input.runOnStartup === "boolean" ? input.runOnStartup : undefined,
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "runtime_info") {
    return {
      type,
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "read") {
    return {
      type,
      path: String(input.path ?? ""),
      from: toNumber(input.from, 1),
      lines: toNumber(input.lines, 200),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "write") {
    return {
      type,
      path: String(input.path ?? ""),
      content: String(input.content ?? ""),
      append: Boolean(input.append),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "edit") {
    return {
      type,
      path: String(input.path ?? ""),
      find: String(input.find ?? ""),
      replace: String(input.replace ?? ""),
      replaceAll: Boolean(input.replaceAll),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "apply_patch") {
    return {
      type,
      input: String(input.input ?? ""),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "exec") {
    return {
      type,
      command: String(input.command ?? ""),
      workdir: input.workdir ? String(input.workdir) : undefined,
      yieldMs: toNumber(input.yieldMs, 0),
      background: Boolean(input.background),
      timeoutSec: toNumber(input.timeoutSec, 1800),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "process") {
    const action = String(input.action ?? "").trim().toLowerCase();
    return {
      type,
      action: (
        action === "list" ||
        action === "poll" ||
        action === "log" ||
        action === "write" ||
        action === "kill"
      )
        ? action
        : "list",
      sessionId: input.sessionId ? String(input.sessionId) : undefined,
      input: input.input ? String(input.input) : undefined,
      offset: toNumber(input.offset, 0),
      limit: toNumber(input.limit, 200),
      timeoutMs: toNumber(input.timeoutMs, 0),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "memory_search") {
    return {
      type,
      query: String(input.query ?? ""),
      maxResults: toNumber(input.maxResults, 6),
      minScore: toNumber(input.minScore, 0.2),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "memory_get") {
    return {
      type,
      path: String(input.path ?? ""),
      from: toNumber(input.from, 1),
      lines: toNumber(input.lines, 120),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "send_media") {
    const mediaTypeRaw = String(input.mediaType ?? "auto").trim().toLowerCase();
    const mediaType =
      mediaTypeRaw === "image" || mediaTypeRaw === "file" || mediaTypeRaw === "voice"
        ? mediaTypeRaw
        : "auto";
    return {
      type,
      path: String(input.path ?? ""),
      mediaType,
      caption: toOptionalTrimmedString(input.caption),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "request_human_auth") {
    const capabilityRaw = String(input.capability ?? "unknown").trim().toLowerCase();
    const uiTemplate = isObject(input.uiTemplate) ? input.uiTemplate : undefined;
    const templatePath = toOptionalTrimmedString(input.templatePath ?? input.templateFile);
    return {
      type,
      capability: HUMAN_AUTH_CAPABILITIES.has(capabilityRaw)
        ? (capabilityRaw as HumanAuthCapability)
        : "unknown",
      instruction: String(
        input.instruction ?? input.reason ?? "Human authorization is required to continue.",
      ),
      timeoutSec: toNumber(input.timeoutSec, 300),
      reason: input.reason ? String(input.reason) : undefined,
      uiTemplate,
      templatePath,
    };
  }

  if (type === "request_user_decision") {
    const options = Array.isArray(input.options)
      ? input.options
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .slice(0, 8)
      : [];
    return {
      type,
      question: String(input.question ?? input.instruction ?? "Please choose one option."),
      options,
      timeoutSec: toNumber(input.timeoutSec, 300),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "request_user_input") {
    return {
      type,
      question: String(input.question ?? input.instruction ?? "Please provide the requested value."),
      placeholder: toOptionalTrimmedString(input.placeholder ?? input.hint),
      timeoutSec: toNumber(input.timeoutSec, 300),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "todo_write") {
    const opRaw = String(input.op ?? "add").trim().toLowerCase();
    const op = (
      opRaw === "add" ||
      opRaw === "update" ||
      opRaw === "complete" ||
      opRaw === "delete"
    ) ? opRaw : "add";
    const statusRaw = String(input.status ?? "").trim().toLowerCase();
    const status = (
      statusRaw === "pending" ||
      statusRaw === "in_progress" ||
      statusRaw === "done"
    )
      ? statusRaw
      : undefined;
    const tags = Array.isArray(input.tags)
      ? input.tags.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 12)
      : undefined;
    return {
      type,
      op: op as any,
      id: toOptionalTrimmedString(input.id),
      text: toOptionalTrimmedString(input.text),
      status: status as any,
      tags,
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "evidence_add") {
    const fields = isObject(input.fields) ? input.fields : undefined;
    const source = isObject(input.source) ? input.source : undefined;
    const confidence = input.confidence === undefined ? undefined : toNumber(input.confidence, NaN);
    return {
      type,
      kind: String(input.kind ?? "").trim(),
      title: String(input.title ?? "").trim(),
      fields,
      source,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "artifact_add") {
    return {
      type,
      kind: String(input.kind ?? "").trim(),
      value: String(input.value ?? "").trim(),
      description: toOptionalTrimmedString(input.description),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "journal_read") {
    const scopeRaw = String(input.scope ?? "all").trim().toLowerCase();
    const scope = (
      scopeRaw === "todos" ||
      scopeRaw === "evidence" ||
      scopeRaw === "artifacts" ||
      scopeRaw === "all"
    ) ? scopeRaw : "all";
    return {
      type,
      scope: scope as any,
      limit: toNumber(input.limit, 20),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "journal_checkpoint") {
    return {
      type,
      name: String(input.name ?? "").trim(),
      notes: toOptionalTrimmedString(input.notes),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  if (type === "finish") {
    return {
      type,
      message: String(input.message ?? "Task finished."),
    };
  }

  if (type === "wait") {
    return normalizeBatchActionItem(input) ?? {
      type,
      durationMs: toNumber(input.durationMs, 1000),
      reason: input.reason ? String(input.reason) : undefined,
    };
  }

  return {
    type: "wait",
    durationMs: 1000,
    reason: `unknown action type '${type}'`,
  };
}
