// Reuse the leaf without loading the workflow barrel and its orchestration dependencies.
import { capEscaped } from "../finish/pr/escape";
import { safeInline } from "../workflow/pr-body-safe";

const ZERO_WIDTH_SPACE = "\u200b";
const MARKER_HASH_LENGTH = 16;

/** Disable markdown links/images and bare scheme URLs without discarding their text. */
export function breakLinks(text: string): string {
  return text.replace(/\]\(/g, `]${ZERO_WIDTH_SPACE}(`).replace(/:\/\//g, `:${ZERO_WIDTH_SPACE}//`);
}

/** Redact and neutralise, then strictly cap the final text on escaped-token boundaries. */
export function safeText(text: string, max: number): string {
  const rendered = breakLinks(safeInline(text, Number.POSITIVE_INFINITY));
  const limit = Math.max(0, max);
  return rendered.length > limit ? capEscaped(rendered, limit).slice(0, -1) : rendered;
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
