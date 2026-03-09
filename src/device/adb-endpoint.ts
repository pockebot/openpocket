export function normalizeAdbEndpoint(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes(":")) {
    return trimmed;
  }
  return `${trimmed}:5555`;
}

export function normalizeOptionalAdbEndpoint(raw: string | null | undefined): string | null {
  const normalized = normalizeAdbEndpoint(String(raw ?? ""));
  return normalized || null;
}
