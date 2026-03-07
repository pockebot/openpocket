import fs from "node:fs";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";

import type { OpenPocketConfig, StoredCronJob } from "../types.js";
import { ensureDir, nowIso } from "../utils/paths.js";
import { CronRegistry } from "./cron-registry.js";

type IntervalLike = ReturnType<typeof setInterval>;

type CronJobState = {
  lastAttemptAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "fail" | "skipped";
  lastMessage?: string;
  nextRunAtMs?: number;
};

type CronStateFile = {
  updatedAt: string;
  jobs: Record<string, CronJobState>;
};

export interface CronRunResult {
  accepted: boolean;
  ok: boolean;
  message: string;
}

export type CronServiceDeps = {
  nowMs?: () => number;
  setIntervalFn?: (handler: () => void, ms: number) => IntervalLike;
  clearIntervalFn?: (timer: IntervalLike) => void;
  runTask: (job: StoredCronJob) => Promise<CronRunResult>;
  log?: (line: string) => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class CronService {
  private readonly config: OpenPocketConfig;
  private readonly deps: Required<Omit<CronServiceDeps, "runTask">> & Pick<CronServiceDeps, "runTask">;
  private readonly statePath: string;
  private readonly registry: CronRegistry;
  private timer: IntervalLike | null = null;
  private startedAtMs = 0;
  private inFlightJobs = new Set<string>();

  constructor(config: OpenPocketConfig, deps: CronServiceDeps) {
    this.config = config;
    this.deps = {
      nowMs: deps.nowMs ?? (() => Date.now()),
      setIntervalFn: deps.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms)),
      clearIntervalFn: deps.clearIntervalFn ?? ((timer) => clearInterval(timer)),
      runTask: deps.runTask,
      log: deps.log ?? ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      }),
    };
    this.statePath = path.join(this.config.stateDir, "cron-state.json");
    this.registry = new CronRegistry(config);
  }

  start(): void {
    if (!this.config.cron.enabled || this.timer) {
      return;
    }
    this.startedAtMs = this.deps.nowMs();
    this.tick();
    this.timer = this.deps.setIntervalFn(() => {
      this.tick();
    }, this.config.cron.tickSec * 1000);
    this.deps.log(
      `[OpenPocket][cron][info] ${new Date().toISOString()} started tickSec=${this.config.cron.tickSec} jobsFile=${this.config.cron.jobsFile}`,
    );
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    this.deps.clearIntervalFn(this.timer);
    this.timer = null;
    this.deps.log(`[OpenPocket][cron][info] ${new Date().toISOString()} stopped`);
  }

  runNow(jobId: string): Promise<boolean> {
    const job = this.loadJobs().find((item) => item.id === jobId);
    if (!job) {
      return Promise.resolve(false);
    }
    void this.executeJob(job);
    return Promise.resolve(true);
  }

  private tick(): void {
    if (!this.config.cron.enabled) {
      return;
    }
    const jobs = this.loadJobs();
    const state = this.loadState();
    const nowMs = this.deps.nowMs();

    for (const job of jobs) {
      if (!job.enabled || this.inFlightJobs.has(job.id)) {
        continue;
      }
      const jobState = state.jobs[job.id] ?? {};
      const firstRun = !jobState.lastAttemptAtMs && !jobState.lastRunAtMs;
      const dueByStartup = firstRun && job.runOnStartup && nowMs - this.startedAtMs < 30_000;
      const nextRunAtMs = this.computeNextRunAtMs(job, jobState, nowMs);
      jobState.nextRunAtMs = nextRunAtMs ?? undefined;
      state.jobs[job.id] = jobState;
      const dueBySchedule = nextRunAtMs !== null && nowMs >= nextRunAtMs;

      if (dueByStartup || dueBySchedule) {
        void this.executeJob(job);
      }
    }
    this.saveState(state);
  }

  private async executeJob(job: StoredCronJob): Promise<void> {
    if (this.inFlightJobs.has(job.id)) {
      return;
    }
    this.inFlightJobs.add(job.id);
    const nowMs = this.deps.nowMs();
    const state = this.loadState();
    const jobState = state.jobs[job.id] ?? {};
    jobState.lastAttemptAtMs = nowMs;
    jobState.lastStatus = "skipped";
    jobState.lastMessage = "scheduled";
    jobState.nextRunAtMs = undefined;
    state.jobs[job.id] = jobState;
    this.saveState(state);

    const taskPart = this.config.gatewayLogging.includePayloads
      ? ` task=${JSON.stringify(this.previewPayload(job.payload.task, 120))}`
      : "";
    this.deps.log(
      `[OpenPocket][cron][debug] ${new Date().toISOString()} run job=${job.id} schedule=${job.schedule.kind}${taskPart}`,
    );

    try {
      const result = await this.deps.runTask(job);
      const nextState = this.loadState();
      const updated = nextState.jobs[job.id] ?? {};
      updated.lastAttemptAtMs = nowMs;
      if (result.accepted) {
        updated.lastRunAtMs = this.deps.nowMs();
        updated.lastStatus = result.ok ? "ok" : "fail";
      } else {
        updated.lastStatus = "skipped";
      }
      updated.lastMessage = result.message.slice(0, 500);
      updated.nextRunAtMs = this.computeNextRunAtMs(job, updated, this.deps.nowMs()) ?? undefined;
      nextState.jobs[job.id] = updated;
      this.saveState(nextState);
      const messagePart = this.config.gatewayLogging.includePayloads
        ? ` message=${JSON.stringify(this.previewPayload(result.message, 120))}`
        : "";
      const level = result.accepted && result.ok ? "debug" : "warn";
      this.deps.log(
        `[OpenPocket][cron][${level}] ${new Date().toISOString()} result job=${job.id} accepted=${result.accepted} ok=${result.ok}${messagePart}`,
      );
    } catch (error) {
      const nextState = this.loadState();
      const updated = nextState.jobs[job.id] ?? {};
      updated.lastAttemptAtMs = nowMs;
      updated.lastStatus = "fail";
      updated.lastMessage = `error: ${(error as Error).message}`.slice(0, 500);
      updated.nextRunAtMs = this.computeNextRunAtMs(job, updated, this.deps.nowMs()) ?? undefined;
      nextState.jobs[job.id] = updated;
      this.saveState(nextState);
      this.deps.log(
        `[OpenPocket][cron][error] ${new Date().toISOString()} failed job=${job.id} error=${(error as Error).message}`,
      );
    } finally {
      this.inFlightJobs.delete(job.id);
    }
  }

  private loadJobs(): StoredCronJob[] {
    try {
      return this.registry.list();
    } catch (error) {
      this.deps.log(
        `[OpenPocket][cron][error] ${new Date().toISOString()} invalid jobs file error=${(error as Error).message}`,
      );
      return [];
    }
  }

  private computeNextRunAtMs(job: StoredCronJob, state: CronJobState, nowMs: number): number | null {
    if (!job.enabled) {
      return null;
    }
    if (job.schedule.kind === "every") {
      const everyMs = toFiniteNumber(job.schedule.everyMs);
      if (everyMs === null || everyMs <= 0) {
        return null;
      }
      const lastRef = state.lastAttemptAtMs ?? state.lastRunAtMs ?? this.startedAtMs;
      return lastRef + everyMs;
    }
    if (job.schedule.kind === "at") {
      const atMs = Date.parse(job.schedule.at ?? "");
      if (!Number.isFinite(atMs)) {
        return null;
      }
      if (state.lastAttemptAtMs || state.lastRunAtMs) {
        return null;
      }
      return atMs;
    }
    const expr = String(job.schedule.expr ?? "").trim();
    if (!expr) {
      return null;
    }
    try {
      const baseMs = state.lastAttemptAtMs ?? state.lastRunAtMs ?? Math.max(0, nowMs - 1000);
      const parsed = CronExpressionParser.parse(expr, {
        currentDate: new Date(baseMs),
        tz: job.schedule.tz || "UTC",
      });
      return parsed.next().getTime();
    } catch {
      return null;
    }
  }

  private previewPayload(value: string, maxChars: number): string {
    const compact = String(value || "").replace(/\s+/g, " ").trim();
    if (compact.length <= maxChars) {
      return compact;
    }
    return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private loadState(): CronStateFile {
    ensureDir(path.dirname(this.statePath));
    if (!fs.existsSync(this.statePath)) {
      return {
        updatedAt: nowIso(),
        jobs: {},
      };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf-8")) as Partial<CronStateFile>;
      if (!parsed || typeof parsed !== "object" || !isObject(parsed.jobs)) {
        return {
          updatedAt: nowIso(),
          jobs: {},
        };
      }
      return {
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
        jobs: parsed.jobs as Record<string, CronJobState>,
      };
    } catch {
      return {
        updatedAt: nowIso(),
        jobs: {},
      };
    }
  }

  private saveState(state: CronStateFile): void {
    state.updatedAt = nowIso();
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  }
}
