import path from "node:path";

import type { OpenPocketConfig } from "../types.js";
import { DefaultChannelRouter } from "../channel/router.js";
import { DefaultSessionKeyResolver } from "../channel/session-keys.js";
import { FilePairingStore } from "../channel/pairing.js";
import { TelegramAdapter } from "../channel/telegram/adapter.js";
import { DiscordAdapter } from "../channel/discord/adapter.js";
import { WhatsAppAdapter } from "../channel/whatsapp/adapter.js";
import { IMessageAdapter } from "../channel/imessage/adapter.js";
import { GatewayCore } from "./gateway-core.js";

export interface GatewayFactoryResult {
  core: GatewayCore;
  router: DefaultChannelRouter;
}

export interface GatewayFactoryOptions {
  logger?: (line: string) => void;
  onLogLine?: (line: string) => void;
  typingIntervalMs?: number;
}

/**
 * Create a fully wired GatewayCore with channel adapters based on config.
 *
 * Supports Telegram and Discord (auto-detected from config blocks).
 * Future channels (WhatsApp, etc.) will be added here as adapters
 * are implemented and their config blocks are detected.
 */
export function createGateway(
  config: OpenPocketConfig,
  options?: GatewayFactoryOptions,
): GatewayFactoryResult {
  const combinedLogger = (line: string) => {
    options?.logger?.(line);
    options?.onLogLine?.(line);
  };
  const log = options?.logger ? combinedLogger : undefined;

  const router = new DefaultChannelRouter({ log });
  const sessionKeyResolver = new DefaultSessionKeyResolver();
  const pairingStore = new FilePairingStore({
    stateDir: config.pairing?.stateDir ?? path.join(config.stateDir, "pairing"),
    codeLength: config.pairing?.codeLength,
    expiresAfterSec: config.pairing?.expiresAfterSec,
    maxPendingPerChannel: config.pairing?.maxPendingPerChannel,
  });

  if (isTelegramConfigured(config)) {
    const tgConfig = config.channels?.telegram ?? {};
    const telegramAdapter = new TelegramAdapter(config, tgConfig, {
      logger: log,
      typingIntervalMs: options?.typingIntervalMs,
    });
    router.register(telegramAdapter);
  }

  if (isDiscordConfigured(config)) {
    const discordConfig = config.channels!.discord!;
    const discordAdapter = new DiscordAdapter(config, discordConfig, {
      logger: log,
    });
    router.register(discordAdapter);
  }

  if (isWhatsAppConfigured(config)) {
    const waConfig = config.channels!.whatsapp!;
    const whatsappAdapter = new WhatsAppAdapter(config, waConfig, {
      logger: log,
    });
    router.register(whatsappAdapter);
  }

  if (isIMessageConfigured(config)) {
    const imConfig = config.channels!.imessage!;
    const imAdapter = new IMessageAdapter(config, imConfig, {
      logger: log,
    });
    router.register(imAdapter);
  }

  const core = new GatewayCore(config, router, sessionKeyResolver, pairingStore, {
    logger: log,
  });

  return { core, router };
}

function isTelegramConfigured(config: OpenPocketConfig): boolean {
  const tg = config.channels?.telegram;
  if (!tg) return false;
  if (tg.enabled === false) return false;

  const envName = tg.botTokenEnv || "TELEGRAM_BOT_TOKEN";
  const token =
    (tg.botToken ?? "").trim() ||
    (process.env[envName]?.trim()) ||
    "";
  return token.length > 0;
}

function isDiscordConfigured(config: OpenPocketConfig): boolean {
  const dc = config.channels?.discord;
  if (!dc) return false;
  if (dc.enabled === false) return false;

  const token = dc.token?.trim() || (dc.tokenEnv ? process.env[dc.tokenEnv]?.trim() : "") || "";
  return token.length > 0;
}

function isWhatsAppConfigured(config: OpenPocketConfig): boolean {
  const wa = config.channels?.whatsapp;
  if (!wa) return false;
  if (wa.enabled === false) return false;
  return true;
}

function isIMessageConfigured(config: OpenPocketConfig): boolean {
  const im = config.channels?.imessage;
  if (!im) return false;
  if (im.enabled === false) return false;
  return process.platform === "darwin";
}
