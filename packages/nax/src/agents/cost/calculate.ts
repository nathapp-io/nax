/**
 * Cost calculation helpers for all agent adapters.
 *
 * US-003 removed the table-backed `MODEL_PRICING` lookup. Every price
 * estimate now flows through `estimateCostUsd` (./estimate) with a
 * rate card resolved by `./rate-card.ts`. The helpers that remain here
 * are pure, allocator-free utilities shared across the cost subsystem:
 * `formatCostWithConfidence` and `resolvePricingSource`. The shared usage
 * arithmetic is re-exported from `./usage-math`.
 */

import type { CostEstimate } from "./types";

export { addTokenUsage, inputClassTokens } from "@nathapp/nax-agent";

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
