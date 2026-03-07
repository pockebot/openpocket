import http from "node:http";
import { Readable } from "node:stream";

import type { HumanAuthTunnelNgrokConfig } from "../types.js";
import { NgrokTunnel } from "../human-auth/ngrok-tunnel.js";

interface RelayHubRegistration {
  agentId: string;
  baseUrl: string;
  registeredAt: string;
}

export interface RelayHubServerOptions {
  host: string;
  port: number;
  publicBaseUrl?: string;
  ngrok?: HumanAuthTunnelNgrokConfig | null;
  logger?: (line: string) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function shouldForwardRequestBody(method: string | undefined): boolean {
  const normalized = String(method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

export class RelayHubServer {
  private readonly host: string;
  private readonly port: number;
  private readonly explicitPublicBaseUrl: string;
  private readonly ngrokConfig: HumanAuthTunnelNgrokConfig | null;
  private readonly log: (line: string) => void;
  private server: http.Server | null = null;
  private ngrok: NgrokTunnel | null = null;
  private publicBaseUrlValue = "";
  private readonly registrations = new Map<string, RelayHubRegistration>();

  constructor(options: RelayHubServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.explicitPublicBaseUrl = stripTrailingSlash(options.publicBaseUrl || "");
    this.ngrokConfig = options.ngrok ?? null;
    this.log =
      options.logger ??
      ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      });
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

  get publicBaseUrl(): string {
    return this.publicBaseUrlValue || this.address;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        json(res, 500, { ok: false, error: (error as Error).message });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    let publicBaseUrl = this.explicitPublicBaseUrl;
    if (!publicBaseUrl && this.ngrokConfig?.enabled) {
      this.ngrok = new NgrokTunnel(this.ngrokConfig, this.address, this.log);
      publicBaseUrl = await this.ngrok.start();
      this.log(`[OpenPocket][relay-hub] ngrok tunnel url=${publicBaseUrl}`);
    }
    this.publicBaseUrlValue = stripTrailingSlash(publicBaseUrl || this.address);
    this.log(`[OpenPocket][relay-hub] listening local=${this.address} public=${this.publicBaseUrl}`);
  }

  async stop(): Promise<void> {
    const ngrok = this.ngrok;
    this.ngrok = null;
    if (ngrok) {
      await ngrok.stop();
    }
    const server = this.server;
    this.server = null;
    this.registrations.clear();
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

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        address: this.address,
        publicBaseUrl: this.publicBaseUrl,
        registrations: [...this.registrations.values()],
      });
      return;
    }

    const registerMatch = url.pathname.match(/^\/v1\/relay-hub\/agents\/([^/]+)$/);
    if (registerMatch?.[1]) {
      const agentId = decodeURIComponent(registerMatch[1]);
      if (req.method === "PUT") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse((await readBody(req)).toString("utf-8") || "{}") as Record<string, unknown>;
        } catch {
          json(res, 400, { ok: false, error: "Invalid JSON body." });
          return;
        }
        const baseUrl = stripTrailingSlash(String(body.baseUrl ?? ""));
        if (!baseUrl) {
          json(res, 400, { ok: false, error: "baseUrl is required." });
          return;
        }
        this.registrations.set(agentId, {
          agentId,
          baseUrl,
          registeredAt: nowIso(),
        });
        json(res, 200, {
          ok: true,
          relayBaseUrl: `${this.address}/a/${encodeURIComponent(agentId)}`,
          publicBaseUrl: `${this.publicBaseUrl}/a/${encodeURIComponent(agentId)}`,
        });
        return;
      }
      if (req.method === "DELETE") {
        this.registrations.delete(agentId);
        json(res, 200, { ok: true });
        return;
      }
      json(res, 405, { ok: false, error: "Method not allowed." });
      return;
    }

    const proxyMatch = url.pathname.match(/^\/a\/([^/]+)(\/.*)?$/);
    if (proxyMatch?.[1]) {
      const agentId = decodeURIComponent(proxyMatch[1]);
      const registration = this.registrations.get(agentId);
      if (!registration) {
        json(res, 404, { ok: false, error: `No relay registered for agent '${agentId}'.` });
        return;
      }
      const suffix = proxyMatch[2] || "/";
      await this.proxyToAgent(registration, suffix + url.search, req, res);
      return;
    }

    json(res, 404, { ok: false, error: "Not found." });
  }

  private async proxyToAgent(
    registration: RelayHubRegistration,
    suffixWithQuery: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const targetUrl = `${registration.baseUrl}${suffixWithQuery}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") {
        continue;
      }
      const normalized = normalizeHeaderValue(value);
      if (normalized !== null) {
        headers.set(key, normalized);
      }
    }
    headers.set("x-openpocket-agent-id", registration.agentId);
    const requestBody = shouldForwardRequestBody(req.method) ? await readBody(req) : null;

    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: requestBody ? new Uint8Array(requestBody) : undefined,
      });
    } catch (error) {
      json(res, 502, { ok: false, error: `Upstream agent '${registration.agentId}' unreachable: ${(error as Error).message}` });
      return;
    }

    res.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() === "transfer-encoding") {
        continue;
      }
      res.setHeader(key, value);
    }
    if (!response.body) {
      res.end();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<any>)
        .on("error", reject)
        .pipe(res)
        .on("finish", resolve)
        .on("error", reject);
    });
  }
}
