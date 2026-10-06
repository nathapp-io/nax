/**
 * Agent text made safe to show (S4 spec §6.4 "untrusted fields", §7): control
 * characters stripped, the session's secret values scrubbed, byte caps that never
 * split a character. Shared by error excerpts (errors.ts) and the approval display
 * (tool-display.ts).
 */

/** Shorter secret values are not replaced verbatim: they would garble ordinary text. */
const MIN_SECRET_LENGTH = 8;

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
