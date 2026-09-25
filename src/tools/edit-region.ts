/**
 * Edit's literal replacement (US-001).
 *
 * `String.prototype.replace` reads a string replacement as a template and
 * expands `$$`, `$&`, `` $` `` and `$'` inside it, so
 * `source.replace(oldString, newString)` writes something other than the
 * characters the model supplied whenever `new_string` contains one of those
 * patterns — `"a".replace("a", "x$$y$&z")` returns `x$yaz`. Composing the
 * result by hand keeps every character literal.
 *
 * File-local on purpose, matching `src/tools/read-continuation.ts`: the
 * helper is a property of the `Edit` composition, nothing else composes it,
 * and `src/tools` does not export it from its barrel — `edit.ts` imports it
 * by relative path.
 *
 * US-002 extends the module with `composeEditRegion`, the bounded
 * Read-compatible view of the region an Edit just wrote: the `[lines a-b of
 * N]` header and the selected lines, with elision when the replacement spans
 * more than `MAX_REGION_LINES_SHOWN` lines. Deterministic string composition
 * — no LLM, no config, no new tool arguments.
 */

import { splitModelLines } from "./truncate";

/** Context lines shown on each side of the replacement. */
const CONTEXT_LINES = 3;
/** Above this many replacement lines the view elides the middle. */
const MAX_REGION_LINES_SHOWN = 8;

/**
 * Inputs to `composeEditRegion`.
 *
 * `matchIndex` is the offset `source.indexOf(oldString)` found — the caller
 * wrote the new text there, so `updated.slice(0, matchIndex)` is identical to
 * the source prefix and the start line can be counted on either.
 */
export interface EditRegionInput {
  readonly updated: string;
  readonly matchIndex: number;
  readonly newStringLength: number;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") count += 1;
  }
  return count;
}

/**
 * The bounded, Read-compatible view of the region an Edit wrote: a
 * `[lines a-b of N]` header and the selected lines, or `[file is now empty]`
 * for an emptied file. Has no trailing newline, and cannot throw on any
 * string input.
 */
export function composeEditRegion({ updated, matchIndex, newStringLength }: EditRegionInput): string {
  const lines = splitModelLines(updated);
  const total = lines.length;
  // Rule 6 — an emptied file has no lines to show and no range to name.
  if (total === 0) return "[file is now empty]";

  // Rule 1/2 — the start line and the line holding the replacement's last
  // character, each clamped to N so a deletion at the very end of a file
  // still names a real line. A pure deletion has no characters of its own,
  // so its end line is its start line.
  const start = Math.min(total, 1 + countNewlines(updated.slice(0, matchIndex)));
  const end =
    newStringLength > 0
      ? Math.min(total, 1 + countNewlines(updated.slice(0, matchIndex + newStringLength - 1)))
      : start;

  // Rule 3 — the window is CONTEXT_LINES on each side of the replacement.
  const a = Math.max(1, start - CONTEXT_LINES);
  const b = Math.min(total, end + CONTEXT_LINES);
  const header = `[lines ${a}-${b} of ${total}]`;

  // Rule 4 — a replacement longer than MAX_REGION_LINES_SHOWN is elided in
  // the middle: the context and the first 3 replaced lines, a marker naming
  // the omitted range, then the last 3 replaced lines and the context.
  // Rule 5 — otherwise the whole window is shown.
  const selected =
    end - start + 1 > MAX_REGION_LINES_SHOWN
      ? [
          ...lines.slice(a - 1, start + 2),
          `[... lines ${start + 3}-${end - 3} not shown ...]`,
          ...lines.slice(end - 3, b),
        ]
      : lines.slice(a - 1, b);

  // Rule 7 — the content has no trailing newline. A window whose last line
  // is blank (`b` sits on an empty line, or the file is a lone newline) would
  // otherwise leave the joining delimiter at the very end, so trailing empty
  // lines are dropped rather than emitted as a bare "\n".
  let view = [header, ...selected].join("\n");
  while (view.endsWith("\n")) view = view.slice(0, -1);
  return view;
}

/**
 * Replace the single occurrence of `oldString` at `matchIndex` with
 * `newString`, literally.
 *
 * The caller has already established uniqueness (`countOccurrences` in
 * `edit.ts`) and passes the index `source.indexOf(oldString)` found, so this
 * is pure slicing: everything before the match, the new text verbatim, and
 * everything after it. No `replace`, and therefore no substitution patterns.
 */
export function replaceUniqueLiteral(source: string, oldString: string, newString: string, matchIndex: number): string {
  return source.slice(0, matchIndex) + newString + source.slice(matchIndex + oldString.length);
}
