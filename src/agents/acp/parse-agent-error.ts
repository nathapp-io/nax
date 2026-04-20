import type { AgentError } from "../types";

/**
 * Parse structured adapter error output to identify agent error type.
 *
 * Classification intentionally uses machine-readable signals only:
 * - Root JSON object fields (type/status/statusCode/code/acpxCode/detailCode)
 * - Nested Anthropic-style error shape: `{"type":"error","error":{"type":"authentication_error"}}`
 * - Embedded JSON objects within a larger free-text message (acpx wraps vendor
 *   errors in a human-readable prefix — #592)
 * - bracketed code suffixes (e.g. "[ACPX_RATE_LIMIT/TOO_MANY_REQUESTS]")
 * - explicit key=value codes (e.g. "statusCode=429")
 *
 * Free-text phrase inference is intentionally not supported — we only match
 * structured signals, even when they are nested inside a larger string.
 */
export function parseAgentError(stderr: string): AgentError {
  if (!stderr) {
    return { type: "unknown" };
  }

  // 1. Try parsing the whole string as a JSON object.
  const parsedJson = parseJsonObject(stderr);
  if (parsedJson) {
    const classified = classifyJsonPayload(parsedJson);
    if (classified) return classified;
  }

  // 2. If the whole string isn't JSON, look for embedded JSON objects (#592).
  //    Acpx wraps vendor errors like:
  //      `Internal error: Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error",...}}`
  //    The embedded object is the authoritative classifier.
  if (!parsedJson) {
    for (const embedded of extractEmbeddedJsonObjects(stderr)) {
      const classified = classifyJsonPayload(embedded);
      if (classified) return classified;
    }
  }

  const bracketed = extractBracketedCodes(stderr);
  const fromBracketed = classifyFromCodeTokens(bracketed);
  if (fromBracketed) return fromBracketed;

  const fromKeyValue = classifyFromCodeTokens(extractKeyValueCodes(stderr));
  if (fromKeyValue) return fromKeyValue;

  return { type: "unknown" };
}

/**
 * Apply all JSON-payload classifiers in order. Shared by the root-JSON
 * path and the embedded-JSON path (#592).
 */
function classifyJsonPayload(payload: Record<string, unknown>): AgentError | null {
  const direct = classifyDirectType(payload);
  if (direct) return direct;

  const nested = classifyNestedAnthropicError(payload);
  if (nested) return nested;

  const structured = classifyFromCodeTokens(extractJsonCodeTokens(payload), payload);
  if (structured) return structured;

  return null;
}

/**
 * Match the Anthropic-style error envelope where the outer `type` is "error"
 * and the inner `error.type` carries the specific classification (#592):
 *
 *   {"type":"error","error":{"type":"authentication_error","message":"..."}}
 *   {"type":"error","error":{"type":"rate_limit_error","message":"..."}}
 *
 * Returns null when the envelope doesn't match — falls through to other
 * classifiers.
 */
function classifyNestedAnthropicError(payload: Record<string, unknown>): AgentError | null {
  if (payload.type !== "error") return null;
  const inner = payload.error;
  if (!inner || typeof inner !== "object") return null;
  const innerType = (inner as Record<string, unknown>).type;
  if (typeof innerType !== "string") return null;

  switch (innerType) {
    case "authentication_error":
    case "permission_error":
    case "invalid_api_key_error":
      return { type: "auth" };
    case "rate_limit_error":
    case "overloaded_error": {
      const retryAfterSeconds = toNumber(
        (inner as Record<string, unknown>).retryAfterSeconds ??
          (inner as Record<string, unknown>).retry_after_seconds ??
          payload.retryAfterSeconds ??
          payload.retry_after_seconds,
      );
      return retryAfterSeconds !== undefined ? { type: "rate-limit", retryAfterSeconds } : { type: "rate-limit" };
    }
    default:
      return null;
  }
}

/**
 * Scan a free-text message for embedded JSON objects (#592).
 *
 * Uses a balanced-brace walk rather than a naive regex so nested objects
 * parse correctly. Returns objects only — top-level arrays and primitives
 * are skipped since the classifier only looks at objects.
 *
 * Caps the number of extracted candidates to keep pathological inputs from
 * becoming a performance issue.
 */
const MAX_EMBEDDED_CANDIDATES = 8;
function extractEmbeddedJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length && objects.length < MAX_EMBEDDED_CANDIDATES) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    const close = findMatchingBrace(text, open);
    if (close === -1) break;
    const candidate = text.slice(open, close + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not valid JSON — advance past the opening brace and keep scanning.
    }
    i = close + 1;
  }
  return objects;
}

/**
 * Find the index of the `}` that closes the `{` at `openIdx`.
 * Honours string literals so braces inside JSON strings don't mislead the
 * scanner. Returns -1 if no match is found (unbalanced input).
 */
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
