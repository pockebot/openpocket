import type { OpenPocketConfig } from "../types.js";
import { HumanAuthRelayServer } from "./relay-server.js";
import { NgrokTunnel } from "./ngrok-tunnel.js";
import { LocalHumanAuthTakeoverRuntime } from "./takeover-runtime.js";

export interface LocalHumanAuthStackStartResult {
  relayBaseUrl: string;
  publicBaseUrl: string;
}

export class LocalHumanAuthStack {
  private readonly config: OpenPocketConfig;
  private readonly log: (line: string) => void;
  private relay: HumanAuthRelayServer | null = null;
  private ngrok: NgrokTunnel | null = null;

  constructor(config: OpenPocketConfig, log?: (line: string) => void) {
    this.config = config;
    this.log =
      log ??
      ((line: string) => {
        // eslint-disable-next-line no-console
        console.log(line);
      });
  }

  async start(): Promise<LocalHumanAuthStackStartResult> {
    if (this.relay) {
      const address = this.relay.address;
      return {
        relayBaseUrl: address,
        publicBaseUrl: this.config.humanAuth.publicBaseUrl || address,
      };
    }

    try {
      this.relay = new HumanAuthRelayServer({
        host: this.config.humanAuth.localRelayHost,
        port: this.config.humanAuth.localRelayPort,
        publicBaseUrl: this.config.humanAuth.publicBaseUrl,
        apiKey: this.config.humanAuth.apiKey,
        apiKeyEnv: this.config.humanAuth.apiKeyEnv,
        stateFile: this.config.humanAuth.localRelayStateFile,
        takeoverRuntime: new LocalHumanAuthTakeoverRuntime(this.config),
        logger: this.log,
      });
      await this.relay.start();

      const relayBaseUrl = this.relay.address;
      if (!relayBaseUrl) {
        throw new Error("Failed to obtain local human-auth relay address.");
      }
      this.log(`[OpenPocket][human-auth][info] local relay started at ${relayBaseUrl}`);

      let publicBaseUrl = this.config.humanAuth.publicBaseUrl.trim().replace(/\/+$/, "");
      const tunnelProvider = this.config.humanAuth.tunnel.provider;
      const ngrokEnabled =
        tunnelProvider === "ngrok" && this.config.humanAuth.tunnel.ngrok.enabled;
      if (ngrokEnabled) {
        this.ngrok = new NgrokTunnel(this.config.humanAuth.tunnel.ngrok, relayBaseUrl, this.log);
        publicBaseUrl = await this.ngrok.start();
        this.log(`[OpenPocket][human-auth][info] ngrok tunnel url=${publicBaseUrl}`);
      }

      if (!publicBaseUrl) {
        publicBaseUrl = relayBaseUrl;
      }

      return {
        relayBaseUrl,
        publicBaseUrl,
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
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
}
