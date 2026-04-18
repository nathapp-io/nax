import type { AgentError } from "../types";

/**
 * Parse structured adapter error output to identify agent error type.
 *
 * Classification intentionally uses machine-readable signals only:
 * - JSON fields (type/status/statusCode/code/acpxCode/detailCode)
 * - bracketed code suffixes (e.g. "[ACPX_RATE_LIMIT/TOO_MANY_REQUESTS]")
 * - explicit key=value codes (e.g. "statusCode=429")
 *
 * Free-text phrase inference is intentionally not supported.
 */
export function parseAgentError(stderr: string): AgentError {
  if (!stderr) {
    return { type: "unknown" };
  }

  const parsedJson = parseJsonObject(stderr);
  if (parsedJson) {
    const direct = classifyDirectType(parsedJson);
    if (direct) return direct;

    const structured = classifyFromCodeTokens(extractJsonCodeTokens(parsedJson), parsedJson);
    if (structured) return structured;
  }

  const bracketed = extractBracketedCodes(stderr);
  const fromBracketed = classifyFromCodeTokens(bracketed);
  if (fromBracketed) return fromBracketed;

  const fromKeyValue = classifyFromCodeTokens(extractKeyValueCodes(stderr));
  if (fromKeyValue) return fromKeyValue;

  return { type: "unknown" };
}

function parseJsonObject(stderr: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stderr);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function classifyDirectType(payload: Record<string, unknown>): AgentError | null {
  const type = payload.type;
  if (type !== "rate-limit" && type !== "auth" && type !== "timeout" && type !== "crash" && type !== "unknown") {
    return null;
  }

  const result: AgentError = { type };
  if (type === "rate-limit") {
    const retryAfterSeconds = toNumber(payload.retryAfterSeconds ?? payload.retry_after_seconds ?? payload.retryAfter);
    if (retryAfterSeconds !== undefined) {
      result.retryAfterSeconds = retryAfterSeconds;
    }
  }

  return result;
}

function extractJsonCodeTokens(payload: Record<string, unknown>): string[] {
  const tokens: string[] = [];
  const candidates = [
    payload.code,
    payload.status,
    payload.statusCode,
    payload.httpStatus,
    payload.errorCode,
    payload.acpxCode,
    payload.detailCode,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      tokens.push(String(candidate));
    } else if (typeof candidate === "string" && candidate.trim()) {
      tokens.push(candidate.trim());
    }
  }

  return tokens;
}

function extractBracketedCodes(stderr: string): string[] {
  const tokens: string[] = [];
  const matches = stderr.match(/\[([A-Z0-9_/\-]+)\]/g) ?? [];
  for (const entry of matches) {
    const inner = entry.slice(1, -1);
    for (const token of inner.split("/")) {
      const trimmed = token.trim();
      if (trimmed) tokens.push(trimmed);
    }
  }
  return tokens;
}

function extractKeyValueCodes(stderr: string): string[] {
  const tokens: string[] = [];
  const patterns = [
    /(?:status|statusCode|httpStatus|code)\s*[:=]\s*(\d{3})/g,
    /(?:acpxCode|detailCode|errorCode)\s*[:=]\s*([A-Z0-9_]+)/g,
  ];

  for (const pattern of patterns) {
    while (true) {
      const match = pattern.exec(stderr);
      if (!match) break;
      const code = match[1];
      if (code) tokens.push(code);
    }
  }

  return tokens;
}

function classifyFromCodeTokens(tokens: string[], payload?: Record<string, unknown>): AgentError | null {
  for (const token of tokens.map((value) => value.toUpperCase())) {
    if (
      token === "429" ||
      token === "TOO_MANY_REQUESTS" ||
      token === "RATE_LIMIT" ||
      token === "RATE_LIMITED" ||
      token === "QUOTA_EXCEEDED" ||
      token === "RESOURCE_EXHAUSTED"
    ) {
      const retryAfterSeconds = payload
        ? toNumber(payload.retryAfterSeconds ?? payload.retry_after_seconds ?? payload.retryAfter)
        : undefined;
      return retryAfterSeconds !== undefined ? { type: "rate-limit", retryAfterSeconds } : { type: "rate-limit" };
    }

    if (
      token === "401" ||
      token === "403" ||
      token === "UNAUTHORIZED" ||
      token === "FORBIDDEN" ||
      token === "AUTH_FAILED" ||
      token === "AUTHENTICATION_FAILED" ||
      token === "PERMISSION_DENIED"
    ) {
      return { type: "auth" };
    }
  }

  return null;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
