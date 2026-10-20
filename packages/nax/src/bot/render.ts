// Reuse the leaf without loading the workflow barrel and its orchestration dependencies.
import { safeInline } from "../workflow/pr-body-safe";

const ZERO_WIDTH_SPACE = "\u200b";
const MARKER_HASH_LENGTH = 16;

/** Disable markdown links/images and bare scheme URLs without discarding their text. */
export function breakLinks(text: string): string {
  return text.replace(/\]\(/g, `]${ZERO_WIDTH_SPACE}(`).replace(/:\/\//g, `:${ZERO_WIDTH_SPACE}//`);
}

/** Shared redaction/neutralisation, strictly capped before inserting link breakers. */
export function safeText(text: string, max: number): string {
  // safeInline's shared cap may append an ellipsis beyond max; keep this correction local.
  return breakLinks(safeInline(text, max).slice(0, Math.max(0, max)));
}

function markerHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, MARKER_HASH_LENGTH);
}

/** Stable identity for a finding, ignoring case and whitespace differences in its issue. */
export function findingKey({ file, issue }: { file?: string; issue: string }): string {
  const normalised = issue.toLowerCase().replace(/\s+/g, " ").trim();
  return `f-${markerHash(`${file ?? ""}\n${normalised}`)}`;
}

/** Stable identity for a forge review thread. */
export function threadKey(threadId: string): string {
  return `t-${markerHash(threadId)}`;
}

/** Stable identity for a reply about an earlier finding, distinct from thread triage. */
export function earlierKey(threadId: string): string {
  return `e-${markerHash(threadId)}`;
}

/** Stable identity for a forge comment. */
export function commentKey(commentId: string): string {
  return `c-${markerHash(commentId)}`;
}
