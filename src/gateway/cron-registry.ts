import fs from "node:fs";
import path from "node:path";

import type {
  CronJob,
  CronJobPayload,
  CronScheduleSpec,
  OpenPocketConfig,
  StoredCronJob,
  StoredCronJobsFile,
} from "../types.js";
import { ensureDir, nowIso } from "../utils/paths.js";

type CreateStoredCronJobInput = Omit<StoredCronJob, "createdAt" | "updatedAt"> & {
  createdAt?: string;
  updatedAt?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cloneJob<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSchedule(value: unknown): CronScheduleSpec | null {
  if (!isObject(value)) {
    return null;
  }
  const kind = value.kind;
  if (kind !== "cron" && kind !== "at" && kind !== "every") {
    return null;
  }
  const everyMs = value.everyMs == null ? null : toFiniteNumber(value.everyMs);
  if (value.everyMs != null && everyMs === null) {
    return null;
  }
  return {
    kind,
    expr: value.expr == null ? null : String(value.expr),
    at: value.at == null ? null : String(value.at),
    everyMs: everyMs == null ? null : Math.max(1, everyMs),
    tz: String(value.tz ?? defaultTimezone()) || defaultTimezone(),
    summaryText: String(value.summaryText ?? "").trim(),
  };
}

function normalizePayload(value: unknown): CronJobPayload | null {
  if (!isObject(value)) {
    return null;
  }
  if (value.kind !== "agent_turn") {
    return null;
  }
  const task = String(value.task ?? "").trim();
  if (!task) {
    return null;
  }
  return {
    kind: "agent_turn",
    task,
  };
}

function normalizeStoredCronJob(value: unknown): StoredCronJob | null {
  if (!isObject(value)) {
    return null;
  }
  const id = String(value.id ?? "").trim();
  if (!id) {
    return null;
  }
  const payload = normalizePayload(value.payload);
  const schedule = normalizeSchedule(value.schedule);
  if (!payload || !schedule) {
    return null;
  }
  const delivery = isObject(value.delivery)
    ? {
      mode: "announce" as const,
      channel: String(value.delivery.channel ?? "").trim(),
      to: String(value.delivery.to ?? "").trim(),
    }
    : null;
  return {
    id,
    name: String(value.name ?? id).trim() || id,
    enabled: value.enabled !== false,
    schedule,
    payload,
    delivery: delivery && delivery.channel && delivery.to ? delivery : null,
    model: value.model == null ? null : String(value.model),
    promptMode:
      value.promptMode === "full" || value.promptMode === "minimal" || value.promptMode === "none"
        ? value.promptMode
        : null,
    createdAt: String(value.createdAt ?? nowIso()),
    updatedAt: String(value.updatedAt ?? nowIso()),
    createdBy: value.createdBy == null ? null : String(value.createdBy),
    sourceChannel: value.sourceChannel == null ? null : String(value.sourceChannel),
    sourcePeerId: value.sourcePeerId == null ? null : String(value.sourcePeerId),
    runOnStartup: Boolean(value.runOnStartup ?? false),
  };
}

function legacyToStoredCronJob(value: unknown): StoredCronJob | null {
  if (!isObject(value)) {
    return null;
  }
  const id = String(value.id ?? "").trim();
  const task = String(value.task ?? "").trim();
  if (!id || !task) {
    return null;
  }
  const everySecRaw = toFiniteNumber(value.everySec ?? 60);
  const everySec = everySecRaw == null ? 60 : Math.max(5, everySecRaw);
  const chatIdRaw = value.chatId;
  const chatId =
    chatIdRaw === null || chatIdRaw === undefined || chatIdRaw === ""
      ? null
      : Number.isFinite(Number(chatIdRaw))
        ? String(chatIdRaw)
        : null;
  return {
    id,
    name: String(value.name ?? id).trim() || id,
    enabled: value.enabled !== false,
    schedule: {
      kind: "every",
      expr: null,
      at: null,
      everyMs: everySec * 1000,
      tz: defaultTimezone(),
      summaryText: `Every ${everySec} seconds`,
    },
    payload: {
      kind: "agent_turn",
      task,
    },
    delivery: chatId
      ? {
        mode: "announce",
        channel: "telegram",
        to: chatId,
      }
      : null,
    model: value.model == null ? null : String(value.model),
    promptMode: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdBy: "legacy_migration",
    sourceChannel: chatId ? "telegram" : null,
    sourcePeerId: chatId,
    runOnStartup: Boolean(value.runOnStartup ?? false),
  };
}

export class CronRegistry {
  private readonly jobsFile: string;

  constructor(config: Pick<OpenPocketConfig, "cron">) {
    this.jobsFile = config.cron.jobsFile;
  }

  list(): StoredCronJob[] {
    return this.read().jobs.map((job) => cloneJob(job));
  }

  get(jobId: string): StoredCronJob | null {
    const found = this.read().jobs.find((job) => job.id === jobId);
    return found ? cloneJob(found) : null;
  }

  add(input: CreateStoredCronJobInput): StoredCronJob {
    const current = this.read();
    const id = String(input.id ?? "").trim();
    if (!id) {
      throw new Error("Cron job id is required.");
    }
    if (current.jobs.some((job) => job.id === id)) {
      throw new Error(`Cron job already exists: ${id}`);
    }
    const now = nowIso();
    const created = normalizeStoredCronJob({
      ...input,
      id,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    });
    if (!created) {
      throw new Error(`Invalid cron job payload for id: ${id}`);
    }
    current.jobs.push(created);
    this.write(current);
    return cloneJob(created);
  }

  update(jobId: string, patch: Partial<CreateStoredCronJobInput>): StoredCronJob | null {
    const current = this.read();
    const index = current.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) {
      return null;
    }
    const next = normalizeStoredCronJob({
      ...current.jobs[index],
      ...patch,
      id: current.jobs[index].id,
      updatedAt: patch.updatedAt ?? nowIso(),
    });
    if (!next) {
      throw new Error(`Invalid cron job update for id: ${jobId}`);
    }
    current.jobs[index] = next;
    this.write(current);
    return cloneJob(next);
  }

  remove(jobId: string): boolean {
    const current = this.read();
    const nextJobs = current.jobs.filter((job) => job.id !== jobId);
    if (nextJobs.length === current.jobs.length) {
      return false;
    }
    this.write({
      version: 2,
      jobs: nextJobs,
    });
    return true;
  }

  private ensureFile(): void {
    ensureDir(path.dirname(this.jobsFile));
    if (!fs.existsSync(this.jobsFile)) {
      fs.writeFileSync(this.jobsFile, `${JSON.stringify({ version: 2, jobs: [] }, null, 2)}\n`, "utf-8");
    }
  }

  private read(): StoredCronJobsFile {
    this.ensureFile();
    let parsed: { version?: unknown; jobs?: unknown };
    try {
      parsed = JSON.parse(fs.readFileSync(this.jobsFile, "utf-8")) as {
        version?: unknown;
        jobs?: unknown;
      };
    } catch (error) {
      throw new Error(`Invalid cron jobs file: ${(error as Error).message}`);
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
      throw new Error("Invalid cron jobs file: expected top-level jobs array.");
    }

    const jobs = (() => {
      if (parsed.version === 2) {
        return parsed.jobs
          .map((job) => normalizeStoredCronJob(job))
          .filter((job): job is StoredCronJob => Boolean(job));
      }
      return parsed.jobs
        .map((job) => legacyToStoredCronJob(job))
        .filter((job): job is StoredCronJob => Boolean(job));
    })();
    return {
      version: 2,
      jobs,
    };
  }

  private write(data: StoredCronJobsFile): void {
    this.ensureFile();
    fs.writeFileSync(this.jobsFile, `${JSON.stringify({ version: 2, jobs: data.jobs }, null, 2)}\n`, "utf-8");
  }
}

export function legacyCronJobToStoredCronJob(job: CronJob): StoredCronJob {
  const migrated = legacyToStoredCronJob(job);
  if (!migrated) {
    throw new Error(`Unable to migrate legacy cron job: ${job.id}`);
  }
  return migrated;
}
