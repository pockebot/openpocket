type GenericRecord = Record<string, unknown>;

const MAX_TEXT_CHARS = 1_600;
const MAX_BODY_CHARS = 360;

function isRecord(value: unknown): value is GenericRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string, limit = MAX_TEXT_CHARS): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function appendUnique(parts: string[], value: string): void {
  const normalized = normalizeText(value);
  if (!normalized) {
    return;
  }
  const key = normalized.toLowerCase();
  if (parts.some((part) => part.toLowerCase() === key)) {
    return;
  }
  parts.push(normalized);
}

function scalarToText(value: unknown): string {
  if (typeof value === "string") {
    return normalizeText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function summarizeStructuredValue(value: unknown): string {
  if (typeof value === "string") {
    return normalizeText(value, MAX_BODY_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value) || isRecord(value)) {
    try {
      return normalizeText(JSON.stringify(value), MAX_BODY_CHARS);
    } catch {
      return "";
    }
  }
  return "";
}

function tryParseJsonText(text: string): unknown {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function extractRawResponseSnippet(value: unknown): string {
  if (typeof value === "string") {
    const parsed = tryParseJsonText(value);
    if (parsed !== null) {
      return summarizeStructuredValue(parsed);
    }
    return "";
  }
  if (Array.isArray(value) || isRecord(value)) {
    return summarizeStructuredValue(value);
  }
  return "";
}

function extractRequestIdFromText(value: string): string {
  const match = String(value || "").match(/\brequest id[:\s]+([a-z0-9-]{8,})\b/i);
  return match?.[1]?.trim() ?? "";
}

function readFirstScalar(record: GenericRecord, keys: string[]): string {
  for (const key of keys) {
    const value = scalarToText(record[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function readHeaderValue(headers: unknown, names: string[]): string {
  if (!headers) {
    return "";
  }
  if (typeof (headers as { get?: unknown }).get === "function") {
    const getter = (headers as { get(name: string): unknown }).get.bind(headers);
    for (const name of names) {
      const value = scalarToText(getter(name));
      if (value) {
        return value;
      }
    }
  }
  if (headers instanceof Map) {
    for (const name of names) {
      const value = scalarToText(headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase()));
      if (value) {
        return value;
      }
    }
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) {
        continue;
      }
      const key = String(entry[0] ?? "").trim().toLowerCase();
      if (!key || !names.some((name) => name.toLowerCase() === key)) {
        continue;
      }
      const value = scalarToText(entry[1]);
      if (value) {
        return value;
      }
    }
  }
  if (isRecord(headers)) {
    const lowered = new Map<string, unknown>();
    for (const [key, value] of Object.entries(headers)) {
      lowered.set(key.toLowerCase(), value);
    }
    for (const name of names) {
      const value = scalarToText(lowered.get(name.toLowerCase()));
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function collectMessages(value: unknown, parts: string[], seen: WeakSet<object>, depth = 0): void {
  if (depth > 3 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    appendUnique(parts, value);
    const parsed = tryParseJsonText(value);
    if (parsed !== null) {
      collectMessages(parsed, parts, seen, depth + 1);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    appendUnique(parts, String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) {
      collectMessages(item, parts, seen, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (value instanceof Error) {
    appendUnique(parts, value.message);
  }

  if (!isRecord(value)) {
    return;
  }

  for (const key of ["message", "errorMessage", "detail", "details", "reason", "title", "description"]) {
    const text = scalarToText(value[key]);
    if (text) {
      appendUnique(parts, text);
    }
  }

  for (const key of ["error", "cause", "response", "body", "data"]) {
    if (key in value) {
      collectMessages(value[key], parts, seen, depth + 1);
    }
  }
}

function collectMetadata(value: unknown, parts: string[], seen: WeakSet<object>, depth = 0): void {
  if (typeof value === "string") {
    const parsed = tryParseJsonText(value);
    if (parsed !== null) {
      collectMetadata(parsed, parts, seen, depth + 1);
    }
    return;
  }
  if (depth > 3 || !isRecord(value)) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  const status = readFirstScalar(value, ["status", "statusCode"]);
  const code = readFirstScalar(value, ["code", "errorCode"]);
  const type = readFirstScalar(value, ["type", "errorType"]);
  const param = readFirstScalar(value, ["param"]);
  const requestId = readFirstScalar(value, ["requestId", "requestID", "request_id"]);
  const messageRequestId = readFirstScalar(value, ["message", "errorMessage"])
    ? extractRequestIdFromText(readFirstScalar(value, ["message", "errorMessage"]))
    : "";
  const headerRequestId = readHeaderValue(value.headers, [
    "x-request-id",
    "request-id",
    "anthropic-request-id",
    "openai-request-id",
    "x-amzn-requestid",
  ]);
  const responseRequestId = isRecord(value.response)
    ? readHeaderValue(value.response.headers, [
        "x-request-id",
        "request-id",
        "anthropic-request-id",
        "openai-request-id",
        "x-amzn-requestid",
      ])
    : "";

  if (status) {
    appendUnique(parts, `status=${status}`);
  }
  if (code) {
    appendUnique(parts, `code=${code}`);
  }
  if (type) {
    appendUnique(parts, `type=${type}`);
  }
  if (param) {
    appendUnique(parts, `param=${param}`);
  }
  if (requestId) {
    appendUnique(parts, `request_id=${requestId}`);
  }
  if (messageRequestId) {
    appendUnique(parts, `request_id=${messageRequestId}`);
  }
  if (headerRequestId) {
    appendUnique(parts, `request_id=${headerRequestId}`);
  }
  if (responseRequestId) {
    appendUnique(parts, `request_id=${responseRequestId}`);
  }

  for (const key of ["body", "data"]) {
    const snippet = summarizeStructuredValue(value[key]);
    if (snippet) {
      appendUnique(parts, `${key}=${snippet}`);
      break;
    }
  }

  for (const key of ["sequence_number", "sequenceNumber"]) {
    const sequenceNumber = scalarToText(value[key]);
    if (sequenceNumber) {
      appendUnique(parts, `sequence_number=${sequenceNumber}`);
      break;
    }
  }

  for (const key of ["message", "errorMessage", "error", "cause", "response"]) {
    if (key in value) {
      collectMetadata(value[key], parts, seen, depth + 1);
    }
  }
}

function collectRawResponses(value: unknown, parts: string[], seen: WeakSet<object>, depth = 0): void {
  if (depth > 3 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    const raw = extractRawResponseSnippet(value);
    if (raw) {
      appendUnique(parts, raw);
    }
    const parsed = tryParseJsonText(value);
    if (parsed !== null) {
      collectRawResponses(parsed, parts, seen, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (value instanceof Error) {
    collectRawResponses(value.message, parts, seen, depth + 1);
    if ("cause" in value) {
      collectRawResponses(value.cause, parts, seen, depth + 1);
    }
  }
  if (!isRecord(value)) {
    return;
  }

  for (const key of ["body", "data", "response", "error", "cause", "message"]) {
    if (!(key in value)) {
      continue;
    }
    const raw = extractRawResponseSnippet(value[key]);
    if (raw) {
      appendUnique(parts, raw);
    }
    collectRawResponses(value[key], parts, seen, depth + 1);
  }
}

export function formatDetailedError(error: unknown): string {
  if (error === null || error === undefined) {
    return "unknown error";
  }

  const messages: string[] = [];
  const messageSeen = new WeakSet<object>();
  collectMessages(error, messages, messageSeen);

  const metadata: string[] = [];
  const metadataSeen = new WeakSet<object>();
  collectMetadata(error, metadata, metadataSeen);

  const rawResponses: string[] = [];
  const rawSeen = new WeakSet<object>();
  collectRawResponses(error, rawResponses, rawSeen);
  if (rawResponses.length > 0) {
    metadata.push(`raw_response=${rawResponses[0]}`);
  }

  const baseMessage = messages[0]
    || scalarToText(error)
    || (error instanceof Error ? normalizeText(error.message) : "")
    || normalizeText(String(error));

  const extraMessages = messages.slice(1);
  const textParts = [baseMessage, ...extraMessages];
  const messageText = textParts.filter(Boolean).join(" | ").trim();
  if (!metadata.length) {
    return messageText || "unknown error";
  }
  return `${messageText || "unknown error"} [${metadata.join(", ")}]`;
}
