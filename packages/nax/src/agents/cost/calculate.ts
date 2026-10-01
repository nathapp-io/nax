/**
 * Cost calculation helpers for all agent adapters.
 *
 * US-003 removed the table-backed `MODEL_PRICING` lookup. Every price
 * estimate now flows through `estimateCostUsd` (./estimate) with a
 * rate card resolved by `./rate-card.ts`. The helpers that remain here
 * are pure, allocator-free utilities shared across the cost subsystem:
 * `addTokenUsage`, `formatCostWithConfidence`, `inputClassTokens` and
 * `resolvePricingSource`.
 */

import type { CostEstimate, TokenUsage } from "./types";

/**
 * Format cost estimate with confidence indicator for display.
 *
 * @param estimate - Cost estimate with confidence level
 * @returns Formatted cost string with confidence indicator
 *
 * @example
 * ```ts
 * formatCostWithConfidence({ cost: 0.12, confidence: 'exact' });
 * // "$0.12"
 *
 * formatCostWithConfidence({ cost: 0.15, confidence: 'estimated' });
 * // "~$0.15"
 *
 * formatCostWithConfidence({ cost: 0.05, confidence: 'fallback' });
 * // "~$0.05 (duration-based)"
 * ```
 */
export function formatCostWithConfidence(estimate: CostEstimate): string {
  const formattedCost = `$${estimate.cost.toFixed(2)}`;

  switch (estimate.confidence) {
    case "exact":
      return formattedCost;
    case "estimated":
      return `~${formattedCost}`;
    case "fallback":
      return `~${formattedCost} (duration-based)`;
  }
}

/** Coerce a token count to a finite number, falling back to 0. Defense in
 * depth (BUG-10): upstream guards in parser.ts / token-mapper.ts should
 * already keep non-numeric values out, but `addTokenUsage` is a cheap pure
 * function reachable from multiple call sites, so it validates its own
 * inputs rather than trusting the static TokenUsage type — a malformed
 * operand (e.g. a stringified number) would otherwise trigger `+`'s string
 * concatenation instead of numeric addition, and a genuinely non-numeric
 * value would propagate NaN into the running total. */
function toFiniteTokenCount(value: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sum two internal TokenUsage values. Pure.
 * Optional cache fields are only included when at least one operand has a defined value,
 * preserving the zero-omit serialization semantics from the original adapter code. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const result: TokenUsage = {
    inputTokens: toFiniteTokenCount(a.inputTokens) + toFiniteTokenCount(b.inputTokens),
    outputTokens: toFiniteTokenCount(a.outputTokens) + toFiniteTokenCount(b.outputTokens),
  };
  // BUG-58: apply the same finite-number guard to the cache fields as
  // inputTokens/outputTokens above — `?? 0` alone only guards undefined/null,
  // not a malformed non-numeric operand (e.g. a stringified number), which
  // would otherwise hit `+`'s string-concatenation behavior here too.
  const cacheRead = toFiniteTokenCount(a.cacheReadInputTokens ?? 0) + toFiniteTokenCount(b.cacheReadInputTokens ?? 0);
  const cacheCreation =
    toFiniteTokenCount(a.cacheCreationInputTokens ?? 0) + toFiniteTokenCount(b.cacheCreationInputTokens ?? 0);
  if (cacheRead > 0 || a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined) {
    result.cacheReadInputTokens = cacheRead;
  }
  if (cacheCreation > 0 || a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined) {
    result.cacheCreationInputTokens = cacheCreation;
  }
  return result;
}

/**
 * Which rate card the caller would use for `model`.
 *
 * US-003 deleted the table-backed `MODEL_PRICING[model]` lookup; every
 * non-empty, non-undefined, non-`"unknown"` model name therefore returns
 * `"fallback-rates"`. The producer (native / catalog) carries its own
 * `pricingSource` value on `CompleteResult` / `TurnResult`, which the cost
 * subscriber in `@/runtime/middleware/cost` prefers when supplied. This
 * function exists to serve the path that has no producer-supplied source.
 *
 * The return union still admits `"catalog-rates"` and `"config-override"`
 * so producer-supplied values type-check through the cost subscriber
 * unchanged. This function itself never returns those values; it only
 * classifies between the three options it actually knows about.
 *
 * @param model - Resolved model name, or undefined when nothing resolved one
 * @returns `"unknown-model"` when nothing resolved a model, `"fallback-rates"`
 *          for any non-empty model name now that the table is gone.
 */
export function resolvePricingSource(
  model: string | undefined,
): "model-rates" | "fallback-rates" | "unknown-model" | "catalog-rates" | "config-override" {
  if (model === undefined || model === "" || model === "unknown") return "unknown-model";
  return "fallback-rates";
}

/**
 * Tokens the provider counted as part of the prompt.
 *
 * Cache reads and writes are prompt tokens that the provider reports
 * separately because it prices them differently — not tokens that were
 * absent from the request. Any consumer asking "how big was the prompt"
 * needs all three; `inputTokens` alone answers a different question and,
 * under prompt caching, collapses to near zero (nax#1852).
 *
 * Output is deliberately excluded: this measures the prompt, not the call.
 */
export function inputClassTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}
