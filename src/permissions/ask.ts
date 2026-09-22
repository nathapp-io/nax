import { type AskResolver, chainAskLinks } from "./ask-chain";

/**
 * Why an ask-matched call was refused. One string per CASE: the previous single
 * message asserted "this run is headless" for situations that are not, and the
 * three are materially different facts for anyone reading the ledger.
 */
export const ASK_NO_CHANNEL_REASON =
  "matched an ask rule requiring human approval; no approval channel is configured for this run, so the call is refused";
export const ASK_TIMEOUT_REASON =
  "matched an ask rule requiring human approval; no answer arrived before the approval timeout, so the call is refused";
export const ASK_DENIED_REASON = "matched an ask rule requiring human approval; the operator denied it";

/** Kept for compatibility with existing callers and tests. */
export const ASK_UNAVAILABLE_REASON = ASK_NO_CHANNEL_REASON;

/**
 * The resolver a run gets when no channel is available: a chain with zero
 * links, whose terminal deny supplies the answer. TOTAL -- never abstains.
 */
export function headlessAskResolver(): AskResolver {
  return chainAskLinks([]);
}
