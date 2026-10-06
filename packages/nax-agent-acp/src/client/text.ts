/**
 * Agent text made safe to show (S4 spec §6.4 "untrusted fields", §7): control
 * characters stripped, the session's secret values scrubbed, byte caps that never
 * split a character. Shared by error excerpts (errors.ts), the approval display
 * (tool-display.ts), turn events (stream-scrub.ts, tool-events.ts) and questions
 * (elicitation.ts).
 */

/** Shorter secret values are not replaced verbatim: they would garble ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/** A label longer than this is cut before cleaning; the result is far shorter. */
const LABEL_SCAN_CHARS = 16 * 1024;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Control characters removed, except newline and tab. */
export function stripControl(text: string): string {
  return text.replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
}

/** Invisible format characters removed (bidi overrides, zero-width): they can hide text from a person. */
export function stripInvisible(text: string): string {
  return text.replace(/\p{Cf}/gu, "");
}

/** Each known secret value of 8 or more characters replaced by [REDACTED]. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .reduce((acc, secret) => acc.split(secret).join("[REDACTED]"), text);
}

export function capBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
}

/**
 * `value` with every string, keys included, scrubbed of the session's secret values.
 * Expects acyclic JSON-like data (capStrings output). Keys are written as data, so a
 * `__proto__` key stays an own property.
 */
export function scrubDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [scrubSecrets(key, secrets), scrubDeep(item, secrets)]),
  );
}

/**
 * A one-line label from agent text: control and invisible characters removed,
 * whitespace collapsed, secrets scrubbed, at most `maxChars` code points. Undefined
 * for a non-string or a label that is empty after cleaning.
 */
export function cleanLabel(value: unknown, secrets: readonly string[], maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const visible = stripInvisible(stripControl(value.slice(0, LABEL_SCAN_CHARS)));
  const text = scrubSecrets(visible.replace(/\s+/g, " ").trim(), secrets);
  const capped = Array.from(text).slice(0, maxChars).join("");
  return capped === "" ? undefined : capped;
}
