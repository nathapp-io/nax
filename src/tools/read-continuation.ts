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

// -----------------------------------------------------------------------------
// US-002 — Read self-cap at whole-line model caps.
//
// The cap footer replaces the limit-stop footer when a Read result overflows
// either of the model-facing budgets (line count or byte count). It names
// the LAST line the cut delivered and the offset to continue from — the
// same shape the limit-stop footer uses, but with the absolute line range
// instead of an "N more" count, because the cut may have stopped well
// short of what the limit asked for.
//
// The cut itself is deterministic: try the largest k such that
// header + k lines + cap footer fits both budgets; on no-k-fits, return
// the unshaped body (today's result, plus the limit-stop footer from rule 1
// if it applied). The cap footer REPLACES the limit-stop footer on a cut
// — a result never carries both.
// -----------------------------------------------------------------------------

/** Inputs to compose a single cap footer line. */
export interface CapFooterInput {
  /** First selected line number: 1 on the whole-file path, `offset` on the ranged path. */
  readonly firstLine: number;
  /** Last selected line number in the cut. The cap footer names `firstLine..lastLine`. */
  readonly lastLine: number;
  /**
   * Pre-formatted total label: `1500` when the read saw the whole file,
   * `6+` when the read stopped at its I/O bound (the `readCeiling` floor on
   * the whole-file path, `maxFileBytes` floor on the ranged path). The
   * trailing `+` is the caller's responsibility; the helper does not
   * re-derive the floor because it does not know which I/O bound was used.
   */
  readonly totalLabel: string;
}

/**
 * The cap footer: `[Showing lines a-b of T. Use offset=X to continue.]`,
 * where `X = b + 1`. Same text the limit-stop footer uses for `X`; the
 * difference is the rest of the message — the cap footer names the
 * delivered range, the limit-stop footer names the unseen count.
 *
 * The footer is the result's last line. `read.ts` joins it to the body
 * with `\n` and writes nothing after it.
 */
export function capFooter(input: CapFooterInput): string {
  const { firstLine, lastLine, totalLabel } = input;
  return `[Showing lines ${firstLine}-${lastLine} of ${totalLabel}. Use offset=${lastLine + 1} to continue.]`;
}

/** Inputs to `applyCapCut` — the tool's two paths pass them in their own shape. */
export interface ApplyCapCutInput {
  /** Header line, already composed: `[1500 lines]`, `[6+ lines]`, `[lines 100-1299 of 1500]`. */
  readonly header: string;
  /** Selected lines, already split by `\n`. Whole-file: every line of the prefix; ranged: `offset..endLine`. */
  readonly lines: readonly string[];
  /** First selected line number (1 on whole-file, `offset` on ranged). */
  readonly firstLine: number;
  /** Pre-formatted total label with the floor `+` if applicable. */
  readonly totalLabel: string;
  /** Limit-stop footer text if rule 1 applied, otherwise `""`. Replaced by the cap footer on a cut. */
  readonly limitStopFooter: string;
  /** Today's unshaped body — returned verbatim when no `k >= 1` fits. */
  readonly unshapedBody: string;
  /** Model-facing byte ceiling (`ctx.maxBytes`). */
  readonly maxBytes: number;
  /** Model-facing line ceiling (`MODEL_MAX_LINES`). */
  readonly maxLines: number;
}

/** Output of `applyCapCut`. */
export interface ApplyCapCutResult {
  /** The composed result content. */
  readonly content: string;
  /** True iff the cap cut fired — a cap footer was appended. */
  readonly cut: boolean;
}

/**
 * Compose the final result: fit the candidate if it fits, else cut at the
 * largest `k >= 1` such that `header + first k lines + cap footer` fits
 * both budgets, else return the unshaped body.
 *
 * The byte budget is measured over the WHOLE result (header and footer
 * included); the line budget counts the whole result's lines (the same
 * `MODEL_MAX_LINES` the after_tool policy uses). The cap footer is the
 * last line and replaces the limit-stop footer when it fires.
 *
 * On no-`k`-fits, the limit-stop footer (if rule 1 produced one) is
 * appended to today's unshaped body — the spec's "today's result, plus
 * the limit-stop footer from rule 1 if it applied" — so an over-the-cap
 * read that the tool cannot even trim by one line still tells the model
 * how to continue. The after_tool policy then shapes the bytes.
 */
export function applyCapCut(input: ApplyCapCutInput): ApplyCapCutResult {
  const { header, lines, firstLine, totalLabel, limitStopFooter, unshapedBody, maxBytes, maxLines } = input;

  // Rule 1's candidate: today's body, plus the limit-stop footer if it
  // applied. The fit check decides whether this form is what the model
  // sees (returning it unchanged when it fits) or whether the cap cut
  // has to fire.
  const candidate = limitStopFooter === "" ? unshapedBody : `${unshapedBody}\n${limitStopFooter}`;

  // Step 1 — fit check. If today's candidate fits both the line cap and
  // the byte cap, return it unchanged. The after_tool policy then sees a
  // within-cap result and is a no-op on it.
  const candidateLines = candidate.split("\n");
  if (candidateLines.length <= maxLines && Buffer.byteLength(candidate, "utf8") <= maxBytes) {
    return { content: candidate, cut: false };
  }

  // Step 2 — cap cut. Try k from largest to smallest; the first one that
  // fits both budgets is the cut. Walking largest-first is what guarantees
  // the result holds the most whole lines that can fit — picking a smaller
  // k would leave whole lines on the floor that could have been delivered.
  for (let k = lines.length; k >= 1; k -= 1) {
    // Line budget: header + k body lines + cap footer line.
    if (1 + k + 1 > maxLines) continue;

    const lastLine = firstLine + k - 1;
    const footer = capFooter({ firstLine, lastLine, totalLabel });

    // Compose: header\n + (k lines joined by \n) + \n + footer.
    // No trailing newline — the cap footer is the last line, with
    // nothing after it. A cut result never ends with a newline.
    const bodyJoined = lines.slice(0, k).join("\n");
    const cut = `${header}\n${bodyJoined}\n${footer}`;

    if (Buffer.byteLength(cut, "utf8") <= maxBytes) {
      return { content: cut, cut: true };
    }
  }

  // Step 3 — no k fits: today's candidate passes through unchanged. The
  // cap footer is absent here — the rule is "no line fits with the header
  // and cap footer", so neither can be appended. The after_tool policy
  // is the backstop for these cases.
  return { content: candidate, cut: false };
}
