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
// SEC-1 (Round 2 review): URL/URI/DSN/_URL/CONNECTIONSTRING were missing —
// DATABASE_URL=postgres://admin:s3cret@db/prod passed through both redaction
// layers (the KEY=value regex required SECRET|TOKEN|... before `=`, which
// DATABASE_URL doesn't satisfy; the key pattern didn't match either).
const SECRET_KEY_PATTERN =
  /(SECRET|TOKEN(?!s\b)|API_?KEY|PASSWORD|PRIVATE_?KEY|ACCESS_?KEY|WEBHOOK|(?:\w+)?_URL|\w+_URI|\w+_DSN|CONNECTION\s*STRING)/i;

/**
 * Patterns are reset via `re.lastIndex = 0` before every call because they carry
 * the `/g` flag (required for `String.replace`). Resetting prevents the stale
 * `lastIndex` bug that skips matches on subsequent calls.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{16,}/g,
  /gh[opsu]_[A-Za-z0-9]{16,}/g,
  // LOG-1: GitHub fine-grained PATs — gh[opsu]_ above never matches "github_pat_"
  // ("gh" + "i" is not one of [opsu]).
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /npm_[A-Za-z0-9]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // LOG-1: Telegram bot tokens ("<bot-id>:<35-char secret>").
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  // KEY=value assignments inside strings (e.g. "NPM_TOKEN=somevalue")
  /(?:SECRET|TOKEN|API_?KEY|PASSWORD|PRIVATE_?KEY|ACCESS_?KEY|WEBHOOK)=[^\s"',]+/gi,
  // MED-01: PEM-encoded key/cert blocks (private keys, certificates, incl.
  // PGP's " ... BLOCK" suffix). The gap between BEGIN/END is bounded to
  // 64KB — generous enough for any realistic single key or bundled
  // certificate chain, while still capping the rescan cost of an
  // unterminated "BEGIN" marker in a pathologically large payload on this
  // synchronous logger write path (a small bound like a few KB risks
  // missing legitimate multi-cert chain bundles entirely).
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)(?: BLOCK)?-----[\s\S]{0,65536}?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)(?: BLOCK)?-----/g,
  // MED-01: JWTs (header.payload.signature, base64url segments).
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  // MED-01: Authorization header values (Bearer/Basic schemes). Requires a
  // credential-shaped value (>=8 chars, at least one digit/symbol) so
  // ordinary prose like "Basic authentication failed" or "Bearer token
  // scheme" isn't swallowed — real bearer tokens and base64 basic creds
  // almost always contain a non-alphabetic character; English words
  // essentially never do. Length floor kept at 8 (not raised to 16) so
  // short-but-real base64 credentials (e.g. "user:pass" -> ~16 raw chars,
  // shorter inputs shorter still) aren't under-redacted.
  /\bBearer\s+(?=[A-Za-z0-9\-._~+/]*[0-9+/_-])[A-Za-z0-9\-._~+/]{8,}={0,2}/gi,
  // LOG-1: Basic creds are base64(user:pass) and are frequently pure-alphabetic
  // (no digit/symbol), which the digit-requiring lookahead above misses. Require
  // mixed case instead — real base64 output almost always mixes upper/lower,
  // while English prose like "Basic authentication" does not. No `i` flag here
  // (unlike Bearer): case-insensitivity would make [A-Z]/[a-z] equivalent,
  // defeating the mixed-case check — so the "basic" keyword is spelled out
  // char-by-char to stay case-insensitive for the scheme name only (the
  // scheme is case-insensitive per RFC 7617; "basic"/"BASIC" are as valid as
  // "Basic") while the payload lookaheads remain case-sensitive.
  /\b[Bb][Aa][Ss][Ii][Cc]\s+(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{8,}={0,2}/g,
  // MED-01: header-style key:value / key=value pairs for api-key headers
  // that SECRET_KEY_PATTERN's object-key check can't reach because the
  // key/value are both embedded in one free-text string (e.g. raw HTTP logs).
  /(?:x-api-key|api[_-]?key)\s*[:=]\s*[^\s"',]+/gi,
  // SEC-1 (Round 2 review): URL-embedded credentials (scheme://user:pass@host).
  // Matches a scheme name (lowercase letters, digits, +, ., -), then ://, then
  // optional user:password (no /, whitespace, or @), then @. The colon + @
  // is the load-bearing signal that a credential is present; credential-less
  // URLs like "https://example.com/foo" are intentionally left alone because
  // they have no colon between :// and @.
  // Examples:
  //   postgres://admin:s3cret@db.internal:5432/prod  →  "postgres://admin:s3cret@"
  //   redis://:hunter2@cache.internal:6379/0          →  "redis://:hunter2@"     (empty user)
  //   mongodb://root:mongoPwd@mongo.internal:27017    →  "mongodb://root:mongoPwd@"
  /\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s@]*:[^/\s@]+)@/gi,
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
