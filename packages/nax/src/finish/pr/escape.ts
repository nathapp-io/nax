/**
 * Markdown escaping and size caps for text that reaches a PR body from a reviewer, an advisor or
 * the user's worktree. Every such string is hostile until proven otherwise: pipes, newlines,
 * backticks and HTML must not break a table, a code span or a `<details>` block, and no single
 * string may be allowed to push the body past the forge's size limit.
 */

/** Longest single cell or inline name rendered; the full text stays in result.json. */
export const CELL_MAX = 200;

/** `value` cut to `max` characters with an ellipsis. Cut before escaping so an escape is never split. */
export function capText(value: string, max = CELL_MAX): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Escape a string for a single markdown table cell: backslashes first (so the escapes below
 * survive a literal backslash), then pipes (column boundary), backticks (code spans), angle
 * brackets (raw HTML such as `</details>`) and newlines (which would start a new row).
 * The auto-PR plugin has its own narrower `escapeTableCell`; this is not shared with it.
 */
export function escapeTableCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ");
}

/** A string for inline markdown outside a table: no code spans, no tags, one line, capped. */
export function escapeInline(value: string): string {
  return capText(value).replace(/`/g, "'").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, " ");
}
