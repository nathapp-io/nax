/**
 * Ranged-read limit-stop footer (US-001).
 *
 * A ranged `Read` whose `limit` ended before the file's known line count
 * appends a single trailer line that names both the count of unseen lines
 * and the offset to call back with. Without it, a model that asked for the
 * first five lines of a fifty-line file would have no in-band signal that
 * the file continues or how to ask for the next slice — every continuation
 * had to be inferred by trial and error.
 *
 * The trailer is composed deterministically by `limitStopFooter` from three
 * inputs the tool already has on hand: the slice's last line number, the
 * floor or true total from the ranged read, and whether that total is a
 * floor (the read stopped at its I/O bound — `maxFileBytes` on this path).
 *
 * The exact predicate that gates the footer lives here as well: a limit
 * was supplied AND the slice ends before the last line the tool can see.
 * That second clause is what suppresses the footer in the two ACs where
 * it would be wrong — `endLine == totalLines`, and the offset-past-last-read
 * case where the floor header already proves nothing more is reachable
 * within the byte budget.
 *
 * File-local on purpose. The footer is a property of the ranged `Read`
 * composition, nothing else composes it, and `src/tools` does not export
 * it from its barrel — `read.ts` imports it by relative path.
 */

/** Inputs the ranged branch already has on hand. */
export interface LimitStopFooterInput {
  /** The offset to continue from: `endLine + 1`. */
  readonly nextOffset: number;
  /** True iff the read stopped at the I/O bound (`maxFileBytes` here). */
  readonly totalIsFloor: boolean;
  /** The slice's last line number — call it `b` in the spec. */
  readonly endLine: number;
  /** The total the ranged branch reported (the `T` of `R = T - b`). */
  readonly totalLines: number;
}

/**
 * Compose the single trailer line that names the continuation offset.
 *
 * `R = totalLines - endLine`, with a trailing `+` exactly when the total
 * is a floor — the read stopped at its I/O bound and the model cannot
 * know how many more lines the file really has. The footer is the result's
 * LAST line: the ranged `Read` joins the body and the footer with `\n`
 * and writes nothing after the footer.
 *
 * The "should the footer be appended at all" check is
 * `shouldAppendLimitStopFooter` — callers decide first, then ask this helper
 * to compose the trailer. Splitting the gate from the composition keeps the
 * no-footer case a pure body with no trailing delimiter to manage.
 */
export function limitStopFooter(input: LimitStopFooterInput): string {
  const { nextOffset, totalIsFloor, endLine, totalLines } = input;
  const remaining = Math.max(0, totalLines - endLine);
  const countLabel = totalIsFloor ? `${remaining}+` : `${remaining}`;
  return `[${countLabel} more lines in file. Use offset=${nextOffset} to continue.]`;
}

/**
 * True iff the ranged branch should append the limit-stop footer. Two
 * conditions, both required:
 *
 *   1. `limit` was supplied. Without a limit the slice already runs to
 *      the end of what the tool can read, so there is nothing to name.
 *   2. `endLine < totalLines`. When the slice's last line IS the last line
 *      the tool can see, the model cannot ask for anything more — the
 *      floor header already names that ceiling. Appending a footer that
 *      points back inside the slice would mislead the model into reading
 *      the same lines twice.
 *
 * Hides the predicate behind a function so the `read.ts` call site reads
 * as the spec, not as the arithmetic.
 */
export function shouldAppendLimitStopFooter(hasLimit: boolean, endLine: number, totalLines: number): boolean {
  return hasLimit && endLine < totalLines;
}
