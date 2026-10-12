/**
 * Markdown escaping and size caps for text that reaches a PR body from a reviewer, an advisor or
 * the user's worktree. Every such string is hostile until proven otherwise: pipes, newlines,
 * backticks and HTML must not break a table, a code span or a `<details>` block, and no single
 * string may be allowed to push the body past the forge's size limit.
 */

/** Longest single escaped cell or inline name rendered; the full text stays in result.json. */
export const CELL_MAX = 200;

/** Size limits for the rendered body: rows per table or list, and escaped characters per cell. */
export interface BodyLimits {
  rows: number;
  cell: number;
}

export const DEFAULT_LIMITS: BodyLimits = { rows: 50, cell: CELL_MAX };

/** Whole tokens only: an escape (`\\x`), an entity (`&lt;`) or one code point (never half a surrogate pair). */
const TOKEN = /\\[\s\S]|&[a-z]+;|[\s\S]/gu;

/**
 * `escaped` cut to `max` characters with an ellipsis, on a token boundary. Apply it AFTER
 * escaping so the cap bounds what is actually rendered, and so no escape sequence or
 * surrogate pair is split.
 */
export function capEscaped(escaped: string, max: number = CELL_MAX): string {
  if (escaped.length <= max) return escaped;
  let out = "";
  for (const token of escaped.match(TOKEN) ?? []) {
    if (out.length + token.length > max) break;
    out += token;
  }
  return `${out}…`;
}

/**
 * Escape a string for a single markdown table cell: backslashes first (so the escapes below
 * survive a literal backslash), then pipes (column boundary), backticks (code spans), angle
 * brackets (raw HTML such as `</details>`) and newlines (which would start a new row); then capped.
 * The auto-PR plugin has its own narrower `escapeTableCell`; this is not shared with it.
 */
export function escapeTableCell(value: string, max: number = CELL_MAX): string {
  return capEscaped(
    value
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/`/g, "\\`")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\r?\n/g, " "),
    max,
  );
}

/** A string for inline markdown outside a table: no code spans, no tags, one line, capped after escaping. */
export function escapeInline(value: string, max: number = CELL_MAX): string {
  return capEscaped(value.replace(/`/g, "'").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, " "), max);
}
