import { nowIso } from "../utils/paths.js";

export type PhoneUseCapability = "camera" | "microphone" | "location" | "photos" | "payment";
export type PhoneUseCapabilityPhase = "requested" | "active";
export type CapabilityProbeSource =
  | "appops"
  | "camera_service"
  | "activity_log"
  | "permission_dialog"
  | "window_secure"
  | "ui_tree";

export type PaymentFieldSemantic =
  | "card_number"
  | "expiry"
  | "cvc"
  | "cardholder_name"
  | "billing_name"
  | "postal_code"
  | "billing_address_line1"
  | "billing_address_line2"
  | "billing_city"
  | "billing_state"
  | "billing_country"
  | "billing_email"
  | "billing_phone"
  | "unknown";

export type PaymentFieldInputType = "text" | "email" | "card-number" | "expiry" | "cvc";

export interface PaymentFieldCandidate {
  semantic: PaymentFieldSemantic;
  label: string;
  resourceIdHint: string;
  artifactKey: string;
  required: boolean;
  confidence: number;
  inputType: PaymentFieldInputType;
}

export interface PaymentProbeContext {
  secureWindow: boolean;
  secureEvidence: string;
  fieldCandidates: PaymentFieldCandidate[];
}

export interface CapabilityProbeEvent {
  capability: PhoneUseCapability;
  phase: PhoneUseCapabilityPhase;
  packageName: string;
  source: CapabilityProbeSource;
  observedAt: string;
  confidence: number;
  evidence: string;
  paymentContext?: PaymentProbeContext;
}

export interface CapabilityProbePollParams {
  deviceId: string;
  foregroundPackage: string;
  candidatePackages?: string[];
}

export interface CapabilityProbeAdbRunner {
  run(deviceId: string, args: string[], timeoutMs?: number): string;
}

export interface PhoneUseCapabilityProbeOptions {
  adbRunner: CapabilityProbeAdbRunner;
  nowMs?: () => number;
  nowIso?: () => string;
  recentWindowMs?: number;
  dedupeWindowMs?: number;
  minPollIntervalMs?: number;
  logcatLookbackSec?: number;
}

type AppOpsSignalParseParams = {
  packageName: string;
  observedAt: string;
  recentWindowMs: number;
};

type ActivityLogParseParams = {
  fallbackPackage: string;
  observedAt: string;
};

type WindowSecureParseParams = {
  foregroundPackage: string;
  candidatePackages: string[];
  observedAt: string;
};

type ParsedWindowSecureSignal = {
  packageName: string;
  confidence: number;
  evidence: string;
};

const PACKAGE_RE = /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\b/g;
const APP_OPS_TARGETS = new Set([
  "CAMERA",
  "RECORD_AUDIO",
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "READ_MEDIA_IMAGES",
  "READ_EXTERNAL_STORAGE",
]);

const CAMERA_ACTIONS = new Set([
  "android.media.action.IMAGE_CAPTURE",
  "android.media.action.VIDEO_CAPTURE",
]);
const MIC_ACTIONS = new Set([
  "android.provider.MediaStore.RECORD_SOUND",
  "android.speech.action.RECOGNIZE_SPEECH",
]);
const PHOTO_ACTIONS = new Set([
  "android.intent.action.GET_CONTENT",
  "android.intent.action.OPEN_DOCUMENT",
  "android.provider.action.PICK_IMAGES",
  "android.intent.action.PICK",
]);

const WINDOW_SECURE_RE = /FLAG_SECURE|mSecure\s*=\s*true|secure\s*=\s*true|isSecure\s*=\s*true/i;
const PAYMENT_CONTEXT_HINT_RE = /\b(pay|payment|checkout|card|billing|cvv|cvc|expiry|expiration|postal|zip)\b/i;

const PAYMENT_SEMANTIC_PRIORITY: Record<PaymentFieldSemantic, number> = {
  card_number: 0,
  expiry: 1,
  cvc: 2,
  cardholder_name: 3,
  billing_name: 4,
  billing_address_line1: 5,
  billing_address_line2: 6,
  billing_city: 7,
  billing_state: 8,
  postal_code: 9,
  billing_country: 10,
  billing_email: 11,
  billing_phone: 12,
  unknown: 13,
};

