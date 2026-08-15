/**
 * Secret-redaction helper for the JSONL logger write path.
 *
 * Two layers of protection:
 *  1. Key-based: any field whose name matches SECRET_KEY_PATTERN gets its value
 *     replaced with "[REDACTED]" regardless of content.
 *  2. Pattern-based: free-text strings (in values that did NOT trigger layer 1)
 *     are scanned for token-shaped substrings (API keys, PATs, etc.).
 */

// TOKEN(?!s\b) prevents matching plural metric keys like "tokens", "inputTokens",
// "totalTokens" (which are counts, not credentials) while still matching "token",
// "GITHUB_TOKEN", "accessToken", etc.
const SECRET_KEY_PATTERN = /(SECRET|TOKEN(?!s\b)|API_?KEY|PASSWORD|PRIVATE_?KEY|ACCESS_?KEY|WEBHOOK)/i;

/**
 * Patterns are reset via `re.lastIndex = 0` before every call because they carry
 * the `/g` flag (required for `String.replace`). Resetting prevents the stale
 * `lastIndex` bug that skips matches on subsequent calls.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{16,}/g,
  /gh[opsu]_[A-Za-z0-9]{16,}/g,
  /npm_[A-Za-z0-9]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // KEY=value assignments inside strings (e.g. "NPM_TOKEN=somevalue")
  /(?:SECRET|TOKEN|API_?KEY|PASSWORD|PRIVATE_?KEY|ACCESS_?KEY|WEBHOOK)=[^\s"',]+/gi,
  // MED-01: PEM-encoded key/cert blocks (private keys, certificates, incl.
  // PGP's " ... BLOCK" suffix). The gap between BEGIN/END is bounded
  // (real PEM blocks are a few KB) — an unbounded [\s\S]*? re-scans to
  // end-of-string for every unterminated "BEGIN" marker, which is
  // quadratic on large agent stdout/stderr payloads on this synchronous
  // logger write path.
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)(?: BLOCK)?-----[\s\S]{0,8192}?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)(?: BLOCK)?-----/g,
  // MED-01: JWTs (header.payload.signature, base64url segments).
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  // MED-01: Authorization header values (Bearer/Basic schemes). Requires a
  // credential-shaped value (>=16 chars, at least one digit/symbol) so
  // ordinary prose like "Basic authentication failed" or "Bearer token
  // scheme" isn't swallowed — real bearer tokens and base64 basic creds
  // always contain non-alphabetic characters at that length; English words
  // essentially never do.
  /\b(?:Bearer|Basic)\s+(?=[A-Za-z0-9\-._~+/]*[0-9+/_-])[A-Za-z0-9\-._~+/]{16,}={0,2}/gi,
  // MED-01: header-style key:value / key=value pairs for api-key headers
  // that SECRET_KEY_PATTERN's object-key check can't reach because the
  // key/value are both embedded in one free-text string (e.g. raw HTTP logs).
  /(?:x-api-key|api[_-]?key)\s*[:=]\s*[^\s"',]+/gi,
];

const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  let out = value;
  for (const re of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Recursively walk `input` and return a new value with secrets removed.
 * - Primitive non-strings are returned as-is.
 * - Object keys matching SECRET_KEY_PATTERN → value replaced with "[REDACTED]".
 * - String values (not key-redacted) → token-pattern scan.
 * - Arrays and nested objects are walked recursively.
 */
export function redactSecrets(input: unknown): unknown {
  return redactValue(input);
}

/**
 * Redact a whole log entry — both the free-text `message` and the structured
 * `data` payload.
 *
 * `message` matters as much as `data`: callers routinely interpolate shell
 * commands, agent stderr, and error text into it, any of which can carry a
 * credential. Redacting only `data` left those in cleartext.
 */
export function redactEntry<T extends { message: string; data?: Record<string, unknown> }>(entry: T): T {
  return {
    ...entry,
    message: redactString(entry.message),
    ...(entry.data ? { data: redactValue(entry.data) as Record<string, unknown> } : {}),
  };
}

/** Depth guard is a backstop against pathological (non-circular but very deep) input; the WeakSet is what actually stops cycles. */
const MAX_REDACT_DEPTH = 100;
const CIRCULAR_REF_MARKER = "[Circular]";

/**
 * MED-02: unguarded recursion here threw a RangeError (stack overflow) out
 * of every logger call whenever a data payload contained a circular
 * reference — a single bad log call could crash whatever code path was
 * trying to log. `seen` tracks objects/arrays currently on the recursion
 * stack (removed on the way back out, so the same object appearing twice at
 * different, non-nested positions is still redacted normally) and
 * `MAX_REDACT_DEPTH` bounds pathologically deep-but-acyclic input.
 */
function redactValue(input: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (typeof input === "string") return redactString(input);
  if (input === null || typeof input !== "object") return input;
  if (depth >= MAX_REDACT_DEPTH || seen.has(input)) return CIRCULAR_REF_MARKER;

  seen.add(input);
  try {
    if (Array.isArray(input)) return input.map((item) => redactValue(item, seen, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(value, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(input);
  }
}
