/**
 * Turn-result assembly and the wall-clock timeout warning, shared by both ACP
 * transports. The deadline itself is createTurnDeadline from
 * @nathapp/nax-agent (decision D1-a).
 *
 * Moved out of agents/acp/ in S4b-1.
 */

import { getSafeLogger } from "@/logger";
import type { RateCard, TokenUsage } from "../cost";
import { priceCall } from "../cost";
import type { InteractionExchange, TurnResult } from "../types";

export interface AssembleTurnResultInput {
  /** The last response's assistant text; ignored (forced to "") when timedOut. */
  output: string;
  /** Accumulated token usage across all turns. */
  totalTokenUsage: TokenUsage;
  /** Accumulated wire-reported exact cost (undefined when the transport never reported one). */
  totalExactCostUsd: number | undefined;
  /** Number of prompt round trips made. */
  turnCount: number;
  /** Mid-turn human-in-the-loop exchanges (issue #1226). */
  interactions: readonly InteractionExchange[];
  /** True when the turn returned because the wall-clock timeout elapsed (US-001). */
  timedOut: boolean;
  /** Resolved rate card (US-002). */
  rateCard: RateCard;
}

/**
 * Build a `TurnResult` from the accumulated session-turn bookkeeping.
 * Extracted from `AcpAgentAdapter.sendTurn()` so the timeout transport fact
 * (`timedOut`) is set in exactly one place (US-001 AC1/AC2/AC3).
 *
 * When `timedOut` is true, output is forced to "" regardless of the `output`
 * passed in — the wall-clock timeout must not leak partial agent output
 * into the policy layer.
 *
 * US-002: `estimatedCostUsd` is priced from `rateCard.rates` and
 * `pricingSource` reports `rateCard.source`. `exactCostUsd` is untouched by
 * the card — a wire-reported cost passes through unchanged, and the cost
 * middleware is what decides "wire" wins over the card's source.
 *
 * US-002: `rates` is the post-tier, post-fallback `PricingRates` returned
 * by `priceCall`. The field is OMITTED (not undefined, not zeroed) when
 * the accumulated tokens are zero, so the nonzero-usage guard stays visible
 * to the cost subscriber — "did not price" and "priced at zero" stay
 * distinguishable on the result.
 */
export function assembleTurnResult(input: AssembleTurnResultInput): TurnResult {
  const { totalTokenUsage, totalExactCostUsd, turnCount, interactions, timedOut, rateCard } = input;
  const output = timedOut ? "" : input.output;
  const hasUsage = totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0;
  // Single `priceCall` invocation: both `costUsd` and `resolvedRates` come
  // from the same call so they cannot diverge — the verifiability property
  // the story names ("recorded rates reproduce recorded cost") would
  // silently break if tier selection ever grew a side channel.
  const priced = hasUsage ? priceCall(totalTokenUsage, rateCard.rates) : undefined;
  return {
    output,
    tokenUsage: totalTokenUsage,
    estimatedCostUsd: priced?.costUsd ?? 0,
    exactCostUsd: totalExactCostUsd,
    internalRoundTrips: turnCount,
    ...(interactions.length > 0 ? { interactions } : {}),
    timedOut,
    pricingSource: rateCard.source,
    // US-002: forward the four per-1M rates that priced the turn. Omitted
    // when the nonzero-usage guard skipped pricing — see comment above.
    ...(priced?.resolvedRates !== undefined ? { rates: priced.resolvedRates } : {}),
  };
}

/**
 * Explicit log to distinguish a wall-clock timeout from the idle watchdog
 * (fail-stale). Shared by sendTurn's pre-flight deadline check and its
 * per-turn prompt timeout branch.
 */
export function warnWallClockTimeout(sessionName: string, timeoutSeconds: number, stage: string): void {
  getSafeLogger()?.warn(stage, "wall-clock timeout exceeded — session terminated", {
    sessionName,
    timeoutSeconds,
  });
}