function extractPackages(text: string): string[] {
  const out = new Set<string>();
  let match = PACKAGE_RE.exec(text);
  while (match) {
    out.add(match[1]);
    match = PACKAGE_RE.exec(text);
  }
  PACKAGE_RE.lastIndex = 0;
  return [...out];
}

export function parseAgoDurationMs(rawValue: string): number | null {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw
    .replace(/^\+/, "")
    .replace(/\s+ago$/i, "")
    .replace(/\s+/g, "");
  if (!normalized) {
    return null;
  }

  const tokenRe = /(\d+)(ms|d|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  let matched = false;
  let token = tokenRe.exec(normalized);
  while (token) {
    matched = true;
    consumed += token[0].length;
    const value = Number(token[1]);
    const unit = token[2];
    if (!Number.isFinite(value)) {
      return null;
    }
    switch (unit) {
      case "d":
        total += value * 24 * 60 * 60 * 1000;
        break;
      case "h":
        total += value * 60 * 60 * 1000;
        break;
      case "m":
        total += value * 60 * 1000;
        break;
      case "s":
        total += value * 1000;
        break;
      case "ms":
        total += value;
        break;
      default:
        return null;
    }
    token = tokenRe.exec(normalized);
  }
  if (!matched || consumed !== normalized.length) {
    return null;
  }
  return total;
}

function extractAgoFromTail(tail: string, key: "time" | "rejectTime"): number | null {
  const match = tail.match(new RegExp(`${key}=([^;]+)`));
  if (!match?.[1]) {
    return null;
  }
  return parseAgoDurationMs(match[1]);
}

function appOpsToCapability(op: string): PhoneUseCapability | null {
  switch (op) {
    case "CAMERA":
      return "camera";
    case "RECORD_AUDIO":
      return "microphone";
    case "ACCESS_FINE_LOCATION":
    case "ACCESS_COARSE_LOCATION":
      return "location";
    case "READ_MEDIA_IMAGES":
    case "READ_EXTERNAL_STORAGE":
      return "photos";
    default:
      return null;
  }
}

export function parseAppOpsCapabilitySignals(
  appOpsOutput: string,
  params: AppOpsSignalParseParams,
): CapabilityProbeEvent[] {
  const lines = appOpsOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: CapabilityProbeEvent[] = [];

  for (const line of lines) {
    const normalizedLine = line.replace(/^Uid mode:\s*/i, "");
    const parsed = normalizedLine.match(/^([A-Z_]+)\s*:\s*([a-z_]+)(.*)$/i);
    if (!parsed) {
      continue;
    }
    const op = String(parsed[1] || "").toUpperCase();
    if (!APP_OPS_TARGETS.has(op)) {
      continue;
    }
    const capability = appOpsToCapability(op);
    if (!capability) {
      continue;
    }
    const mode = String(parsed[2] || "").toLowerCase();
    const tail = String(parsed[3] || "");

    const accessAgoMs = extractAgoFromTail(tail, "time");
    const rejectAgoMs = extractAgoFromTail(tail, "rejectTime");

    if (
      accessAgoMs !== null
      && accessAgoMs <= params.recentWindowMs
      && (mode === "allow" || mode === "foreground")
    ) {
      out.push({
        capability,
        phase: "active",
        packageName: params.packageName,
        source: "appops",
        observedAt: params.observedAt,
        confidence: 0.93,
        evidence: line.slice(0, 220),
      });
      continue;
    }

    if (
      rejectAgoMs !== null
      && rejectAgoMs <= params.recentWindowMs
      && (mode === "ignore" || mode === "deny" || mode === "default")
    ) {
      out.push({
        capability,
        phase: "requested",
        packageName: params.packageName,
        source: "appops",
        observedAt: params.observedAt,
        confidence: 0.7,
        evidence: line.slice(0, 220),
      });
    }
  }

  return out;
}

export function parseCameraDumpsysCapabilitySignals(
  cameraDumpsysOutput: string,
  params: { foregroundPackage: string; observedAt: string },
): CapabilityProbeEvent[] {
  const sectionMatch = cameraDumpsysOutput.match(
    /Active Camera Clients:\s*([\s\S]*?)(?:\n\s*\n|$)/i,
  );
  const section = sectionMatch?.[1] ?? "";
  if (!section || /\[\s*\]/.test(section)) {
    return [];
  }
  const packageNames = extractPackages(section);
  if (packageNames.length === 0) {
    return [];
  }
  return packageNames.map((packageName) => ({
    capability: "camera",
    phase: "active",
    packageName,
    source: "camera_service",
    observedAt: params.observedAt,
    confidence: packageName === params.foregroundPackage ? 0.98 : 0.92,
    evidence: section.trim().slice(0, 220),
  }));
}

function looksLikePhotoIntent(action: string, message: string): boolean {
  if (action === "android.provider.action.PICK_IMAGES") {
    return true;
  }
  if (!PHOTO_ACTIONS.has(action)) {
    return false;
  }
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("typ=image/")
    || lowerMessage.includes("typ=vnd.android.cursor.dir/image")
    || lowerMessage.includes("pick_images")
    || lowerMessage.includes("image/*")
  );
}

