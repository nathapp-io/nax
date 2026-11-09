/**
 * The spend a failed `complete()` hop already incurred (M10, US-005).
 *
 * `dispatchCompleteHop` converts a throw into the failure-shaped
 * `CompleteResult` `completeWithFallback` classifies. Until US-005 that result
 * carried zero `tokenUsage` and `estimatedCostUsd: 0`, so a hop that timed out
 * or was cancelled mid-turn — real tokens, real money already spent — recorded
 * nothing in the cost ledger. The spend exists on the error instead, in two
 * shapes:
 *
 * - a `SessionTurnError` carries it directly in the BUG-57 slots
 *   (`tokenUsage` / `estimatedCostUsd` / `exactCostUsd`);
 * - any other error may carry a `FailedTurnSpend` attached through
 *   `attachTurnSpend` — the ACP transport attaches it on the timeout path
 *   (`acp/complete.ts`), and `spendOfError` reads it the same way for a failed
 *   prompt.
 *
 * Lives in its own module because `manager-dispatch.ts` sits at its 600-line
 * hard ceiling (`.claude/rules/project-conventions.md` "File Size") and cannot
 * hold the lift inline.
 */
import { readTurnSpend, SessionTurnError } from "@nathapp/nax-agent";
import type { CompleteResult } from "./types";

/** The spend fields a failed hop contributes to its `CompleteResult`. */
export type CompleteHopSpend = Pick<CompleteResult, "tokenUsage" | "estimatedCostUsd" | "exactCostUsd">;

/**
 * Lift the spend off a thrown error.
 *
 * `SessionTurnError` wins when it has usage: it is the richer source (its
 * estimate and its exact cost are independent — an exact cost may accompany a
 * zero estimate). Otherwise `readTurnSpend` answers, and a `costSource` of
 * `"reported"` makes its `costUsd` an exact cost rather than an estimate —
 * the same rule `spendOfError` applies to a failed prompt. Anything else is
 * zero spend, as before: a `complete()` hop that carries no spend really did
 * reach nothing.
 */
export function completeHopSpend(err: unknown): CompleteHopSpend {
  if (err instanceof SessionTurnError && err.tokenUsage !== undefined) {
    return {
      tokenUsage: err.tokenUsage,
      estimatedCostUsd: err.estimatedCostUsd ?? 0,
      ...(err.exactCostUsd === undefined ? {} : { exactCostUsd: err.exactCostUsd }),
    };
  }
  const spend = readTurnSpend(err);
  if (spend === undefined) {
    return { tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
  }
  return {
    tokenUsage: spend.tokenUsage,
    estimatedCostUsd: spend.costUsd,
    ...(spend.costSource === "reported" ? { exactCostUsd: spend.costUsd } : {}),
  };
}
