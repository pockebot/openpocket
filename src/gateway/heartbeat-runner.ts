import fs from "node:fs";
import path from "node:path";

import type { OpenPocketConfig } from "../types.js";
import { ensureDir, nowIso } from "../utils/paths.js";

export interface HeartbeatSnapshot {
  busy: boolean;
  currentTask: string | null;
  taskRuntimeMs: number | null;
  devices: number;
  bootedDevices: number;
}

type IntervalLike = ReturnType<typeof setInterval>;

export type HeartbeatDeps = {
  nowMs?: () => number;
  setIntervalFn?: (handler: () => void, ms: number) => IntervalLike;
  clearIntervalFn?: (timer: IntervalLike) => void;
  log?: (line: string) => void;
  readSnapshot: () => HeartbeatSnapshot;
};

export class HeartbeatRunner {
  private readonly config: OpenPocketConfig;
  private readonly deps: Required<Omit<HeartbeatDeps, "readSnapshot">> & Pick<HeartbeatDeps, "readSnapshot">;
  private timer: IntervalLike | null = null;
  private readonly logFilePath: string;

  constructor(config: OpenPocketConfig, deps: HeartbeatDeps) {
    this.config = config;
    this.deps = {
      nowMs: deps.nowMs ?? (() => Date.now()),
      setIntervalFn: deps.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms)),
      clearIntervalFn: deps.clearIntervalFn ?? ((timer) => clearInterval(timer)),
      log: deps.log ?? ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      }),
      readSnapshot: deps.readSnapshot,
    };
    this.logFilePath = path.join(this.config.stateDir, "heartbeat.log");
  }

  start(): void {
    if (!this.config.heartbeat.enabled || this.timer) {
      return;
    }
    const intervalMs = this.config.heartbeat.everySec * 1000;
    this.timer = this.deps.setIntervalFn(() => {
      this.runOnce();
    }, intervalMs);
    this.runOnce();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    this.deps.clearIntervalFn(this.timer);
    this.timer = null;
  }

  runOnce(): void {
    if (!this.config.heartbeat.enabled) {
      return;
    }

    const snapshot = this.deps.readSnapshot();
    const runtimeSec =
      snapshot.taskRuntimeMs !== null && Number.isFinite(snapshot.taskRuntimeMs)
        ? Math.max(0, Math.floor(snapshot.taskRuntimeMs / 1000))
        : null;

    const taskPart = this.config.gatewayLogging.includePayloads
      ? ` task=${snapshot.currentTask ? JSON.stringify(this.previewPayload(snapshot.currentTask, 120)) : "(none)"}`
      : "";
    const baseLine = [
      `[OpenPocket][heartbeat][debug] ${nowIso()}`,
      `busy=${snapshot.busy}`,
      `runtimeSec=${runtimeSec ?? 0}`,
      `devices=${snapshot.devices}`,
      `booted=${snapshot.bootedDevices}${taskPart}`,
    ].join(" ");

    this.deps.log(baseLine);

    if (
      snapshot.busy &&
      runtimeSec !== null &&
      runtimeSec >= this.config.heartbeat.stuckTaskWarnSec
    ) {
      this.deps.log(
        `[OpenPocket][heartbeat][warn] task runtime ${runtimeSec}s exceeded threshold ${this.config.heartbeat.stuckTaskWarnSec}s`,
      );
    }

    if (this.config.heartbeat.writeLogFile) {
      ensureDir(this.config.stateDir);
      const payload = {
        ts: this.deps.nowMs(),
        busy: snapshot.busy,
        task: snapshot.currentTask,
        runtimeSec,
        devices: snapshot.devices,
        bootedDevices: snapshot.bootedDevices,
      };
      fs.appendFileSync(this.logFilePath, `${JSON.stringify(payload)}\n`, "utf-8");
    }
  }

  private previewPayload(value: string, maxChars: number): string {
    const compact = String(value || "").replace(/\s+/g, " ").trim();
    if (compact.length <= maxChars) {
      return compact;
    }
    return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
  }
}
