import type { OpenPocketConfig } from "../types.js";
import { findManagerAgentByConfigPath } from "../manager/registry.js";
import { loadManagerPorts } from "../manager/ports.js";
import { HumanAuthRelayServer } from "./relay-server.js";
import { NgrokTunnel } from "./ngrok-tunnel.js";
import { LocalHumanAuthTakeoverRuntime } from "./takeover-runtime.js";
import type { HumanAuthTakeoverRuntime } from "./takeover-runtime.js";

export interface LocalHumanAuthStackStartResult {
  relayBaseUrl: string;
  publicBaseUrl: string;
}

type HubRegistrationResponse = {
  relayBaseUrl: string;
  publicBaseUrl: string;
};

export interface LocalHumanAuthStackOptions {
  takeoverRuntime?: HumanAuthTakeoverRuntime;
}

export interface LocalHumanAuthSignedScreenshot {
  url: string;
  expiresAt: string;
}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export class LocalHumanAuthStack {
  private readonly config: OpenPocketConfig;
  private readonly log: (line: string) => void;
  private readonly options: LocalHumanAuthStackOptions;
  private relay: HumanAuthRelayServer | null = null;
  private ngrok: NgrokTunnel | null = null;
  private registeredAgentId: string | null = null;
  private resolvedRelayBaseUrl = "";
  private resolvedPublicBaseUrl = "";

  constructor(config: OpenPocketConfig, log?: (line: string) => void, options: LocalHumanAuthStackOptions = {}) {
    this.config = config;
    this.options = options;
    this.log =
      log ??
      ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      });
  }

  async start(): Promise<LocalHumanAuthStackStartResult> {
    if (this.relay && this.resolvedRelayBaseUrl) {
      return {
        relayBaseUrl: this.resolvedRelayBaseUrl,
        publicBaseUrl: this.resolvedPublicBaseUrl || this.resolvedRelayBaseUrl,
      };
    }

    try {
      const managerAgent = findManagerAgentByConfigPath(this.config.configPath);
      if (managerAgent) {
        return await this.startManagedRelay(managerAgent.id);
      }
      return await this.startStandaloneRelay();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.registeredAgentId) {
      const agentId = this.registeredAgentId;
      this.registeredAgentId = null;
      try {
        await fetch(`${this.managerRelayHubBaseUrl()}/v1/relay-hub/agents/${encodeURIComponent(agentId)}`, {
          method: "DELETE",
        });
      } catch {
        // ignore best-effort unregister failures
      }
    }

    this.resolvedRelayBaseUrl = "";
    this.resolvedPublicBaseUrl = "";

    const ngrok = this.ngrok;
    this.ngrok = null;
    if (ngrok) {
      await ngrok.stop();
    }

    const relay = this.relay;
    this.relay = null;
    if (relay) {
      await relay.stop();
    }
  }

  async createSignedScreenshotUrl(options?: { ttlSec?: number }): Promise<LocalHumanAuthSignedScreenshot> {
    await this.start();
    if (!this.relay) {
      throw new Error("Local human-auth relay is not running.");
    }
    return this.relay.createSignedScreenshotUrl({
      publicBaseUrl: this.resolvedPublicBaseUrl || this.resolvedRelayBaseUrl || this.requireRelayAddress(),
      ttlSec: options?.ttlSec,
    });
  }

  private async startManagedRelay(agentId: string): Promise<LocalHumanAuthStackStartResult> {
    await this.startPrivateRelay({ host: "127.0.0.1", port: 0 });
    const directBaseUrl = this.requireRelayAddress();

    try {
      const registered = await this.registerWithRelayHub(agentId, directBaseUrl);
      this.registeredAgentId = agentId;
      this.resolvedRelayBaseUrl = registered.relayBaseUrl;
      this.resolvedPublicBaseUrl = registered.publicBaseUrl || registered.relayBaseUrl;
      this.log(
        `[OpenPocket][human-auth][info] relay hub registered agent=${agentId} relay=${this.resolvedRelayBaseUrl} public=${this.resolvedPublicBaseUrl}`,
      );
      return {
        relayBaseUrl: this.resolvedRelayBaseUrl,
        publicBaseUrl: this.resolvedPublicBaseUrl,
      };
    } catch (error) {
      this.resolvedRelayBaseUrl = directBaseUrl;
      this.resolvedPublicBaseUrl = directBaseUrl;
      this.log(
        `[OpenPocket][human-auth][warn] relay hub unavailable for agent=${agentId}; using direct local relay ${directBaseUrl}; error=${(error as Error).message}`,
      );
      return {
        relayBaseUrl: directBaseUrl,
        publicBaseUrl: directBaseUrl,
      };
    }
  }

  private async startStandaloneRelay(): Promise<LocalHumanAuthStackStartResult> {
    await this.startPrivateRelay({
      host: this.config.humanAuth.localRelayHost,
      port: this.config.humanAuth.localRelayPort,
    });
    const relayBaseUrl = this.requireRelayAddress();
    this.log(`[OpenPocket][human-auth][info] local relay started at ${relayBaseUrl}`);

    let publicBaseUrl = stripTrailingSlash(this.config.humanAuth.publicBaseUrl);
    const tunnelProvider = this.config.humanAuth.tunnel.provider;
    const ngrokEnabled = tunnelProvider === "ngrok" && this.config.humanAuth.tunnel.ngrok.enabled;
    if (ngrokEnabled) {
      this.ngrok = new NgrokTunnel(this.config.humanAuth.tunnel.ngrok, relayBaseUrl, this.log);
      publicBaseUrl = await this.ngrok.start();
      this.log(`[OpenPocket][human-auth][info] ngrok tunnel url=${publicBaseUrl}`);
    }

    if (!publicBaseUrl) {
      publicBaseUrl = relayBaseUrl;
    }

    this.resolvedRelayBaseUrl = relayBaseUrl;
    this.resolvedPublicBaseUrl = publicBaseUrl;
    return {
      relayBaseUrl,
      publicBaseUrl,
    };
  }

  private async startPrivateRelay(options: { host: string; port: number }): Promise<void> {
    if (this.relay) {
      return;
    }
    this.relay = new HumanAuthRelayServer({
      host: options.host,
      port: options.port,
      publicBaseUrl: "",
      apiKey: this.config.humanAuth.apiKey,
      apiKeyEnv: this.config.humanAuth.apiKeyEnv,
      stateFile: this.config.humanAuth.localRelayStateFile,
      takeoverRuntime: this.options.takeoverRuntime ?? new LocalHumanAuthTakeoverRuntime(this.config),
      logger: this.log,
    });
    await this.relay.start();
  }

  private requireRelayAddress(): string {
    const address = this.relay?.address || "";
    if (!address) {
      throw new Error("Failed to obtain local human-auth relay address.");
    }
    return address;
  }

  private managerRelayHubBaseUrl(): string {
    const ports = loadManagerPorts();
    return `http://127.0.0.1:${ports.relayHubPort}`;
  }

  private async registerWithRelayHub(agentId: string, baseUrl: string): Promise<HubRegistrationResponse> {
    const response = await fetch(
      `${this.managerRelayHubBaseUrl()}/v1/relay-hub/agents/${encodeURIComponent(agentId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`hub registration failed ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as Partial<HubRegistrationResponse> & { ok?: boolean };
    if (!payload.relayBaseUrl || !payload.publicBaseUrl) {
      throw new Error("hub registration response missing relay/public base URLs.");
    }
    return {
      relayBaseUrl: stripTrailingSlash(payload.relayBaseUrl),
      publicBaseUrl: stripTrailingSlash(payload.publicBaseUrl),
    };
  }
}
