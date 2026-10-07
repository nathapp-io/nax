/**
 * ACP output helpers — acpx response extraction and token/cost assembly.
 * Extracted from adapter.ts; the shared parts moved to agents/ in S4b-1.
 */

import type { ITokenUsageMapper, RateCard, TokenUsage } from "../cost";
import { priceCall } from "../cost";
import { assembleTurnResult } from "../turn";
import type { InteractionExchange, TurnResult } from "../types";
import type { AcpSessionResponse } from "./adapter-session-types";
import type { SessionTokenUsage } from "./wire-types";

// ─────────────────────────────────────────────────────────────────────────────
// Response output helpers
// ─────────────────────────────────────────────────────────────────────────────

export function extractOutput(response: { messages: Array<{ role: string; content: string }> } | null): string {
  if (!response) return "";
  return response.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn result assembly (US-001)
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildTurnResultInput {
  /** Final ACP response from the last turn — null when the turn timed out or aborted. */
  lastResponse: AcpSessionResponse | null;
  /** Accumulated token usage across all turns. */
  totalTokenUsage: TokenUsage;
  /** Accumulated exact cost from `exactCostUsd` events (undefined when wire never reported). */
  totalExactCostUsd: number | undefined;
  /** Number of `session.prompt()` calls made. */
  turnCount: number;
  /** Mid-turn human-in-the-loop exchanges (issue #1226). */
  interactions: readonly InteractionExchange[];
  /** True when sendTurn returned because the wall-clock timeout elapsed (US-001). */
  timedOut: boolean;
  /** Resolved rate card (US-002). Replaces `modelDef` so `buildTurnResult` prices from `rateCard.rates` and stamps `rateCard.source` on `pricingSource`. */
  rateCard: RateCard;
}

/**
 * Token/cost math shared by complete()'s success and cancelled-but-billable
 * paths. US-002: prices from the resolved rate card rather than the model
 * string, so both paths bill on the card `complete()` resolved once.
 *
 * US-002: also stamps `rates` (the post-tier, post-fallback
 * `PricingRates`) onto the returned shape whenever nonzero usage let
 * `priceCall` run. Zero usage skips pricing entirely — the field is
 * omitted (not set to undefined, not zeroed) so the nonzero-usage guard
 * stays visible to the downstream cost subscriber.
 *
 * Extracted from `adapter.ts` so the body of `complete()` could move under
 * the file-size cap — the helper has no `this` dependency.
 */
export function deriveTokenUsage(
  wire: SessionTokenUsage | undefined,
  rateCard: RateCard,
  mapper: ITokenUsageMapper<SessionTokenUsage>,
): {
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  rates: ReturnType<typeof priceCall>["resolvedRates"] | undefined;
} {
  const tokenUsage = wire ? mapper.toInternal(wire) : { inputTokens: 0, outputTokens: 0 };
  const nonzeroUsage = tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0;
  // Single `priceCall` invocation: `costUsd` and `resolvedRates` come from
  // the same call so they cannot diverge — same verifiability concern as
  // `buildTurnResult` above.
  const priced = nonzeroUsage ? priceCall(tokenUsage, rateCard.rates) : undefined;
  return {
    tokenUsage,
    estimatedCostUsd: priced?.costUsd ?? 0,
    // US-002: same nonzero-usage guard as the cost itself. `rates` is only
    // populated when pricing ran, so the field's absence encodes
    // "did not price".
    rates: priced?.resolvedRates,
  };
}

/**
 * acpx wrapper over the shared `assembleTurnResult` (S4b-1, D1-d): reads the
 * assistant text off the acpx response shape. Deleted with agents/acp/ in S4b-5.
 */
export function buildTurnResult(input: BuildTurnResultInput): TurnResult {
  const { lastResponse, ...rest } = input;
  return assembleTurnResult({ ...rest, output: extractOutput(lastResponse) });
}
