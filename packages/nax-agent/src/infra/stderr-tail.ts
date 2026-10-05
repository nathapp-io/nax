/**
 * A bounded tail of a child process's stderr (S4 spec 5.6, 7). Backends keep
 * the last bytes for error excerpts; excerpt() strips control characters,
 * redacts caller-known secrets and known token shapes, and returns at most
 * maxBytes from the end, so an error never carries a raw agent log.
 */
import { redactSecrets } from "#src/internal/redact";

const DEFAULT_CAPACITY = 65_536;
const DEFAULT_EXCERPT = 4096;
const MIN_SECRET_LENGTH = 4;
// C0 controls and DEL, except tab (\u0009) and newline (\u000A).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point of this regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

export interface StderrTail {
  push(chunk: string | Uint8Array): void;
  excerpt(opts?: { readonly maxBytes?: number; readonly secrets?: readonly string[] }): string;
}

function lastBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return bytes
    .subarray(bytes.byteLength - maxBytes)
    .toString("utf8")
    .replace(/^�+/, "");
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(CONTROL, "");
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("[REDACTED]");
  }
  return redactSecrets(out);
}

export function createStderrTail(capacityBytes: number = DEFAULT_CAPACITY): StderrTail {
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer = lastBytes(buffer, capacityBytes);
    },
    excerpt(opts = {}) {
      return lastBytes(scrub(buffer, opts.secrets ?? []), opts.maxBytes ?? DEFAULT_EXCERPT);
    },
  };
}
