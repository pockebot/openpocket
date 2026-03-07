import http from "node:http";

import { loadConfig } from "../config/index.js";
import type { OpenPocketConfig } from "../types.js";
import { listManagerAgents, type ManagerAgentRecord } from "./registry.js";
import { readGatewayRuntimeLock } from "./runtime-locks.js";

export interface ManagerDashboardAgentSummary {
  id: string;
  kind: "default" | "managed";
  projectName: string;
  configPath: string;
  workspaceDir: string;
  stateDir: string;
  defaultModel: string;
  targetFingerprint: string;
  dashboardUrl: string;
  gatewayRunning: boolean;
  gatewayPid: number | null;
  channels: string[];
  humanAuthEnabled: boolean;
}

export interface ManagerDashboardServerOptions {
  host: string;
  port: number;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}

function channelNames(config: OpenPocketConfig): string[] {
  const names: string[] = [];
  if (config.channels?.telegram && config.channels.telegram.enabled !== false) names.push("telegram");
  if (config.channels?.discord && config.channels.discord.enabled !== false) names.push("discord");
  if (config.channels?.whatsapp && config.channels.whatsapp.enabled !== false) names.push("whatsapp");
  if (config.channels?.imessage && config.channels.imessage.enabled !== false) names.push("imessage");
  return names;
}

function dashboardUrlFor(record: ManagerAgentRecord, config: OpenPocketConfig): string {
  const lock = readGatewayRuntimeLock(record.stateDir);
  if (lock?.dashboardAddress) {
    return lock.dashboardAddress;
  }
  const host = config.dashboard.host === "0.0.0.0" ? "127.0.0.1" : config.dashboard.host;
  return `http://${host}:${config.dashboard.port}`;
}

function summarizeAgent(record: ManagerAgentRecord): ManagerDashboardAgentSummary {
  const config = loadConfig(record.configPath);
  const lock = readGatewayRuntimeLock(record.stateDir);
  return {
    id: record.id,
    kind: record.kind,
    projectName: config.projectName,
    configPath: config.configPath,
    workspaceDir: config.workspaceDir,
    stateDir: config.stateDir,
    defaultModel: config.defaultModel,
    targetFingerprint: record.targetFingerprint,
    dashboardUrl: dashboardUrlFor(record, config),
    gatewayRunning: Boolean(lock),
    gatewayPid: lock?.pid ?? null,
    channels: channelNames(config),
    humanAuthEnabled: Boolean(config.humanAuth.enabled),
  };
}

function renderHtml(agents: ManagerDashboardAgentSummary[]): string {
  const cards = agents.map((agent) => {
    const channels = agent.channels.length > 0 ? agent.channels.join(", ") : "none";
    const status = agent.gatewayRunning
      ? `running (pid ${agent.gatewayPid ?? "?"})`
      : "stopped";
    return `
      <article class="card">
        <header>
          <div>
            <p class="eyebrow">${agent.kind}</p>
            <h2>${escapeHtml(agent.id)}</h2>
          </div>
          <span class="status ${agent.gatewayRunning ? "running" : "stopped"}">${status}</span>
        </header>
        <dl>
          <div><dt>Project</dt><dd>${escapeHtml(agent.projectName)}</dd></div>
          <div><dt>Model</dt><dd>${escapeHtml(agent.defaultModel)}</dd></div>
          <div><dt>Target</dt><dd>${escapeHtml(agent.targetFingerprint)}</dd></div>
          <div><dt>Channels</dt><dd>${escapeHtml(channels)}</dd></div>
          <div><dt>Human auth</dt><dd>${agent.humanAuthEnabled ? "enabled" : "disabled"}</dd></div>
          <div><dt>Config</dt><dd>${escapeHtml(agent.configPath)}</dd></div>
          <div><dt>Workspace</dt><dd>${escapeHtml(agent.workspaceDir)}</dd></div>
          <div><dt>State</dt><dd>${escapeHtml(agent.stateDir)}</dd></div>
        </dl>
        <footer>
          <a href="${escapeHtml(agent.dashboardUrl)}" target="_blank" rel="noreferrer">Open agent dashboard</a>
        </footer>
      </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenPocket Manager</title>
  <style>
    :root {
      --bg: #f4f0e8;
      --paper: #fffdf7;
      --ink: #1f1d18;
      --muted: #6f6b62;
      --line: #d8cfbe;
      --accent: #0f766e;
      --running: #146c43;
      --stopped: #8b1e3f;
      --shadow: 0 18px 48px rgba(31, 29, 24, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.16), transparent 24%),
        radial-gradient(circle at top right, rgba(196, 84, 68, 0.12), transparent 20%),
        linear-gradient(180deg, #f7f2ea 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    main {
      max-width: 1320px;
      margin: 0 auto;
      padding: 40px 20px 56px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: end;
      margin-bottom: 24px;
    }
    h1 {
      font-size: clamp(2rem, 6vw, 4rem);
      margin: 0;
      letter-spacing: -0.04em;
    }
    .sub {
      margin: 8px 0 0;
      color: var(--muted);
      max-width: 720px;
      line-height: 1.5;
    }
    .pill {
      align-self: start;
      border: 1px solid var(--line);
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(255,255,255,0.72);
      color: var(--muted);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
    }
    .card {
      background: var(--paper);
      border: 1px solid rgba(216, 207, 190, 0.8);
      border-radius: 24px;
      padding: 20px;
      box-shadow: var(--shadow);
    }
    .card header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: start;
      margin-bottom: 18px;
    }
    .eyebrow {
      margin: 0 0 6px;
      text-transform: uppercase;
      font-size: 0.72rem;
      letter-spacing: 0.18em;
      color: var(--muted);
    }
    h2 {
      margin: 0;
      font-size: 1.5rem;
    }
    .status {
      display: inline-flex;
      padding: 8px 10px;
      border-radius: 999px;
      font-size: 0.85rem;
      border: 1px solid currentColor;
      white-space: nowrap;
    }
    .status.running { color: var(--running); }
    .status.stopped { color: var(--stopped); }
    dl {
      margin: 0;
      display: grid;
      gap: 10px;
    }
    dl div {
      display: grid;
      gap: 2px;
      padding-bottom: 10px;
      border-bottom: 1px solid rgba(216, 207, 190, 0.6);
    }
    dt {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
    }
    dd {
      margin: 0;
      line-height: 1.45;
      word-break: break-word;
    }
    footer {
      margin-top: 18px;
    }
    a {
      color: var(--accent);
      font-weight: 600;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    @media (max-width: 720px) {
      .hero {
        flex-direction: column;
        align-items: start;
      }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <h1>Agent Manager</h1>
        <p class="sub">Review every agent instance, its target binding, channel footprint, and current runtime status. Jump into any per-agent dashboard without crossing workspaces.</p>
      </div>
      <div class="pill">${agents.length} agents</div>
    </section>
    <section class="grid">${cards}</section>
  </main>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export class ManagerDashboardServer {
  private readonly host: string;
  private readonly port: number;
  private server: http.Server | null = null;

  constructor(options: ManagerDashboardServerOptions) {
    this.host = options.host;
    this.port = options.port;
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

  private listAgentSummaries(): ManagerDashboardAgentSummary[] {
    return listManagerAgents().map(summarizeAgent);
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/agents") {
        sendJson(res, 200, { ok: true, agents: this.listAgentSummaries() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, 200, renderHtml(this.listAgentSummaries()));
        return;
      }
      sendJson(res, 404, { ok: false, error: "Not found" });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
