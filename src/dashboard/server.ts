import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

import { loadConfig, saveConfig } from "../config";
import { AdbRuntime } from "../device/adb-runtime";
import { EmulatorManager } from "../device/emulator-manager";
import type { OpenPocketConfig } from "../types";
import { nowIso, resolvePath } from "../utils/paths";
import {
  defaultControlSettings,
  loadControlSettings,
  loadOnboardingState,
  providerLabel,
  saveControlSettings,
  saveOnboardingState,
  type MenuBarControlSettings,
  type OnboardingStateFile,
} from "./control-store";

export interface DashboardGatewayStatus {
  running: boolean;
  managed: boolean;
  note: string;
}

export interface DashboardServerOptions {
  config: OpenPocketConfig;
  mode: "standalone" | "integrated";
  host?: string;
  port?: number;
  getGatewayStatus?: () => DashboardGatewayStatus;
  onLogLine?: (line: string) => void;
}

interface PreviewSnapshot {
  deviceId: string;
  currentApp: string;
  width: number;
  height: number;
  screenshotBase64: string;
  capturedAt: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("Payload too large.");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}

function safeBoolean(value: unknown, fallback = false): boolean {
  if (value === true || value === false) {
    return value;
  }
  return fallback;
}

function sanitizeLogLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function nowHmss(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pathWithin(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  if (!relative) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class DashboardServer {
  private config: OpenPocketConfig;
  private readonly mode: "standalone" | "integrated";
  private readonly host: string;
  private readonly port: number;
  private readonly getGatewayStatusFn: (() => DashboardGatewayStatus) | null;
  private readonly onLogLine: ((line: string) => void) | null;

  private emulator: EmulatorManager;
  private adb: AdbRuntime;
  private server: http.Server | null = null;
  private previewCache: PreviewSnapshot | null = null;
  private readonly logs: string[] = [];
  private emulatorLifecycleQueue: Promise<void> = Promise.resolve();

  constructor(options: DashboardServerOptions) {
    this.config = options.config;
    this.mode = options.mode;
    this.host = options.host?.trim() || options.config.dashboard.host;
    this.port = options.port ?? options.config.dashboard.port;
    this.getGatewayStatusFn = options.getGatewayStatus ?? null;
    this.onLogLine = options.onLogLine ?? null;

    this.emulator = new EmulatorManager(this.config);
    this.adb = new AdbRuntime(this.config, this.emulator);
  }

  get address(): string {
    if (!this.server) {
      return "";
    }
    const addr = this.server.address();
    if (!addr || typeof addr === "string") {
      return "";
    }
    const host = addr.address === "::" ? "127.0.0.1" : addr.address;
    return `http://${host}:${addr.port}`;
  }

  private log(line: string): void {
    this.ingestExternalLogLine(`[dashboard] ${nowHmss()} ${line}`);
  }

  ingestExternalLogLine(line: string): void {
    const text = sanitizeLogLine(line);
    if (!text) {
      return;
    }
    this.logs.push(text);
    if (this.logs.length > 2000) {
      this.logs.splice(0, this.logs.length - 2000);
    }
    this.onLogLine?.(text);
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => {
        this.server?.removeListener("error", reject);
        resolve();
      });
    });

    this.log(`server started mode=${this.mode} addr=${this.address}`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const current = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
    });
    this.log("server stopped");
  }

  listLogs(limit = 500): string[] {
    const n = Math.max(1, Math.min(5000, Math.round(limit)));
    if (this.logs.length <= n) {
      return [...this.logs];
    }
    return this.logs.slice(this.logs.length - n);
  }

  clearLogs(): void {
    this.logs.splice(0, this.logs.length);
  }

  private async runEmulatorLifecycleExclusive<T>(action: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.emulatorLifecycleQueue;
    let resolveQueue!: () => void;
    this.emulatorLifecycleQueue = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });

    await previous;
    this.log(`emulator action begin ${action}`);
    try {
      return await fn();
    } finally {
      this.log(`emulator action end ${action}`);
      resolveQueue();
    }
  }

  private gatewayStatus(): DashboardGatewayStatus {
    if (this.getGatewayStatusFn) {
      try {
        return this.getGatewayStatusFn();
      } catch {
        return {
          running: false,
          managed: this.mode === "integrated",
          note: "gateway status callback failed",
        };
      }
    }
    return {
      running: this.mode === "integrated",
      managed: this.mode === "integrated",
      note:
        this.mode === "integrated"
          ? "managed by current gateway process"
          : "status unavailable in standalone mode",
    };
  }

  private runtimePayload(): Record<string, unknown> {
    const emulator = (() => {
      try {
        return this.emulator.status();
      } catch (error) {
        return {
          avdName: this.config.emulator.avdName,
          devices: [],
          bootedDevices: [],
          error: (error as Error).message,
        };
      }
    })();
    const emulatorError = "error" in emulator ? String(emulator.error ?? "") : "";
    return {
      mode: this.mode,
      gateway: this.gatewayStatus(),
      emulator: {
        avdName: emulator.avdName,
        devices: emulator.devices,
        bootedDevices: emulator.bootedDevices,
        statusText:
          emulatorError
            ? `Unavailable (${emulatorError})`
            : emulator.bootedDevices.length > 0
            ? `Running (${emulator.bootedDevices.join(", ")})`
            : emulator.devices.length > 0
              ? `Starting (${emulator.devices.join(", ")})`
              : "Stopped",
        error: emulatorError || null,
      },
      dashboard: {
        address: this.address,
      },
      config: {
        configPath: this.config.configPath,
        stateDir: this.config.stateDir,
        workspaceDir: this.config.workspaceDir,
        defaultModel: this.config.defaultModel,
        projectName: this.config.projectName,
      },
      preview: this.previewCache,
      now: nowIso(),
    };
  }

  private applyConfigPatch(input: unknown): OpenPocketConfig {
    if (!isObject(input)) {
      throw new Error("Invalid config patch payload.");
    }

    const next: OpenPocketConfig = {
      ...this.config,
      emulator: { ...this.config.emulator },
      agent: { ...this.config.agent },
      dashboard: { ...this.config.dashboard },
    };

    if (typeof input.projectName === "string" && input.projectName.trim()) {
      next.projectName = input.projectName.trim();
    }
    if (typeof input.workspaceDir === "string" && input.workspaceDir.trim()) {
      next.workspaceDir = resolvePath(input.workspaceDir.trim());
    }
    if (typeof input.stateDir === "string" && input.stateDir.trim()) {
      next.stateDir = resolvePath(input.stateDir.trim());
    }
    if (typeof input.defaultModel === "string" && input.defaultModel.trim()) {
      const candidate = input.defaultModel.trim();
      if (!next.models[candidate]) {
        throw new Error(`Unknown default model: ${candidate}`);
      }
      next.defaultModel = candidate;
    }

    if (isObject(input.emulator)) {
      if (typeof input.emulator.avdName === "string" && input.emulator.avdName.trim()) {
        next.emulator.avdName = input.emulator.avdName.trim();
      }
      if (
        typeof input.emulator.androidSdkRoot === "string" &&
        input.emulator.androidSdkRoot.trim()
      ) {
        next.emulator.androidSdkRoot = resolvePath(input.emulator.androidSdkRoot.trim());
      }
      if (typeof input.emulator.bootTimeoutSec === "number" && Number.isFinite(input.emulator.bootTimeoutSec)) {
        next.emulator.bootTimeoutSec = Math.max(20, Math.round(input.emulator.bootTimeoutSec));
      }
      if (typeof input.emulator.headless === "boolean") {
        next.emulator.headless = input.emulator.headless;
      }
    }

    if (isObject(input.agent)) {
      if (typeof input.agent.deviceId === "string" && input.agent.deviceId.trim()) {
        next.agent.deviceId = input.agent.deviceId.trim();
      } else if (input.agent.deviceId === null || input.agent.deviceId === "") {
        next.agent.deviceId = null;
      }
    }

    if (isObject(input.dashboard)) {
      if (typeof input.dashboard.host === "string" && input.dashboard.host.trim()) {
        next.dashboard.host = input.dashboard.host.trim();
      }
      if (typeof input.dashboard.port === "number" && Number.isFinite(input.dashboard.port)) {
        next.dashboard.port = Math.max(1, Math.min(65535, Math.round(input.dashboard.port)));
      }
      if (typeof input.dashboard.enabled === "boolean") {
        next.dashboard.enabled = input.dashboard.enabled;
      }
      if (typeof input.dashboard.autoOpenBrowser === "boolean") {
        next.dashboard.autoOpenBrowser = input.dashboard.autoOpenBrowser;
      }
    }

    saveConfig(next);
    this.config = loadConfig(this.config.configPath);
    this.emulator = new EmulatorManager(this.config);
    this.adb = new AdbRuntime(this.config, this.emulator);
    this.log("config patched and reloaded");
    return this.config;
  }

  private readScopedFiles(control: MenuBarControlSettings): string[] {
    const permission = control.permission;
    if (!permission.allowLocalStorageView) {
      return [];
    }

    const root = resolvePath(permission.storageDirectoryPath || this.config.workspaceDir);
    if (!fs.existsSync(root)) {
      return [];
    }

    const allowedSubpaths = permission.allowedSubpaths.length > 0 ? permission.allowedSubpaths : [""];
    const allowedPrefixes = allowedSubpaths
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => path.resolve(root, segment));
    if (allowedPrefixes.length === 0) {
      allowedPrefixes.push(root);
    }

    const allowedExt = new Set(permission.allowedExtensions.map((ext) => ext.toLowerCase()));
    const output: string[] = [];

    const stack = [root];
    while (stack.length > 0 && output.length < 2000) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.isSymbolicLink()) {
            continue;
          }
          const shouldTraverse = allowedPrefixes.some((prefix) =>
            pathWithin(fullPath, prefix) || pathWithin(prefix, fullPath),
          );
          if (!shouldTraverse) {
            continue;
          }
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        const ext = path.extname(fullPath).replace(/^\./, "").toLowerCase();
        if (allowedExt.size > 0 && !allowedExt.has(ext)) {
          continue;
        }

        if (!allowedPrefixes.some((prefix) => pathWithin(prefix, fullPath))) {
          continue;
        }

        output.push(fullPath);
        if (output.length >= 2000) {
          break;
        }
      }
    }

    output.sort((a, b) => a.localeCompare(b));
    return output;
  }

  private readScopedFile(control: MenuBarControlSettings, filePath: string): string {
    const permission = control.permission;
    if (!permission.allowLocalStorageView) {
      throw new Error("Local storage file view permission is disabled.");
    }
    const resolved = resolvePath(filePath);
    const root = resolvePath(permission.storageDirectoryPath || this.config.workspaceDir);
    if (!pathWithin(root, resolved)) {
      throw new Error("Selected file is outside storage root.");
    }

    const allowedSubpaths = permission.allowedSubpaths.length > 0 ? permission.allowedSubpaths : [""];
    const allowedPrefixes = allowedSubpaths
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => path.resolve(root, segment));
    if (allowedPrefixes.length === 0) {
      allowedPrefixes.push(root);
    }

    if (!allowedPrefixes.some((prefix) => pathWithin(prefix, resolved))) {
      throw new Error("Selected file is outside allowed scope.");
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 2_000_000) {
      throw new Error(`File too large (${stat.size} bytes).`);
    }

    const content = fs.readFileSync(resolved);
    return content.toString("utf-8");
  }

  private readPromptFile(promptPath: string): string {
    const resolved = resolvePath(promptPath);
    if (!fs.existsSync(resolved)) {
      return "";
    }
    const stat = fs.statSync(resolved);
    if (stat.size > 2_000_000) {
      throw new Error(`Prompt file too large (${stat.size} bytes).`);
    }
    const content = fs.readFileSync(resolved);
    return content.toString("utf-8");
  }

  private savePromptFile(promptPath: string, content: string): void {
    const resolved = resolvePath(promptPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
  }

  private applyOnboarding(input: unknown): { onboarding: OnboardingStateFile; config: OpenPocketConfig } {
    if (!isObject(input)) {
      throw new Error("Invalid onboarding payload.");
    }

    const consentAccepted = safeBoolean(input.consentAccepted, false);
    const selectedModelProfile = String(input.selectedModelProfile ?? "").trim();
    const useEnvKey = safeBoolean(input.useEnvKey, true);
    const rawApiKey = String(input.apiKey ?? "").trim();
    const gmailLoginDone = safeBoolean(input.gmailLoginDone, false);

    if (!consentAccepted) {
      throw new Error("Consent is required before onboarding can be saved.");
    }
    if (!selectedModelProfile || !this.config.models[selectedModelProfile]) {
      throw new Error("Selected model profile is invalid.");
    }

    const nextConfig: OpenPocketConfig = {
      ...this.config,
      models: { ...this.config.models },
      defaultModel: selectedModelProfile,
    };

    if (!useEnvKey && rawApiKey) {
      const selected = nextConfig.models[selectedModelProfile];
      const providerHost = (() => {
        try {
          return new URL(selected.baseUrl).host.toLowerCase();
        } catch {
          return selected.baseUrl.toLowerCase();
        }
      })();

      for (const [modelName, profile] of Object.entries(nextConfig.models)) {
        const currentHost = (() => {
          try {
            return new URL(profile.baseUrl).host.toLowerCase();
          } catch {
            return profile.baseUrl.toLowerCase();
          }
        })();
        if (currentHost === providerHost || profile.apiKeyEnv === selected.apiKeyEnv) {
          nextConfig.models[modelName] = {
            ...profile,
            apiKey: rawApiKey,
            apiKeyEnv: selected.apiKeyEnv,
          };
        }
      }
    }

    saveConfig(nextConfig);
    this.config = loadConfig(this.config.configPath);
    this.emulator = new EmulatorManager(this.config);
    this.adb = new AdbRuntime(this.config, this.emulator);

    const now = nowIso();
    const onboarding: OnboardingStateFile = {
      ...loadOnboardingState(this.config),
      updatedAt: now,
      consentAcceptedAt: loadOnboardingState(this.config).consentAcceptedAt ?? now,
      modelProfile: selectedModelProfile,
      modelProvider: providerLabel(this.config.models[selectedModelProfile].baseUrl),
      modelConfiguredAt: now,
      apiKeyEnv: this.config.models[selectedModelProfile].apiKeyEnv,
      apiKeySource: useEnvKey ? "env" : "config",
      apiKeyConfiguredAt: now,
      gmailLoginConfirmedAt: gmailLoginDone ? now : null,
    };
    saveOnboardingState(this.config, onboarding);

    this.log(`onboarding applied model=${selectedModelProfile} source=${onboarding.apiKeySource}`);

    return {
      onboarding,
      config: this.config,
    };
  }

  private credentialStatusMap(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [profileName, profile] of Object.entries(this.config.models)) {
      const configKey = profile.apiKey.trim();
      const envName = profile.apiKeyEnv;
      const envValue = (process.env[envName] ?? "").trim();

      if (configKey) {
        if (!envValue) {
          result[profileName] = `Credential source: config.json (detected, length ${configKey.length}). ${envName} is optional.`;
        } else {
          result[profileName] = `Credential source: config.json (detected, length ${configKey.length}). ${envName} also detected (length ${envValue.length}).`;
        }
        continue;
      }

      if (envValue) {
        result[profileName] = `Credential source: ${envName} env var (detected, length ${envValue.length}).`;
      } else {
        result[profileName] = `No API key found in config.json or ${envName}.`;
      }
    }
    return result;
  }

  private htmlShell(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenPocket Dashboard</title>
  <style>
    :root {
      --bg-0: #f6f2eb;
      --bg-1: #eef6ff;
      --ink-0: #111827;
      --ink-1: #3a4352;
      --brand: #0b8f6a;
      --brand-soft: #d7f5ea;
      --danger: #a92929;
      --card: rgba(255, 255, 255, 0.92);
      --line: #d7dee8;
      --shadow: 0 14px 40px rgba(15, 35, 60, 0.12);
      --mono: "SF Mono", "Menlo", "Consolas", monospace;
      --sans: "Avenir Next", "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--sans);
      color: var(--ink-0);
      background:
        radial-gradient(1200px 400px at 15% -5%, #f9e1c8 0%, transparent 55%),
        radial-gradient(900px 420px at 100% -10%, #cae8ff 0%, transparent 60%),
        linear-gradient(160deg, var(--bg-0), var(--bg-1));
    }
    .layout {
      max-width: 1280px;
      margin: 0 auto;
      padding: 20px 22px 30px;
      display: grid;
      gap: 14px;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: space-between;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
      padding: 14px 16px;
    }
    .title {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .title h1 {
      margin: 0;
      font-size: 29px;
      letter-spacing: 0.2px;
    }
    .subtitle {
      margin: 0;
      color: var(--ink-1);
      font-size: 13px;
    }
    .badge-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .badge {
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--line);
      background: #fff;
      color: #2b3340;
    }
    .badge.ok {
      background: var(--brand-soft);
      color: #0f6f52;
      border-color: #bde7d7;
    }
    .tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tab-btn {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      color: #1f2b3d;
      padding: 9px 14px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 120ms ease, background 120ms ease;
    }
    .tab-btn:hover {
      transform: translateY(-1px);
      background: #f4f8fc;
    }
    .tab-btn.active {
      background: #e7f6ef;
      border-color: #b9e9d6;
      color: #0e6f51;
    }
    .status-line {
      font-size: 13px;
      color: var(--ink-1);
      padding: 0 3px;
      min-height: 20px;
    }
    .tab-panel {
      display: none;
      animation: rise 180ms ease-out;
    }
    .tab-panel.active {
      display: block;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .grid {
      display: grid;
      gap: 12px;
    }
    .grid.cols-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .core-paths-grid {
      grid-template-columns: 1fr;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 18px;
    }
    .hint {
      color: var(--ink-1);
      font-size: 13px;
      margin-top: 3px;
      margin-bottom: 10px;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .row.spread {
      justify-content: space-between;
    }
    .btn {
      border: 1px solid #bfd3e2;
      background: #fff;
      color: #172234;
      border-radius: 9px;
      cursor: pointer;
      font-weight: 700;
      padding: 8px 12px;
    }
    .btn.primary {
      border-color: #0f906a;
      background: #0f906a;
      color: #fff;
    }
    .btn.warn {
      border-color: #b73f3f;
      background: #b73f3f;
      color: #fff;
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    input[type="text"], input[type="password"], select, textarea {
      width: 100%;
      border: 1px solid #c7d4e2;
      border-radius: 9px;
      background: #fff;
      padding: 8px 10px;
      color: #122133;
      font-size: 14px;
      font-family: inherit;
    }
    textarea {
      min-height: 96px;
      resize: vertical;
    }
    .kv {
      font-size: 13px;
      color: var(--ink-1);
      margin-top: 8px;
      line-height: 1.5;
    }
    .kv code {
      font-family: var(--mono);
      font-size: 12px;
      color: #14365a;
      background: #edf4fb;
      border-radius: 6px;
      padding: 2px 5px;
    }
    .preview-wrap {
      position: relative;
      background: #0b1118;
      border-radius: 12px;
      min-height: 270px;
      overflow: hidden;
      border: 1px solid #0d1723;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #preview-image {
      max-width: 100%;
      max-height: 420px;
      display: none;
      cursor: crosshair;
      image-rendering: auto;
    }
    .preview-empty {
      color: #dbe7f4;
      font-size: 13px;
      text-align: center;
      padding: 14px;
    }
    .mono {
      font-family: var(--mono);
      font-size: 12px;
    }
    .placeholder {
      color: var(--ink-1);
      font-size: 14px;
      line-height: 1.7;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(260px, 34%) 1fr;
      gap: 10px;
    }
    .runtime-layout {
      display: grid;
      grid-template-columns: minmax(340px, 32%) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .runtime-left {
      display: grid;
      gap: 12px;
    }
    .runtime-right {
      min-width: 0;
    }
    .runtime-preview-card {
      min-height: 78vh;
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      gap: 10px;
    }
    .runtime-preview-wrap {
      min-height: 58vh;
      max-height: none;
      height: 100%;
    }
    .runtime-preview-wrap #preview-image {
      max-height: calc(78vh - 190px);
      max-width: 100%;
    }
    .list-box {
      width: 100%;
      min-height: 250px;
      border: 1px solid #c7d4e2;
      border-radius: 9px;
      padding: 6px;
      background: #fff;
      font-family: var(--mono);
      font-size: 12px;
    }
    .log-view {
      min-height: 360px;
      max-height: 56vh;
      overflow: auto;
      border: 1px solid #0f172a;
      border-radius: 10px;
      padding: 10px;
      background: #030712;
      color: #55f18e;
      font-family: var(--mono);
      font-size: 12px;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    @media (max-width: 980px) {
      .grid.cols-2 {
        grid-template-columns: 1fr;
      }
      .split {
        grid-template-columns: 1fr;
      }
      .runtime-layout {
        grid-template-columns: 1fr;
      }
      .runtime-preview-card {
        min-height: auto;
      }
      .runtime-preview-wrap {
        min-height: 340px;
      }
      .runtime-preview-wrap #preview-image {
        max-height: 60vh;
      }
      .layout {
        padding: 12px;
      }
      .title h1 {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <header class="topbar">
      <div class="title">
        <h1>OpenPocket</h1>
        <p class="subtitle">Local agent phone control dashboard</p>
      </div>
      <div class="badge-row">
        <span class="badge" id="gateway-badge">Gateway: Unknown</span>
        <span class="badge" id="emulator-badge">Emulator: Unknown</span>
      </div>
    </header>

    <div class="tabs">
      <button class="tab-btn active" data-tab="runtime">Runtime</button>
      <button class="tab-btn" data-tab="onboarding">Onboarding</button>
      <button class="tab-btn" data-tab="permissions">Permissions</button>
      <button class="tab-btn" data-tab="prompts">Agent Prompts</button>
      <button class="tab-btn" data-tab="logs">Logs</button>
    </div>

    <div class="status-line" id="status-line"></div>

    <section class="tab-panel active" data-panel="runtime">
      <div class="runtime-layout">
        <div class="runtime-left">
          <div class="card">
            <h3>Gateway</h3>
            <p class="hint">Gateway is managed by CLI in integrated mode. Runtime status refreshes automatically.</p>
            <div class="row">
              <button class="btn" id="runtime-refresh-btn">Refresh Runtime</button>
            </div>
            <div class="kv" id="gateway-kv"></div>
          </div>

          <div class="card">
            <h3>Android Emulator</h3>
            <p class="hint">Control emulator lifecycle and visibility while tasks continue in background. Show can auto-switch from headless to windowed mode.</p>
            <div class="row">
              <button class="btn primary" data-emu-action="start">Start</button>
              <button class="btn warn" data-emu-action="stop">Stop</button>
              <button class="btn" data-emu-action="show">Show / Interact</button>
              <button class="btn" data-emu-action="hide">Hide</button>
              <button class="btn" id="emu-refresh-btn">Refresh Status</button>
            </div>
            <div class="kv" id="emulator-kv"></div>
          </div>

          <div class="card">
            <h3>Core Paths</h3>
            <div class="grid core-paths-grid">
              <div>
                <label for="workspace-input">Workspace</label>
                <input type="text" id="workspace-input" />
              </div>
              <div>
                <label for="state-input">State</label>
                <input type="text" id="state-input" />
              </div>
            </div>
            <div class="row" style="margin-top:10px;">
              <button class="btn primary" id="save-core-paths-btn">Save Config</button>
            </div>
          </div>
        </div>

        <div class="runtime-right">
          <div class="card runtime-preview-card">
            <h3>Emulator Screen Preview</h3>
            <div class="row">
              <button class="btn" id="preview-refresh-btn">Refresh Preview</button>
              <label class="row">
                <input type="checkbox" id="preview-auto" />
                <span>Auto refresh (2s)</span>
              </label>
              <span class="kv" id="preview-meta"></span>
            </div>
            <div class="row">
              <input type="text" id="emulator-text-input" placeholder="Type text to active input field" />
              <button class="btn" id="emulator-text-send">Send Text</button>
            </div>
            <div class="preview-wrap runtime-preview-wrap">
              <img id="preview-image" alt="Emulator preview" />
              <div class="preview-empty" id="preview-empty">Preview unavailable. Start emulator and click Refresh Preview.</div>
            </div>
            <div class="hint">Click on preview image to send tap. Coordinates are mapped to device pixels.</div>
          </div>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="onboarding">
      <div class="grid cols-2">
        <div class="card">
          <h3>User Consent</h3>
          <p class="hint">Emulator artifacts are stored locally. Cloud model providers may receive task text/screenshots.</p>
          <label class="row">
            <input type="checkbox" id="onboard-consent" />
            <span>I accept local automation and data handling terms.</span>
          </label>
        </div>
        <div class="card">
          <h3>Play Store Login</h3>
          <p class="hint">Manually complete Gmail sign-in in emulator when needed.</p>
          <label class="row">
            <input type="checkbox" id="onboard-gmail-done" />
            <span>I finished Gmail sign-in and verified Play Store access.</span>
          </label>
          <div class="row" style="margin-top:10px;">
            <button class="btn" id="onboard-start-emu">Start Emulator</button>
            <button class="btn" id="onboard-show-emu">Show Emulator</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Model Selection</h3>
        <div class="row">
          <div style="min-width:320px;flex:1;">
            <label for="onboard-model-select">Default Model</label>
            <select id="onboard-model-select"></select>
          </div>
        </div>
        <div class="kv" id="onboard-model-meta"></div>
      </div>

      <div class="card">
        <h3>API Key Setup</h3>
        <label class="row">
          <input type="checkbox" id="onboard-use-env" checked />
          <span>Use environment variable for API key</span>
        </label>
        <div style="margin-top:10px;" id="onboard-api-key-wrap">
          <input type="password" id="onboard-api-key" placeholder="Paste API key when not using env variable" />
        </div>
      </div>

      <div class="card">
        <div class="row spread">
          <h3 style="margin:0;">Save Onboarding</h3>
          <button class="btn primary" id="onboard-save-btn">Save Onboarding to Config + State</button>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="permissions">
      <div class="grid cols-2">
        <div class="card">
          <h3>File Access Permissions</h3>
          <p class="hint">Control local file scope exposed in dashboard.</p>
          <label class="row">
            <input type="checkbox" id="perm-allow-view" />
            <span>Allow local storage file view in dashboard</span>
          </label>
          <div style="margin-top:10px;">
            <label for="perm-storage-root">Storage root</label>
            <input type="text" id="perm-storage-root" placeholder="/path/to/workspace" />
          </div>
          <div style="margin-top:10px;">
            <label for="perm-subpaths">Allowed subpaths (one per line)</label>
            <textarea id="perm-subpaths"></textarea>
          </div>
          <div style="margin-top:10px;">
            <label for="perm-exts">Allowed extensions (one per line, without dot)</label>
            <textarea id="perm-exts"></textarea>
          </div>
          <div class="row" style="margin-top:10px;">
            <button class="btn primary" id="perm-save-btn">Apply Scope</button>
            <button class="btn" id="perm-refresh-files-btn">Refresh Files</button>
          </div>
        </div>

        <div class="card">
          <h3>Scoped File Viewer</h3>
          <div class="split">
            <div>
              <div class="row spread">
                <span class="hint" id="perm-file-count">0 files</span>
              </div>
              <select id="perm-file-list" class="list-box" size="14"></select>
            </div>
            <div>
              <textarea id="perm-file-content" style="min-height:320px;" readonly placeholder="File content"></textarea>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="prompts">
      <div class="card">
        <h3>Prompt Files</h3>
        <div class="split">
          <div>
            <div style="margin-bottom:8px;">
              <label for="prompt-add-title">Title</label>
              <input type="text" id="prompt-add-title" placeholder="AGENTS" />
            </div>
            <div style="margin-bottom:8px;">
              <label for="prompt-add-path">Path</label>
              <input type="text" id="prompt-add-path" placeholder="/path/to/AGENTS.md" />
            </div>
            <div class="row" style="margin-bottom:8px;">
              <button class="btn" id="prompt-add-btn">Add Prompt File</button>
              <button class="btn warn" id="prompt-remove-btn">Remove</button>
            </div>
            <select id="prompt-list" class="list-box" size="12"></select>
          </div>
          <div>
            <div class="row spread">
              <span class="hint" id="prompt-selected-meta">No prompt selected</span>
              <div class="row">
                <button class="btn" id="prompt-reload-btn">Reload</button>
                <button class="btn primary" id="prompt-save-btn">Save</button>
              </div>
            </div>
            <textarea id="prompt-editor" style="min-height:340px;" placeholder="Prompt file content"></textarea>
          </div>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-panel="logs">
      <div class="card">
        <h3>Dashboard Logs</h3>
        <div class="row">
          <button class="btn" id="logs-refresh-btn">Refresh</button>
          <button class="btn warn" id="logs-clear-btn">Clear</button>
          <label class="row">
            <input type="checkbox" id="logs-auto" />
            <span>Auto refresh (2s)</span>
          </label>
          <span class="hint" id="logs-meta"></span>
        </div>
        <div class="log-view" id="logs-view"></div>
      </div>
    </section>
  </div>
  <script>
    const state = {
      runtime: null,
      config: null,
      onboarding: null,
      controlSettings: null,
      promptFiles: [],
      selectedPromptId: "",
      preview: null,
      previewTimer: null,
      runtimeTimer: null,
      logsTimer: null,
      emulatorActionPending: false,
      credentialStatus: {},
    };

    const $ = (selector) => document.querySelector(selector);

    function setStatus(text, tone = "normal") {
      const el = $("#status-line");
      el.textContent = text || "";
      if (tone === "error") {
        el.style.color = "#a92929";
      } else if (tone === "ok") {
        el.style.color = "#0f7c5a";
      } else {
        el.style.color = "";
      }
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || response.statusText || "Request failed");
      }
      return payload;
    }

    function activateTab(tab) {
      document.querySelectorAll(".tab-btn").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tab);
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === tab);
      });
    }

    function updateBadges(runtime) {
      const gatewayBadge = $("#gateway-badge");
      const emulatorBadge = $("#emulator-badge");
      const gatewayRunning = Boolean(runtime?.gateway?.running);
      const emulatorRunning = (runtime?.emulator?.bootedDevices || []).length > 0;

      gatewayBadge.textContent = "Gateway: " + (gatewayRunning ? "Running" : "Stopped/Unknown");
      gatewayBadge.classList.toggle("ok", gatewayRunning);

      emulatorBadge.textContent = "Emulator: " + (runtime?.emulator?.statusText || "Unknown");
      emulatorBadge.classList.toggle("ok", emulatorRunning);
    }

    function renderRuntime(runtime) {
      updateBadges(runtime);
      $("#gateway-kv").innerHTML =
        "<div>Mode: <code>" + (runtime.mode || "unknown") + "</code></div>" +
        "<div>Gateway note: " + (runtime.gateway?.note || "n/a") + "</div>" +
        "<div>Dashboard: <code>" + (runtime.dashboard?.address || location.origin) + "</code></div>";

      $("#emulator-kv").innerHTML =
        "<div>AVD: <code>" + (runtime.emulator?.avdName || "unknown") + "</code></div>" +
        "<div>Devices: " + ((runtime.emulator?.devices || []).join(", ") || "(none)") + "</div>" +
        "<div>Booted: " + ((runtime.emulator?.bootedDevices || []).join(", ") || "(none)") + "</div>";

      if (!$("#workspace-input").value) {
        $("#workspace-input").value = runtime.config?.workspaceDir || "";
      }
      if (!$("#state-input").value) {
        $("#state-input").value = runtime.config?.stateDir || "";
      }
    }

    async function loadRuntime() {
      const payload = await api("/api/runtime");
      state.runtime = payload;
      renderRuntime(payload);
      return payload;
    }

    async function loadConfigAndOnboarding() {
      const [configPayload, onboardingPayload] = await Promise.all([
        api("/api/config"),
        api("/api/onboarding"),
      ]);
      state.config = configPayload.config;
      state.credentialStatus = configPayload.credentialStatus || {};
      state.onboarding = onboardingPayload.onboarding || {};
      renderOnboarding();
    }

    function renderOnboarding() {
      const config = state.config;
      const onboarding = state.onboarding || {};
      if (!config) {
        return;
      }

      const select = $("#onboard-model-select");
      const current = onboarding.modelProfile || config.defaultModel;
      select.innerHTML = "";
      const providerLabelFromBaseUrl = (baseUrl) => {
        const text = String(baseUrl || "").toLowerCase();
        if (text.includes("api.openai.com")) {
          return "OpenAI";
        }
        if (text.includes("openrouter.ai")) {
          return "OpenRouter";
        }
        if (text.includes("api.z.ai")) {
          return "AutoGLM";
        }
        try {
          return new URL(baseUrl).host || "custom";
        } catch {
          return "custom";
        }
      };
      Object.keys(config.models || {}).sort().forEach((key) => {
        const profile = config.models[key];
        const option = document.createElement("option");
        option.value = key;
        option.textContent = key + " (" + providerLabelFromBaseUrl(profile.baseUrl) + ")";
        if (key === current) {
          option.selected = true;
        }
        select.appendChild(option);
      });

      $("#onboard-consent").checked = Boolean(onboarding.consentAcceptedAt);
      $("#onboard-gmail-done").checked = Boolean(onboarding.gmailLoginConfirmedAt);
      $("#onboard-use-env").checked = (onboarding.apiKeySource || "env") !== "config";
      $("#onboard-api-key-wrap").style.display = $("#onboard-use-env").checked ? "none" : "block";

      const selected = select.value || config.defaultModel;
      const profile = config.models[selected];
      const provider = profile?.baseUrl ? profile.baseUrl : "unknown";
      const envName = profile?.apiKeyEnv || "N/A";
      const modelId = profile?.model || "unknown";
      const status = state.credentialStatus[selected] || "";

      $("#onboard-model-meta").innerHTML =
        "<div>Model ID: <code>" + modelId + "</code></div>" +
        "<div>Provider: <code>" + provider + "</code></div>" +
        "<div>Provider API env: <code>" + envName + "</code></div>" +
        "<div>" + status + "</div>";
    }

    async function loadControlSettings() {
      const payload = await api("/api/control-settings");
      state.controlSettings = payload.controlSettings || null;
      state.promptFiles = state.controlSettings?.promptFiles || [];
      renderPermissions();
      renderPromptList();
    }

    function renderPermissions() {
      const control = state.controlSettings;
      if (!control) {
        return;
      }
      const permission = control.permission || {};
      $("#perm-allow-view").checked = Boolean(permission.allowLocalStorageView);
      $("#perm-storage-root").value = permission.storageDirectoryPath || (state.config?.workspaceDir || "");
      $("#perm-subpaths").value = (permission.allowedSubpaths || []).join("\\n");
      $("#perm-exts").value = (permission.allowedExtensions || []).join("\\n");
    }

    async function savePermissions() {
      const permission = {
        allowLocalStorageView: $("#perm-allow-view").checked,
        storageDirectoryPath: $("#perm-storage-root").value.trim(),
        allowedSubpaths: $("#perm-subpaths").value
          .split("\\n")
          .map((line) => line.trim())
          .filter(Boolean),
        allowedExtensions: $("#perm-exts").value
          .split("\\n")
          .map((line) => line.trim().toLowerCase())
          .filter(Boolean),
      };
      await api("/api/control-settings", {
        method: "POST",
        body: JSON.stringify({ permission }),
      });
      await loadControlSettings();
      setStatus("Permission scope saved.", "ok");
    }

    async function loadScopedFiles() {
      const payload = await api("/api/permissions/files");
      const files = payload.files || [];
      const list = $("#perm-file-list");
      list.innerHTML = "";
      files.forEach((item) => {
        const option = document.createElement("option");
        option.value = item;
        option.textContent = item;
        list.appendChild(option);
      });
      $("#perm-file-count").textContent = files.length + " files";
      if (files.length === 0) {
        $("#perm-file-content").value = "";
      }
    }

    async function readScopedFile() {
      const selected = $("#perm-file-list").value;
      if (!selected) {
        $("#perm-file-content").value = "";
        return;
      }
      const payload = await api("/api/permissions/read-file", {
        method: "POST",
        body: JSON.stringify({ path: selected }),
      });
      $("#perm-file-content").value = payload.content || "";
    }

    function renderPromptList() {
      const list = $("#prompt-list");
      list.innerHTML = "";
      if (!(state.promptFiles || []).some((item) => item.id === state.selectedPromptId)) {
        state.selectedPromptId = "";
      }
      (state.promptFiles || []).forEach((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.title + " | " + item.path;
        if (item.id === state.selectedPromptId) {
          option.selected = true;
        }
        list.appendChild(option);
      });
      if (!state.selectedPromptId && state.promptFiles.length > 0) {
        state.selectedPromptId = state.promptFiles[0].id;
      }
      list.value = state.selectedPromptId || "";
      updatePromptMeta();
    }

    function updatePromptMeta() {
      const current = (state.promptFiles || []).find((item) => item.id === state.selectedPromptId);
      if (!current) {
        $("#prompt-selected-meta").textContent = "No prompt selected";
        return;
      }
      $("#prompt-selected-meta").textContent = current.title + " | " + current.path;
    }

    async function readPromptContent() {
      const id = state.selectedPromptId;
      if (!id) {
        $("#prompt-editor").value = "";
        updatePromptMeta();
        return;
      }
      const payload = await api("/api/prompts/read", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      $("#prompt-editor").value = payload.content || "";
      updatePromptMeta();
    }

    async function addPrompt() {
      const title = $("#prompt-add-title").value.trim();
      const promptPath = $("#prompt-add-path").value.trim();
      if (!promptPath) {
        setStatus("Prompt path is required.", "error");
        return;
      }
      const payload = await api("/api/prompts/add", {
        method: "POST",
        body: JSON.stringify({ title, path: promptPath }),
      });
      state.promptFiles = payload.promptFiles || [];
      state.selectedPromptId = state.promptFiles.length > 0 ? state.promptFiles[state.promptFiles.length - 1].id : "";
      renderPromptList();
      await readPromptContent();
      $("#prompt-add-title").value = "";
      $("#prompt-add-path").value = "";
      setStatus("Prompt file added.", "ok");
    }

    async function removePrompt() {
      const id = state.selectedPromptId;
      if (!id) {
        return;
      }
      const payload = await api("/api/prompts/remove", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      state.promptFiles = payload.promptFiles || [];
      state.selectedPromptId = state.promptFiles.length > 0 ? state.promptFiles[0].id : "";
      renderPromptList();
      await readPromptContent();
      setStatus("Prompt removed.", "ok");
    }

    async function savePrompt() {
      const id = state.selectedPromptId;
      if (!id) {
        setStatus("Select a prompt first.", "error");
        return;
      }
      const content = $("#prompt-editor").value;
      await api("/api/prompts/save", {
        method: "POST",
        body: JSON.stringify({ id, content }),
      });
      setStatus("Prompt file saved.", "ok");
    }

    async function loadLogs() {
      const payload = await api("/api/logs?limit=1000");
      const lines = payload.lines || [];
      $("#logs-view").textContent = lines.join("\\n");
      $("#logs-meta").textContent = lines.length + " lines";
    }

    async function refreshPreview(options = {}) {
      const silent = Boolean(options.silent);
      if (!silent) {
        setStatus("Refreshing emulator preview...");
      }
      const preview = await api("/api/emulator/preview");
      state.preview = preview;
      const image = $("#preview-image");
      image.src = "data:image/png;base64," + preview.screenshotBase64;
      image.dataset.pixelWidth = String(preview.width || 0);
      image.dataset.pixelHeight = String(preview.height || 0);
      image.style.display = "block";
      $("#preview-empty").style.display = "none";
      $("#preview-meta").textContent =
        "App: " + (preview.currentApp || "unknown") +
        " | " + (preview.width || "?") + "x" + (preview.height || "?") +
        " | Updated: " + new Date(preview.capturedAt || Date.now()).toLocaleTimeString();
      if (!silent) {
        setStatus("Preview updated.", "ok");
      }
    }

    async function emulatorAction(action) {
      if (state.emulatorActionPending) {
        setStatus("Another emulator action is already running. Please wait.", "error");
        return;
      }
      state.emulatorActionPending = true;
      setEmulatorButtonsDisabled(true);
      setStatus("Running emulator action: " + action + " ...");
      try {
        const payload = await api("/api/emulator/" + action, { method: "POST", body: "{}" });
        setStatus(payload.message || ("Emulator " + action + " done."), "ok");
        await loadRuntime();
      } finally {
        state.emulatorActionPending = false;
        setEmulatorButtonsDisabled(false);
      }
    }

    function setEmulatorButtonsDisabled(disabled) {
      document
        .querySelectorAll("[data-emu-action], #emu-refresh-btn, #onboard-start-emu, #onboard-show-emu")
        .forEach((button) => {
          button.disabled = Boolean(disabled);
        });
    }

    async function sendTextInput() {
      const text = $("#emulator-text-input").value || "";
      if (!text.trim()) {
        setStatus("Input text is empty.", "error");
        return;
      }
      const payload = await api("/api/emulator/type", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setStatus(payload.message || "Text input sent.", "ok");
      await refreshPreview({ silent: true }).catch(() => {});
    }

    async function saveCorePaths() {
      const workspaceDir = $("#workspace-input").value.trim();
      const stateDir = $("#state-input").value.trim();
      const payload = await api("/api/config", {
        method: "POST",
        body: JSON.stringify({ workspaceDir, stateDir }),
      });
      state.config = payload.config;
      setStatus("Config saved.", "ok");
      await loadRuntime();
      await loadConfigAndOnboarding();
      await loadControlSettings();
    }

    async function saveOnboarding() {
      const selectedModelProfile = $("#onboard-model-select").value;
      const consentAccepted = $("#onboard-consent").checked;
      const gmailLoginDone = $("#onboard-gmail-done").checked;
      const useEnvKey = $("#onboard-use-env").checked;
      const apiKey = $("#onboard-api-key").value;

      await api("/api/onboarding/apply", {
        method: "POST",
        body: JSON.stringify({
          selectedModelProfile,
          consentAccepted,
          gmailLoginDone,
          useEnvKey,
          apiKey,
        }),
      });
      setStatus("Onboarding saved to config + state.", "ok");
      await loadConfigAndOnboarding();
      await loadRuntime();
    }

    async function sendPreviewTap(event) {
      const image = $("#preview-image");
      const width = Number(image.dataset.pixelWidth || "0");
      const height = Number(image.dataset.pixelHeight || "0");
      if (!width || !height) {
        return;
      }
      const rect = image.getBoundingClientRect();
      const localX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const localY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
      const targetX = Math.round((localX / rect.width) * width);
      const targetY = Math.round((localY / rect.height) * height);

      await api("/api/emulator/tap", {
        method: "POST",
        body: JSON.stringify({ x: targetX, y: targetY }),
      });
      setStatus("Tap sent at (" + targetX + ", " + targetY + ").", "ok");
      await refreshPreview({ silent: true }).catch(() => {});
    }

    function bindEvents() {
      document.querySelectorAll(".tab-btn").forEach((button) => {
        button.addEventListener("click", () => {
          const tab = button.dataset.tab;
          activateTab(tab);
          if (tab === "logs") {
            loadLogs().catch(() => {});
          }
          if (tab === "permissions") {
            loadScopedFiles().catch(() => {});
          }
          if (tab === "prompts") {
            renderPromptList();
            readPromptContent().catch(() => {});
          }
        });
      });

      $("#runtime-refresh-btn").addEventListener("click", () => {
        loadRuntime().then(() => setStatus("Runtime refreshed.", "ok")).catch((error) => setStatus(error.message, "error"));
      });

      $("#emu-refresh-btn").addEventListener("click", () => {
        loadRuntime().then(() => setStatus("Emulator status refreshed.", "ok")).catch((error) => setStatus(error.message, "error"));
      });

      document.querySelectorAll("[data-emu-action]").forEach((button) => {
        button.addEventListener("click", () => {
          emulatorAction(button.dataset.emuAction).catch((error) => setStatus(error.message, "error"));
        });
      });

      $("#preview-refresh-btn").addEventListener("click", () => {
        refreshPreview({ silent: false }).catch((error) => setStatus(error.message, "error"));
      });

      $("#preview-auto").addEventListener("change", (event) => {
        const enabled = event.target.checked;
        if (state.previewTimer) {
          clearInterval(state.previewTimer);
          state.previewTimer = null;
        }
        if (enabled) {
          state.previewTimer = setInterval(() => {
            refreshPreview({ silent: true }).catch(() => {});
          }, 2000);
        }
      });

      $("#emulator-text-send").addEventListener("click", () => {
        sendTextInput().catch((error) => setStatus(error.message, "error"));
      });

      $("#save-core-paths-btn").addEventListener("click", () => {
        saveCorePaths().catch((error) => setStatus(error.message, "error"));
      });

      $("#onboard-use-env").addEventListener("change", (event) => {
        $("#onboard-api-key-wrap").style.display = event.target.checked ? "none" : "block";
      });

      $("#onboard-model-select").addEventListener("change", () => {
        const select = $("#onboard-model-select");
        const selected = select.value || state.config?.defaultModel;
        const profile = state.config?.models?.[selected];
        const provider = profile?.baseUrl || "unknown";
        const envName = profile?.apiKeyEnv || "N/A";
        const modelId = profile?.model || "unknown";
        const status = state.credentialStatus[selected] || "";
        // Use textContent to avoid XSS from config values.
        const meta = $("#onboard-model-meta");
        meta.textContent = "";
        const lines = [
          "Model ID: " + modelId,
          "Provider: " + provider,
          "Provider API env: " + envName,
          status,
        ].filter(Boolean);
        for (const line of lines) {
          const div = document.createElement("div");
          div.textContent = line;
          meta.appendChild(div);
        }
      });

      $("#onboard-save-btn").addEventListener("click", () => {
        saveOnboarding().catch((error) => setStatus(error.message, "error"));
      });

      $("#onboard-start-emu").addEventListener("click", () => {
        emulatorAction("start").catch((error) => setStatus(error.message, "error"));
      });

      $("#onboard-show-emu").addEventListener("click", () => {
        emulatorAction("show").catch((error) => setStatus(error.message, "error"));
      });

      $("#preview-image").addEventListener("click", (event) => {
        sendPreviewTap(event).catch((error) => setStatus(error.message, "error"));
      });

      $("#perm-save-btn").addEventListener("click", () => {
        savePermissions()
          .then(() => loadScopedFiles())
          .catch((error) => setStatus(error.message, "error"));
      });

      $("#perm-refresh-files-btn").addEventListener("click", () => {
        loadScopedFiles()
          .then(() => setStatus("Scoped files refreshed.", "ok"))
          .catch((error) => setStatus(error.message, "error"));
      });

      $("#perm-file-list").addEventListener("change", () => {
        readScopedFile().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-add-btn").addEventListener("click", () => {
        addPrompt().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-remove-btn").addEventListener("click", () => {
        removePrompt().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-list").addEventListener("change", (event) => {
        state.selectedPromptId = event.target.value || "";
        readPromptContent().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-reload-btn").addEventListener("click", () => {
        readPromptContent().catch((error) => setStatus(error.message, "error"));
      });

      $("#prompt-save-btn").addEventListener("click", () => {
        savePrompt().catch((error) => setStatus(error.message, "error"));
      });

      $("#logs-refresh-btn").addEventListener("click", () => {
        loadLogs().catch((error) => setStatus(error.message, "error"));
      });

      $("#logs-clear-btn").addEventListener("click", () => {
        api("/api/logs/clear", { method: "POST", body: "{}" })
          .then(() => loadLogs())
          .then(() => setStatus("Logs cleared.", "ok"))
          .catch((error) => setStatus(error.message, "error"));
      });

      $("#logs-auto").addEventListener("change", (event) => {
        const enabled = event.target.checked;
        if (state.logsTimer) {
          clearInterval(state.logsTimer);
          state.logsTimer = null;
        }
        if (enabled) {
          state.logsTimer = setInterval(() => {
            if (document.querySelector('[data-panel="logs"]').classList.contains("active")) {
              loadLogs().catch(() => {});
            }
          }, 2000);
        }
      });
    }

    async function init() {
      bindEvents();
      try {
        await loadRuntime();
        await loadConfigAndOnboarding();
        await loadControlSettings();
        await loadScopedFiles();
        await loadLogs();
        setStatus("Dashboard ready.", "ok");
      } catch (error) {
        setStatus(error.message || "Initialization failed", "error");
      }
      state.runtimeTimer = setInterval(() => {
        loadRuntime().catch(() => {});
      }, 3000);
    }

    init();
  </script>
  </body>
</html>`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);

    try {
      if (method === "GET" && url.pathname === "/") {
        sendHtml(res, 200, this.htmlShell());
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          mode: this.mode,
          address: this.address,
          now: nowIso(),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/runtime") {
        sendJson(res, 200, this.runtimePayload());
        return;
      }

      if (method === "GET" && url.pathname === "/api/logs") {
        const limitRaw = Number(url.searchParams.get("limit") ?? "200");
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, Math.round(limitRaw))) : 200;
        sendJson(res, 200, {
          lines: this.listLogs(limit),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/logs/clear") {
        this.clearLogs();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, {
          config: this.config,
          modelProfiles: Object.keys(this.config.models).sort(),
          credentialStatus: this.credentialStatusMap(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/config") {
        const body = await readJsonBody(req);
        const updated = this.applyConfigPatch(body);
        sendJson(res, 200, {
          ok: true,
          config: updated,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/onboarding") {
        sendJson(res, 200, {
          onboarding: loadOnboardingState(this.config),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/onboarding") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid onboarding state payload.");
        }
        const merged: OnboardingStateFile = {
          ...loadOnboardingState(this.config),
          ...body,
          updatedAt: nowIso(),
        };
        saveOnboardingState(this.config, merged);
        sendJson(res, 200, {
          ok: true,
          onboarding: merged,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/onboarding/apply") {
        const body = await readJsonBody(req);
        const applied = this.applyOnboarding(body);
        sendJson(res, 200, {
          ok: true,
          onboarding: applied.onboarding,
          config: applied.config,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/control-settings") {
        const current = loadControlSettings(this.config);
        sendJson(res, 200, {
          controlSettings: current,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/control-settings") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid control settings payload.");
        }
        const merged: MenuBarControlSettings = {
          ...defaultControlSettings(this.config),
          ...loadControlSettings(this.config),
          ...body,
          updatedAt: nowIso(),
        };
        saveControlSettings(this.config, merged);
        sendJson(res, 200, {
          ok: true,
          controlSettings: merged,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/prompts") {
        const control = loadControlSettings(this.config);
        sendJson(res, 200, {
          promptFiles: control.promptFiles,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/prompts/add") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid prompt add payload.");
        }
        const title = String(body.title ?? "").trim();
        const promptPath = String(body.path ?? "").trim();
        if (!promptPath) {
          throw new Error("Prompt path is required.");
        }

        const control = loadControlSettings(this.config);
        const next = {
          ...control,
          promptFiles: [...control.promptFiles],
          updatedAt: nowIso(),
        };
        const id = String(body.id ?? "").trim() || `prompt-${crypto.randomUUID()}`;
        next.promptFiles.push({
          id,
          title: title || path.basename(promptPath, path.extname(promptPath)),
          path: resolvePath(promptPath),
        });
        saveControlSettings(this.config, next);
        this.log(`prompt added id=${id}`);
        sendJson(res, 200, {
          ok: true,
          promptFiles: next.promptFiles,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/prompts/remove") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid prompt remove payload.");
        }
        const id = String(body.id ?? "").trim();
        if (!id) {
          throw new Error("Prompt id is required.");
        }

        const control = loadControlSettings(this.config);
        const next = {
          ...control,
          promptFiles: control.promptFiles.filter((item) => item.id !== id),
          updatedAt: nowIso(),
        };
        saveControlSettings(this.config, next);
        this.log(`prompt removed id=${id}`);
        sendJson(res, 200, {
          ok: true,
          promptFiles: next.promptFiles,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/prompts/read") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid prompt read payload.");
        }
        const id = String(body.id ?? "").trim();
        if (!id) {
          throw new Error("Prompt id is required.");
        }

        const control = loadControlSettings(this.config);
        const prompt = control.promptFiles.find((item) => item.id === id);
        if (!prompt) {
          throw new Error(`Prompt not found: ${id}`);
        }
        const content = this.readPromptFile(prompt.path);
        sendJson(res, 200, {
          prompt,
          content,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/prompts/save") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid prompt save payload.");
        }
        const id = String(body.id ?? "").trim();
        if (!id) {
          throw new Error("Prompt id is required.");
        }
        const content = String(body.content ?? "");

        const control = loadControlSettings(this.config);
        const prompt = control.promptFiles.find((item) => item.id === id);
        if (!prompt) {
          throw new Error(`Prompt not found: ${id}`);
        }
        this.savePromptFile(prompt.path, content);
        this.log(`prompt saved id=${id}`);
        sendJson(res, 200, {
          ok: true,
          prompt,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/permissions/files") {
        const control = loadControlSettings(this.config);
        sendJson(res, 200, {
          files: this.readScopedFiles(control),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/permissions/read-file") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid read-file payload.");
        }
        const filePath = String(body.path ?? "").trim();
        if (!filePath) {
          throw new Error("Missing file path.");
        }
        const control = loadControlSettings(this.config);
        const content = this.readScopedFile(control, filePath);
        sendJson(res, 200, {
          path: filePath,
          content,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/emulator/status") {
        const status = this.emulator.status();
        sendJson(res, 200, {
          status,
          statusText:
            status.bootedDevices.length > 0
              ? `Running (${status.bootedDevices.join(", ")})`
              : status.devices.length > 0
                ? `Starting (${status.devices.join(", ")})`
                : "Stopped",
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/start") {
        const message = await this.runEmulatorLifecycleExclusive("start", () => this.emulator.start(true));
        this.log(`emulator start ${message}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/stop") {
        const message = await this.runEmulatorLifecycleExclusive("stop", async () => this.emulator.stop());
        this.log(`emulator stop ${message}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/show") {
        const message = await this.runEmulatorLifecycleExclusive("show", () => this.emulator.ensureWindowVisible());
        this.log(`emulator show ${message}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/hide") {
        const message = await this.runEmulatorLifecycleExclusive("hide", () => this.emulator.ensureHiddenBackground());
        this.log(`emulator hide ${message}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "GET" && url.pathname === "/api/emulator/preview") {
        const snapshot = await this.adb.captureScreenSnapshot(this.config.agent.deviceId);
        this.previewCache = snapshot;
        sendJson(res, 200, snapshot);
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/tap") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid tap payload.");
        }
        const x = Number(body.x);
        const y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("Tap coordinates must be numbers.");
        }
        const message = this.emulator.tap(Math.round(x), Math.round(y), this.config.agent.deviceId ?? undefined);
        this.log(`emulator tap x=${Math.round(x)} y=${Math.round(y)}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (method === "POST" && url.pathname === "/api/emulator/type") {
        const body = await readJsonBody(req);
        if (!isObject(body)) {
          throw new Error("Invalid text payload.");
        }
        const text = String(body.text ?? "");
        if (!text.trim()) {
          throw new Error("Text input is empty.");
        }
        const message = this.emulator.typeText(text, this.config.agent.deviceId ?? undefined);
        this.log(`emulator type length=${text.length}`);
        sendJson(res, 200, { ok: true, message });
        return;
      }

      sendText(res, 404, "Not found");
    } catch (error) {
      const message = (error as Error).message || "Unknown error";
      this.log(`request failed method=${method} path=${url.pathname} error=${message}`);
      sendJson(res, 400, {
        ok: false,
        error: message,
      });
    }
  }
}
