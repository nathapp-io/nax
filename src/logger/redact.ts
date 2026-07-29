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

function redactValue(input: unknown): unknown {
  if (typeof input === "string") return redactString(input);
  if (Array.isArray(input)) return input.map(redactValue);
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(value);
    }
    return out;
  }
  return input;
}
