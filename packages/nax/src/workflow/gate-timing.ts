/**
 * A reviewer's cannotVerify line that only says "nax runs the full suite / the repository gates
 * later" (10-19). nax records whether each of those gates ran and what it returned, so the line
 * verifies nothing and only adds an item a finishing tool must rule on. Some models write one per
 * story despite the prompt; this drops them deterministically.
 *
 * Conservative by construction: a line is dropped only when it names one of nax's own gates, gives
 * a not-yet-run reason, and carries no evidence of its own (an exit code, an error, a sandbox or
 * service limit, a failure count). Coverage is not one of nax's repository gates, so a line about
 * it is always kept. Calibrated against every story and branch ledger line on 10-19: 112 of 436
 * dropped, none of them carrying evidence.
 */
import { ledgerText } from "./ledger";

const NAX_GATE = /\b(full(?:[- ]package)?(?:[- ]test)?[- ]suite|repo(?:sitory)?(?:-wide|-level)?[- ]gates?)\b/i;
const NOT_YET =
  /\b(after (?:this |the )?review|runs? after|runs? only after|not (?:yet )?(?:been )?run|has(?: not|n't) run|have(?: not|n't) run|had not run|not (?:yet )?(?:been )?reached|never reached|not yet|once every story|after all stories|post-review)\b/i;
const EVIDENCE =
  /(\bexit(?:ed|s)?(?: code)?\s*[=:]?\s*[1-9]|\bfail|\bneeds?\b|\brequires?\b|\bdepends? on|\bonly (?:on|in|with)\b|\bskip|\btodo\b|\bcredential|\bbrowser|\bsandbox|\bpostgres|\bdocker|\bdatabase|\bdb-|\bintegration\b|\brefused|\berror|\btime(?:d)? ?out|\bpre-existing|\bunrelated|\d+(?:\.\d+)?%|\blive\b|\bnetwork|\bblocked|\babort|coverage)/i;
/** Case-sensitive: an errno (`EPERM`), `PG` or `CI` — insensitive, the first would match "every". */
const EVIDENCE_CODES = /\b(?:E[A-Z]{3,}|PG|CI)\b/;

/** A scoped-run tally ("13 pass, 0 fail") reports nothing failing; it must not read as a failure. */
const ZERO_FAIL = /\b0 fail(?:ed|ures?|s)?\b/gi;

export function isGateTimingItem(text: string): boolean {
  const body = text.replace(ZERO_FAIL, "");
  return NAX_GATE.test(body) && NOT_YET.test(body) && !EVIDENCE.test(body) && !EVIDENCE_CODES.test(body);
}

export function splitGateTimingItems(items: readonly string[]): { kept: string[]; dropped: string[] } {
  return {
    kept: items.filter((item) => !isGateTimingItem(item)),
    dropped: items.filter(isGateTimingItem),
  };
}

/**
 * Ledgers a review's cannotVerify lines and returns the ones kept. A dropped line stays in the ledger
 * as a note whose prefix `collectLedgerItems` does not parse, so it never becomes an open item.
 */
export async function ledgerCannotVerify(
  sink: { ledger(text: string): Promise<void> },
  items: readonly string[],
): Promise<string[]> {
  const { kept, dropped } = splitGateTimingItems(items);
  for (const item of kept) await sink.ledger(ledgerText.note(`cannot-verify: ${item}`));
  for (const item of dropped)
    await sink.ledger(ledgerText.note(`cannot-verify dropped (a nax gate covers it): ${item}`));
  return kept;
}
