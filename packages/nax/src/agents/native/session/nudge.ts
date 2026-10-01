/**
 * The spin-breaker nudge's text composition and its cost against the
 * model-facing byte ceiling.
 *
 * These live together because they are one decision seen from two sides: how
 * the nudge is joined to a tool result, and how many bytes that join spends.
 * `truncateNativeToolResult` reserves what `nudgeOverheadBytes` reports so the
 * prefix fits INSIDE `MODEL_MAX_BYTES` instead of pushing the result past it —
 * splitting the two across modules is what lets the separator change without
 * the reservation following it.
 */

/** Joins the nudge to the result it prefixes. Counted by `nudgeOverheadBytes`. */
const NUDGE_SEPARATOR = "\n\n---\n\n";

/**
 * `nudge` prefixes the eventual result rather than replacing it: the model
 * needs the real output to act on, plus the notice that it is repeating itself
 * (nax#2120). The handler's text leads, because a handler that says "begin with
 * this" must be able to.
 */
export function withNudge(nudgeText: string | undefined, content: string): string {
  return nudgeText === undefined ? content : `${nudgeText}${NUDGE_SEPARATOR}${content}`;
}

/**
 * What `withNudge` will add, in the bytes the ceiling is measured in. The
 * truncation chokepoint reserves this so the prefix fits inside
 * `MODEL_MAX_BYTES` rather than on top of it.
 *
 * The nudge text is harness-authored and short by construction (`nudgeText()`
 * in src/runtime/spin-breaker), so the reservation never consumes the whole
 * budget in practice; `truncateNativeToolResult` floors the remainder at zero
 * regardless.
 */
export function nudgeOverheadBytes(nudgeText: string): number {
  return Buffer.byteLength(nudgeText, "utf8") + Buffer.byteLength(NUDGE_SEPARATOR, "utf8");
}