function resolveCallerPackage(message: string, fallbackPackage: string): string {
  const fromUidMatch = message.match(/from uid \d+ \(([^)]+)\)/i);
  if (fromUidMatch?.[1]) {
    return fromUidMatch[1];
  }
  const cmpMatch = message.match(/\bcmp=([a-zA-Z0-9._]+)\//);
  if (cmpMatch?.[1]) {
    return cmpMatch[1];
  }
  return fallbackPackage;
}

export function parseActivityLogCapabilitySignals(
  activityLogOutput: string,
  params: ActivityLogParseParams,
): CapabilityProbeEvent[] {
  const lines = activityLogOutput.split(/\r?\n/);
  const out: CapabilityProbeEvent[] = [];

  for (const rawLine of lines) {
    if (!rawLine.includes("ActivityTaskManager: START")) {
      continue;
    }
    const messageMatch = rawLine.match(/ActivityTaskManager:\s+(.*)$/);
    if (!messageMatch?.[1]) {
      continue;
    }
    const message = messageMatch[1];
    const actionMatch = message.match(/\bact=([^\s}]+)/);
    if (!actionMatch?.[1]) {
      continue;
    }
    const action = actionMatch[1];
    const callerPackage = resolveCallerPackage(message, params.fallbackPackage);

    if (CAMERA_ACTIONS.has(action)) {
      out.push({
        capability: "camera",
        phase: "requested",
        packageName: callerPackage,
        source: "activity_log",
        observedAt: params.observedAt,
        confidence: 0.89,
        evidence: message.slice(0, 220),
      });
      continue;
    }

    if (MIC_ACTIONS.has(action)) {
      out.push({
        capability: "microphone",
        phase: "requested",
        packageName: callerPackage,
        source: "activity_log",
        observedAt: params.observedAt,
        confidence: 0.89,
        evidence: message.slice(0, 220),
      });
      continue;
    }

    if (looksLikePhotoIntent(action, message)) {
      out.push({
        capability: "photos",
        phase: "requested",
        packageName: callerPackage,
        source: "activity_log",
        observedAt: params.observedAt,
        confidence: 0.87,
        evidence: message.slice(0, 220),
      });
    }
  }

  return out;
}

function isLikelyPackageName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(value);
}

function normalizeText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[_:/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseUiNodeAttributes(attributesRaw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const attrRe = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
  let match = attrRe.exec(attributesRaw);
  while (match) {
    const key = String(match[1] || "");
    const value = decodeXmlEntities(match[2] ?? "");
    out[key] = value;
    match = attrRe.exec(attributesRaw);
  }
  return out;
}

function parseBounds(boundsRaw: string): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null {
  const match = String(boundsRaw || "").trim().match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) {
    return null;
  }
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  if (![left, top, right, bottom].every((value) => Number.isFinite(value))) {
    return null;
  }
  if (right <= left || bottom <= top) {
    return null;
  }
  return { left, top, right, bottom };
}

