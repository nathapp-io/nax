/**
 * Model Tier Escalation (ADR-003)
 *
 * Handles escalating model tiers through configurable tier chain
 * with per-tier attempt budgets.
 */

import type { TierConfig } from "../config";

/**
 * Escalate to the next tier in the configured order.
 *
 * @param currentTier - Current tier name
 * @param tierOrder - Ordered tier config array from config (e.g., [{tier:"fast",attempts:5}, ...])
 * @returns Next tier name, or null if at max tier
 *
 * @example
 * ```typescript
 * const tiers = [{tier:"fast",attempts:5}, {tier:"balanced",attempts:3}, {tier:"powerful",attempts:2}];
 * escalateTier("fast", tiers);    // => "balanced"
 * escalateTier("powerful", tiers); // => null
 * ```
 */
export function escalateTier(currentTier: string, tierOrder: TierConfig[]): string | null {
  const currentIndex = tierOrder.findIndex((t) => t.tier === currentTier);
  if (currentIndex === -1 || currentIndex === tierOrder.length - 1) {
    return null;
  }
  return tierOrder[currentIndex + 1].tier;
}

/**
 * Get the tier config for a given tier name.
 */
export function getTierConfig(tierName: string, tierOrder: TierConfig[]): TierConfig | undefined {
  return tierOrder.find((t) => t.tier === tierName);
}

/**
 * Calculate total max iterations from tier order (sum of all attempts).
 */
export function calculateMaxIterations(tierOrder: TierConfig[]): number {
  return tierOrder.reduce((sum, t) => sum + t.attempts, 0);
}
