import type {
  GatewayLogLevel,
  GatewayLogModulesConfig,
  OpenPocketConfig,
} from "../types.js";

const LOG_LEVEL_RANK: Record<GatewayLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const PAYLOAD_KEYS = new Set([
  "text",
  "task",
  "reason",
  "detail",
  "message",
  "output",
  "raw",
  "reply",
  "json",
  "jsontext",
  "path",
  "session",
  "sessionpath",
  "screenshotpath",
]);

const ALWAYS_REDACT_KEYS = new Set([
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "authorization",
  "cookie",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authtoken",
]);

function normalizeModuleToken(token: string): keyof GatewayLogModulesConfig {
  const normalized = token.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "access") return "access";
  if (normalized === "task") return "task";
  if (normalized === "channel") return "channel";
  if (normalized === "cron") return "cron";
  if (normalized === "heartbeat") return "heartbeat";
  if (normalized === "humanauth") return "humanAuth";
  if (normalized === "chat") return "chat";
  return "core";
}

function inferModule(line: string): keyof GatewayLogModulesConfig {
  const tagged = line.match(/\[gateway-core\]\[([^\]]+)\]/i);
  if (tagged?.[1]) {
    return normalizeModuleToken(tagged[1]);
  }

  if (/\[(?:telegram|discord|whatsapp|imessage)-adapter\]/i.test(line)) {
    return "channel";
  }
  if (/\[channel-router\]/i.test(line)) {
    return "channel";
  }
  if (/\[heartbeat\]/i.test(line)) {
    return "heartbeat";
  }
  if (/\[cron\]/i.test(line)) {
    return "cron";
  }
  if (/\[human-auth\]/i.test(line)) {
    return "humanAuth";
  }
  if (/\[chat\]/i.test(line)) {
    return "chat";
  }
  return "core";
}

function inferLevel(line: string): GatewayLogLevel {
  const explicit = line.match(/\[(debug|info|warn|error)\]/i)?.[1]?.toLowerCase();
  if (explicit === "debug" || explicit === "info" || explicit === "warn" || explicit === "error") {
    return explicit;
  }

  if (/(^|\s)(error|failed|crash|exception)([=\s:]|$)/i.test(line)) {
    return "error";
  }
  if (/(^|\s)warn(ing)?([=\s:]|$)/i.test(line)) {
    return "warn";
  }
  return "info";
}

function shouldEmitLevel(minLevel: GatewayLogLevel, lineLevel: GatewayLogLevel): boolean {
  return LOG_LEVEL_RANK[lineLevel] <= LOG_LEVEL_RANK[minLevel];
}

function truncateValue(token: string, maxChars: number): string {
  if (token.length <= maxChars) {
    return token;
  }

  const quote = token[0];
  const hasQuotes = (quote === '"' || quote === "'") && token[token.length - 1] === quote;
  if (hasQuotes && maxChars > 6) {
    const body = token.slice(1, -1);
    const nextBody = body.slice(0, maxChars - 6).trimEnd();
    return `${quote}${nextBody}...${quote}`;
  }

  return `${token.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function sanitizePayloadTokens(line: string, includePayloads: boolean, maxPayloadChars: number): string {
  return line.replace(
    /\b([a-zA-Z][a-zA-Z0-9_]*)=("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)/g,
    (chunk, rawKey, rawValue) => {
      const key = String(rawKey || "").trim();
      const lowerKey = key.toLowerCase();
      if (ALWAYS_REDACT_KEYS.has(lowerKey)) {
        return `${key}=[redacted]`;
      }
      if (!PAYLOAD_KEYS.has(lowerKey)) {
        return chunk;
      }
      if (!includePayloads) {
        return `${key}=[hidden]`;
      }
      return `${key}=${truncateValue(String(rawValue), maxPayloadChars)}`;
    },
  );
}

function sanitizeLine(line: string, config: OpenPocketConfig): string {
  const includePayloads = Boolean(config.gatewayLogging.includePayloads);
  const maxPayloadChars = Math.max(40, Number(config.gatewayLogging.maxPayloadChars || 160));
  return sanitizePayloadTokens(line, includePayloads, maxPayloadChars);
}

export function createGatewayLogEmitter(
  config: OpenPocketConfig,
  sinks: Array<((line: string) => void) | undefined>,
): (line: string) => void {
  const sinkList = sinks.filter((sink): sink is (line: string) => void => typeof sink === "function");
  if (sinkList.length === 0) {
    sinkList.push((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });
  }

  return (line: string): void => {
    if (!line) {
      return;
    }

    const moduleKey = inferModule(line);
    if (!config.gatewayLogging.modules[moduleKey]) {
      return;
    }

    const lineLevel = inferLevel(line);
    if (!shouldEmitLevel(config.gatewayLogging.level, lineLevel)) {
      return;
    }

    const sanitized = sanitizeLine(line, config);
    for (const sink of sinkList) {
      sink(sanitized);
    }
  };
}