function slugifyValue(value: string): string {
  const slug = normalizeText(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "na";
}

function toResourceIdHint(resourceId: string): string {
  const raw = String(resourceId || "").trim();
  if (!raw) {
    return "";
  }
  const tail = raw.includes("/") ? raw.split("/").pop() || raw : raw;
  return slugifyValue(tail);
}

function fieldLabelForSemantic(semantic: PaymentFieldSemantic, fallbackLabel: string): string {
  switch (semantic) {
    case "card_number":
      return "Card Number";
    case "expiry":
      return "Expiration (MM/YY)";
    case "cvc":
      return "Security Code (CVC/CVV)";
    case "cardholder_name":
      return "Cardholder Name";
    case "billing_name":
      return "Billing Name";
    case "postal_code":
      return "ZIP / Postal Code";
    case "billing_address_line1":
      return "Billing Address Line 1";
    case "billing_address_line2":
      return "Billing Address Line 2";
    case "billing_city":
      return "Billing City";
    case "billing_state":
      return "Billing State / Province";
    case "billing_country":
      return "Billing Country";
    case "billing_email":
      return "Billing Email";
    case "billing_phone":
      return "Billing Phone";
    default: {
      const trimmed = String(fallbackLabel || "").trim();
      return trimmed || "Payment Field";
    }
  }
}

function fieldInputTypeForSemantic(semantic: PaymentFieldSemantic): PaymentFieldInputType {
  switch (semantic) {
    case "card_number":
      return "card-number";
    case "expiry":
      return "expiry";
    case "cvc":
      return "cvc";
    case "billing_email":
      return "email";
    default:
      return "text";
  }
}

function fieldRequiredBySemantic(semantic: PaymentFieldSemantic): boolean {
  return semantic === "card_number" || semantic === "expiry" || semantic === "cvc";
}

function semanticConfidence(
  semantic: PaymentFieldSemantic,
  combinedText: string,
  resourceId: string,
): number {
  if (semantic === "unknown") {
    return 0.46;
  }
  let score = 0.62;
  if (PAYMENT_CONTEXT_HINT_RE.test(combinedText)) {
    score += 0.08;
  }
  const normalizedResource = normalizeText(resourceId);
  if (normalizedResource) {
    const semanticToken = semantic.replace(/_/g, " ");
    if (normalizedResource.includes(semanticToken)) {
      score += 0.1;
    }
  }
  if (semantic === "card_number" || semantic === "expiry" || semantic === "cvc") {
    score += 0.14;
  }
  return Math.min(0.99, score);
}

function tokenizeForMatch(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function inferSemanticFromCombinedText(combinedText: string): PaymentFieldSemantic {
  const normalized = normalizeText(combinedText);
  if (!normalized) {
    return "unknown";
  }
  if (
    /\b(card number|card no|cc number|credit card number|pan|number on card)\b/.test(normalized)
    || /\bcc(number|num)\b/.test(normalized)
  ) {
    return "card_number";
  }
  if (/\b(expiry|expiration|expire|valid thru|valid through|exp date|mm yy|mm yy)\b/.test(normalized)) {
    return "expiry";
  }
  if (/\b(cvc|cvv|csc|security code|card verification)\b/.test(normalized)) {
    return "cvc";
  }
  if (/\b(cardholder|name on card|card holder)\b/.test(normalized)) {
    return "cardholder_name";
  }
  if (/\b(email|e mail)\b/.test(normalized)) {
    return "billing_email";
  }
  if (/\b(phone|mobile|telephone|tel)\b/.test(normalized)) {
    return "billing_phone";
  }
  if (/\b(zip|postal|postcode|post code)\b/.test(normalized)) {
    return "postal_code";
  }
  if (/\b(address line 2|line2|line 2|apt|apartment|suite|unit)\b/.test(normalized)) {
    return "billing_address_line2";
  }
  if (/\b(address line 1|line1|line 1|street address|billing address|address)\b/.test(normalized)) {
    return "billing_address_line1";
  }
  if (/\b(city|town)\b/.test(normalized)) {
    return "billing_city";
  }
  if (/\b(state|province|region|county)\b/.test(normalized)) {
    return "billing_state";
  }
  if (/\bcountry\b/.test(normalized)) {
    return "billing_country";
  }
  if (/\b(full name|name)\b/.test(normalized)) {
    return "billing_name";
  }
  return "unknown";
}

export function inferPaymentFieldSemantic(params: {
  label?: string;
  hint?: string;
  resourceId?: string;
  contentDesc?: string;
  className?: string;
}): { semantic: PaymentFieldSemantic; confidence: number } {
  const label = String(params.label || "");
  const hint = String(params.hint || "");
  const resourceId = String(params.resourceId || "");
  const contentDesc = String(params.contentDesc || "");
  const className = String(params.className || "");
  const combined = `${label} ${hint} ${resourceId} ${contentDesc} ${className}`;
  const semantic = inferSemanticFromCombinedText(combined);
  return {
    semantic,
    confidence: semanticConfidence(semantic, combined, resourceId),
  };
}

export function buildPaymentArtifactKey(
  semantic: PaymentFieldSemantic,
  resourceIdHint: string,
  index = 0,
): string {
  const safeSemantic = String(semantic || "unknown");
  const safeHint = slugifyValue(resourceIdHint || "na");
  const safeIndex = Number.isFinite(index) && index > 0 ? Math.round(index) : 0;
  return `payment_field__${safeSemantic}__${safeHint}__${safeIndex}`;
}

export function parsePaymentArtifactKey(rawKey: string): {
  semantic: PaymentFieldSemantic | null;
  resourceIdHint: string;
  index: number;
} | null {
  const raw = String(rawKey || "").trim();
  const match = raw.match(/^payment_field__([a-z0-9_]+)__([a-z0-9_]+)__([0-9]+)$/i);
  if (!match) {
    return null;
  }
  const semanticRaw = String(match[1] || "").toLowerCase() as PaymentFieldSemantic;
  const semantic: PaymentFieldSemantic = semanticRaw in PAYMENT_SEMANTIC_PRIORITY
    ? semanticRaw
    : "unknown";
  const resourceIdHint = String(match[2] || "").toLowerCase();
  const index = Number(match[3] || "0");
  return {
    semantic,
    resourceIdHint: resourceIdHint === "na" ? "" : resourceIdHint,
    index: Number.isFinite(index) ? index : 0,
  };
}

export function parsePaymentUiTreeFieldCandidates(uiDumpXml: string): PaymentFieldCandidate[] {
  const xml = String(uiDumpXml || "");
  if (!xml || !xml.includes("<node")) {
    return [];
  }
  const nodeRe = /<node\s+([^>]*?)\/>/g;
  const candidates: Array<PaymentFieldCandidate & { top: number; left: number }> = [];
  const seenBySemantic = new Map<PaymentFieldSemantic, number>();
  let unknownCount = 0;

  let match = nodeRe.exec(xml);
  while (match) {
    const attrs = parseUiNodeAttributes(match[1] ?? "");
    const className = String(attrs.class ?? "");
    const classNormalized = normalizeText(className);
    const isInputClass =
      classNormalized.includes("edittext")
      || classNormalized.includes("autocompletetextview")
      || classNormalized.includes("textinput")
      || classNormalized.includes("textfield");
    if (!isInputClass) {
      match = nodeRe.exec(xml);
      continue;
    }
    const enabled = String(attrs.enabled ?? "").toLowerCase() !== "false";
    if (!enabled) {
      match = nodeRe.exec(xml);
      continue;
    }
    const bounds = parseBounds(String(attrs.bounds ?? ""));
    if (!bounds) {
      match = nodeRe.exec(xml);
      continue;
    }
    const resourceId = String(attrs["resource-id"] ?? "");
    const hint = String(attrs.hint ?? "");
    const text = String(attrs.text ?? "");
    const contentDesc = String(attrs["content-desc"] ?? "");
    const inferred = inferPaymentFieldSemantic({
      label: text,
      hint,
      resourceId,
      contentDesc,
      className,
    });
    const semantic = inferred.semantic;
    const resourceIdHint = toResourceIdHint(resourceId);
    const fallbackLabel = text || hint || contentDesc || resourceIdHint || "Payment Field";
    const label = fieldLabelForSemantic(semantic, fallbackLabel);

    if (semantic !== "unknown" && seenBySemantic.has(semantic)) {
      const existingIndex = seenBySemantic.get(semantic) as number;
      const existing = candidates[existingIndex];
      if (inferred.confidence > existing.confidence + 0.05) {
        const artifactKey = buildPaymentArtifactKey(semantic, resourceIdHint || existing.resourceIdHint, 0);
        candidates[existingIndex] = {
          ...existing,
          label,
          resourceIdHint: resourceIdHint || existing.resourceIdHint,
          confidence: inferred.confidence,
          artifactKey,
          inputType: fieldInputTypeForSemantic(semantic),
          required: fieldRequiredBySemantic(semantic),
          top: bounds.top,
          left: bounds.left,
        };
      }
      match = nodeRe.exec(xml);
      continue;
    }

    let index = 0;
    if (semantic === "unknown") {
      if (unknownCount >= 3) {
        match = nodeRe.exec(xml);
        continue;
      }
      index = unknownCount;
      unknownCount += 1;
    }

    const artifactKey = buildPaymentArtifactKey(semantic, resourceIdHint, index);
    const field: PaymentFieldCandidate & { top: number; left: number } = {
      semantic,
      label,
      resourceIdHint,
      artifactKey,
      required: fieldRequiredBySemantic(semantic),
      confidence: inferred.confidence,
      inputType: fieldInputTypeForSemantic(semantic),
      top: bounds.top,
      left: bounds.left,
    };
    const insertedIndex = candidates.push(field) - 1;
    if (semantic !== "unknown") {
      seenBySemantic.set(semantic, insertedIndex);
    }

    match = nodeRe.exec(xml);
  }

  return candidates
    .sort((a, b) => {
      const pa = PAYMENT_SEMANTIC_PRIORITY[a.semantic] ?? PAYMENT_SEMANTIC_PRIORITY.unknown;
      const pb = PAYMENT_SEMANTIC_PRIORITY[b.semantic] ?? PAYMENT_SEMANTIC_PRIORITY.unknown;
      if (pa !== pb) {
        return pa - pb;
      }
      if (a.top !== b.top) {
        return a.top - b.top;
      }
      return a.left - b.left;
    })
    .map(({ top, left, ...field }) => field);
}

function extractFocusedPackage(windowOutput: string): string {
  const focusedPatterns = [
    /mCurrentFocus=Window\{[^\n]*\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\//i,
    /mFocusedWindow=Window\{[^\n]*\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\//i,
    /mTopFullscreenOpaqueWindowState=Window\{[^\n]*\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\//i,
  ];
  for (const re of focusedPatterns) {
    const match = windowOutput.match(re);
    if (match?.[1] && isLikelyPackageName(match[1])) {
      return match[1];
    }
  }
  return "";
}

export function parseWindowSecurePaymentSignal(
  windowOutput: string,
  params: WindowSecureParseParams,
): ParsedWindowSecureSignal | null {
  const raw = String(windowOutput || "");
  if (!raw || !WINDOW_SECURE_RE.test(raw)) {
    return null;
  }
  const focused = extractFocusedPackage(raw) || String(params.foregroundPackage || "");
  const candidates = [
    focused,
    ...params.candidatePackages,
  ]
    .map((item) => String(item || "").trim())
    .filter((item, index, arr) => (
      isLikelyPackageName(item)
      && arr.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index
    ));
  if (candidates.length === 0) {
    return null;
  }

  let best: ParsedWindowSecureSignal | null = null;
  for (const packageName of candidates) {
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const packageWindowRe = new RegExp(`Window\\{[^\\n]*\\s${escaped}/[^\\n]*\\}`, "ig");
    let packageMatch = packageWindowRe.exec(raw);
    while (packageMatch) {
      const hitIndex = packageMatch.index;
      const start = Math.max(0, hitIndex - 900);
      const end = Math.min(raw.length, hitIndex + 1400);
      const snippet = raw.slice(start, end);
      if (!WINDOW_SECURE_RE.test(snippet)) {
        packageMatch = packageWindowRe.exec(raw);
        continue;
      }
      const confidence = packageName === focused ? 0.97 : 0.92;
      const evidence = snippet.replace(/\s+/g, " ").trim().slice(0, 260);
      if (!best || confidence > best.confidence) {
        best = { packageName, confidence, evidence };
      }
      packageMatch = packageWindowRe.exec(raw);
    }
  }
  return best;
}

export class PhoneUseCapabilityProbe {
  private readonly adbRunner: CapabilityProbeAdbRunner;
  private readonly nowMsFn: () => number;
  private readonly nowIsoFn: () => string;
  private readonly recentWindowMs: number;
  private readonly dedupeWindowMs: number;
  private readonly minPollIntervalMs: number;
  private readonly logcatLookbackSec: number;
  private lastPollAtMs = 0;
  private lastLogcatSinceEpochSec = 0;
  private readonly seenFingerprints = new Map<string, number>();

  constructor(options: PhoneUseCapabilityProbeOptions) {
    this.adbRunner = options.adbRunner;
    this.nowMsFn = options.nowMs ?? (() => Date.now());
    this.nowIsoFn = options.nowIso ?? (() => nowIso());
    this.recentWindowMs = Math.max(1000, Math.round(options.recentWindowMs ?? 12_000));
    this.dedupeWindowMs = Math.max(1000, Math.round(options.dedupeWindowMs ?? 10_000));
    this.minPollIntervalMs = Math.max(300, Math.round(options.minPollIntervalMs ?? 4_000));
    this.logcatLookbackSec = Math.max(1, Math.round(options.logcatLookbackSec ?? 10));
  }

  poll(params: CapabilityProbePollParams): CapabilityProbeEvent[] {
    const deviceId = String(params.deviceId || "").trim();
    const foregroundPackage = String(params.foregroundPackage || "").trim();
    const candidatePackages = Array.isArray(params.candidatePackages)
      ? params.candidatePackages
      : [];
    const appPackages = [
      foregroundPackage,
      ...candidatePackages.map((item) => String(item || "").trim()),
    ].filter((item, index, arr) => (
      isLikelyPackageName(item)
      && arr.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index
    ));
    if (!deviceId || appPackages.length === 0) {
      return [];
    }

    const nowMs = this.nowMsFn();
    if (nowMs - this.lastPollAtMs < this.minPollIntervalMs) {
      return [];
    }
    this.lastPollAtMs = nowMs;

    const observedAt = this.nowIsoFn();
    const events: CapabilityProbeEvent[] = [];

    for (const packageName of appPackages) {
      const appOpsOutput = this.safeRunAdb(deviceId, ["shell", "cmd", "appops", "get", packageName], 2800);
      if (!appOpsOutput) {
        continue;
      }
      events.push(
        ...parseAppOpsCapabilitySignals(appOpsOutput, {
          packageName,
          observedAt,
          recentWindowMs: this.recentWindowMs,
        }),
      );
    }

    const cameraOutput = this.safeRunAdb(deviceId, ["shell", "dumpsys", "media.camera"], 2800);
    if (cameraOutput) {
      events.push(
        ...parseCameraDumpsysCapabilitySignals(cameraOutput, {
          foregroundPackage: appPackages[0] ?? foregroundPackage,
          observedAt,
        }),
      );
    }

    const nowEpochSec = Math.floor(nowMs / 1000);
    const sinceEpochSec = this.lastLogcatSinceEpochSec > 0
      ? this.lastLogcatSinceEpochSec
      : Math.max(0, nowEpochSec - this.logcatLookbackSec);
    const activityLog = this.safeRunAdb(
      deviceId,
      [
        "shell",
        "logcat",
        "-d",
        "-v",
        "epoch",
        "-T",
        String(sinceEpochSec),
        "ActivityTaskManager:I",
        "ActivityManager:I",
        "*:S",
      ],
      3200,
    );
    this.lastLogcatSinceEpochSec = nowEpochSec;
    if (activityLog) {
      events.push(
        ...parseActivityLogCapabilitySignals(activityLog, {
          fallbackPackage: appPackages[0] ?? foregroundPackage,
          observedAt,
        }),
      );
    }

    const windowOutput = this.safeRunAdb(
      deviceId,
      ["shell", "dumpsys", "window", "windows"],
      3200,
    );
    if (windowOutput) {
      const secureSignal = parseWindowSecurePaymentSignal(windowOutput, {
        foregroundPackage: appPackages[0] ?? foregroundPackage,
        candidatePackages: appPackages,
        observedAt,
      });
      if (secureSignal) {
        const uiTreeXml = this.captureUiTreeXml(deviceId);
        const fieldCandidates = parsePaymentUiTreeFieldCandidates(uiTreeXml);
        const hasPaymentWindowHints = PAYMENT_CONTEXT_HINT_RE.test(secureSignal.evidence);
        if (fieldCandidates.length > 0 || hasPaymentWindowHints) {
          events.push({
            capability: "payment",
            phase: "requested",
            packageName: secureSignal.packageName,
            source: "window_secure",
            observedAt,
            confidence: secureSignal.confidence,
            evidence: secureSignal.evidence,
            paymentContext: {
              secureWindow: true,
              secureEvidence: secureSignal.evidence,
              fieldCandidates,
            },
          });
        }
      }
    }

    return this.dedupe(events, nowMs);
  }

  private safeRunAdb(deviceId: string, args: string[], timeoutMs: number): string {
    try {
      return this.adbRunner.run(deviceId, args, timeoutMs);
    } catch {
      return "";
    }
  }

  private captureUiTreeXml(deviceId: string): string {
    const directDump = this.safeRunAdb(
      deviceId,
      ["exec-out", "uiautomator", "dump", "/dev/tty"],
      4200,
    );
    if (directDump.includes("<hierarchy")) {
      return directDump;
    }
    const dumpPath = `/sdcard/openpocket-probe-${this.nowMsFn()}.xml`;
    const dumped = this.safeRunAdb(
      deviceId,
      ["shell", "uiautomator", "dump", dumpPath],
      4200,
    );
    if (!dumped) {
      return "";
    }
    const catDump = this.safeRunAdb(
      deviceId,
      ["shell", "cat", dumpPath],
      4200,
    );
    this.safeRunAdb(
      deviceId,
      ["shell", "rm", "-f", dumpPath],
      1200,
    );
    if (catDump.includes("<hierarchy")) {
      return catDump;
    }
    return "";
  }

  private dedupe(events: CapabilityProbeEvent[], nowMs: number): CapabilityProbeEvent[] {
    const out: CapabilityProbeEvent[] = [];

    for (const [key, ts] of this.seenFingerprints.entries()) {
      if (nowMs - ts > this.dedupeWindowMs * 2) {
        this.seenFingerprints.delete(key);
      }
    }

    for (const event of events) {
      const fingerprint = [
        event.capability,
        event.phase,
        event.packageName,
        event.source,
      ].join("|");
      const last = this.seenFingerprints.get(fingerprint) ?? 0;
      if (nowMs - last < this.dedupeWindowMs) {
        continue;
      }
      this.seenFingerprints.set(fingerprint, nowMs);
      out.push(event);
    }
    return out;
  }
}
