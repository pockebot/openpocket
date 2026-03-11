import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { HumanAuthTunnelNgrokConfig } from "../types.js";
import { formatDetailedError } from "../utils/error-details.js";
import { sleep } from "../utils/time.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (!value || value === "::" || value === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (value === "localhost") {
    return "127.0.0.1";
  }
  return value;
}

function toHostPort(value: string): string {
  let url = value.trim();
  if (!url) {
    return "";
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  try {
    const parsed = new URL(url);
    const host = normalizeHost(parsed.hostname);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${host}:${port}`;
  } catch {
    return "";
  }
}

function normalizeApiBaseUrl(value: string): string {
  const hostPort = toHostPort(value);
  if (!hostPort) {
    return "";
  }
  return `http://${hostPort}`;
}

export class NgrokTunnel {
  private readonly config: HumanAuthTunnelNgrokConfig;
  private readonly targetUrl: string;
  private readonly log: (line: string) => void;
  private process: ChildProcessWithoutNullStreams | null = null;
  private publicUrl = "";
  private closed = false;
  private apiBaseUrl = "";
  private processExitHint = "";

  constructor(
    config: HumanAuthTunnelNgrokConfig,
    targetUrl: string,
    log?: (line: string) => void,
  ) {
    this.config = config;
    this.targetUrl = targetUrl;
    this.log =
      log ??
      ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      });
  }

  private resolveAuthtoken(): string {
    if (this.config.authtoken.trim()) {
      return this.config.authtoken.trim();
    }
    if (this.config.authtokenEnv.trim()) {
      return process.env[this.config.authtokenEnv]?.trim() ?? "";
    }
    return "";
  }

  private parseNgrokApiBaseUrlFromLine(line: string): string {
    if (!line.startsWith("{")) {
      return "";
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isObject(parsed)) {
        return "";
      }
      const msg = String(parsed.msg ?? "");
      const addr = String(parsed.addr ?? "");
      if (!msg.toLowerCase().includes("starting web service")) {
        return "";
      }
      return normalizeApiBaseUrl(addr);
    } catch {
      return "";
    }
  }

  private async queryPublicUrlFromApi(apiBaseUrl: string): Promise<string> {
    const response = await fetch(`${apiBaseUrl}/api/tunnels`);
    if (!response.ok) {
      throw new Error(`ngrok api status=${response.status} at ${apiBaseUrl}`);
    }
    const parsed = (await response.json()) as unknown;
    if (!isObject(parsed) || !Array.isArray(parsed.tunnels)) {
      throw new Error(`ngrok api returned invalid payload at ${apiBaseUrl}`);
    }
    const targetKey = toHostPort(this.targetUrl);
    const tunnels = parsed.tunnels
      .filter((item): item is Record<string, unknown> => isObject(item))
      .map((item) => ({
        publicUrl: String(item.public_url ?? ""),
        addr: isObject(item.config) ? String(item.config.addr ?? "") : String(item.addr ?? ""),
      }))
      .filter((item) => item.publicUrl.startsWith("https://"));
    if (tunnels.length === 0) {
      throw new Error(`ngrok api has no https tunnel yet at ${apiBaseUrl}`);
    }
    const matched = tunnels.find((item) => toHostPort(item.addr) === targetKey);
    if (!matched) {
      throw new Error(`ngrok api has no tunnel for target ${this.targetUrl} at ${apiBaseUrl}`);
    }
    return matched.publicUrl.replace(/\/+$/, "");
  }

  private async readPublicUrlFromApi(): Promise<string> {
    const candidates = [
      normalizeApiBaseUrl(this.apiBaseUrl),
      normalizeApiBaseUrl(this.config.apiBaseUrl),
      "http://127.0.0.1:4040",
      "http://127.0.0.1:4041",
      "http://127.0.0.1:4042",
    ].filter(Boolean);
    const seen = new Set<string>();
    let lastError = "ngrok api endpoint unavailable";
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      try {
        // eslint-disable-next-line no-await-in-loop
        const url = await this.queryPublicUrlFromApi(candidate);
        this.apiBaseUrl = candidate;
        return url;
      } catch (error) {
        lastError = formatDetailedError(error);
      }
    }
    throw new Error(lastError);
  }

  async start(): Promise<string> {
    if (this.process && !this.closed) {
      if (this.publicUrl) {
        return this.publicUrl;
      }
      throw new Error("ngrok tunnel is starting.");
    }

    this.apiBaseUrl = normalizeApiBaseUrl(this.config.apiBaseUrl) || "http://127.0.0.1:4040";
    this.processExitHint = "";

    const args = [
      "http",
      this.targetUrl,
      "--log",
      "stdout",
      "--log-format",
      "json",
    ];
    const authtoken = this.resolveAuthtoken();
    if (authtoken) {
      args.push("--authtoken", authtoken);
    }

    this.closed = false;
    const child = spawn(this.config.executable, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    const onChunk = (prefix: string, chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const discoveredApiBase = this.parseNgrokApiBaseUrlFromLine(trimmed);
        if (discoveredApiBase) {
          this.apiBaseUrl = discoveredApiBase;
        }
        const lowered = trimmed.toLowerCase();
        if (
          lowered.includes("err_ngrok_") ||
          lowered.includes("unknown flag") ||
          lowered.includes("authentication failed")
        ) {
          this.processExitHint = trimmed;
        }
        this.log(`[OpenPocket][human-auth][debug][ngrok] ${prefix}${trimmed}`);
      }
    };
    child.stdout.on("data", (chunk) => onChunk("", chunk));
    child.stderr.on("data", (chunk) => onChunk("stderr: ", chunk));
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.log(
        `[OpenPocket][human-auth][warn][ngrok] process exited code=${code ?? "(null)"} signal=${signal ?? "(null)"}`,
      );
    });
    child.on("error", (error) => {
      this.log(`[OpenPocket][human-auth][error][ngrok] process error=${formatDetailedError(error)}`);
    });

    const deadline = Date.now() + this.config.startupTimeoutSec * 1000;
    let lastError = "";
    while (Date.now() < deadline) {
      if (!this.process || this.closed) {
        const suffix = this.processExitHint ? ` ${this.processExitHint}` : "";
        throw new Error(`ngrok process exited before tunnel became ready.${suffix}`);
      }
      try {
        const url = await this.readPublicUrlFromApi();
        this.publicUrl = url;
        return url;
      } catch (error) {
        lastError = formatDetailedError(error);
      }
      await sleep(500);
    }

    await this.stop();
    throw new Error(`Timed out waiting for ngrok tunnel url. ${lastError}`);
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    const current = this.process;
    this.process = null;
    if (current.killed || this.closed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!current.killed) {
          current.kill("SIGKILL");
        }
      }, 3000);

      current.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      current.kill("SIGTERM");
    });
  }
}
