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
 */

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
