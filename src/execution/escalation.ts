/**
 * Model Tier Escalation
 *
 * Handles escalating model tiers through configurable 3-tier chain.
 * Default chain: fast → balanced → powerful → null (max tier reached)
 */

import type { ModelTier } from "../config";

/**
 * Escalate model tier through configurable 3-tier chain (default: fast → balanced → powerful → null)
 *
 * @param current - Current model tier
 * @param tierOrder - Optional tier order from config (e.g., ["fast", "balanced", "powerful"])
 * @returns Next tier in chain, or null if at max tier
 *
 * @example
 * ```typescript
 * // Using config tier order
 * const next = escalateTier("fast", ["fast", "balanced", "powerful"]);
 * // => "balanced"
 *
 * // At max tier
 * const maxed = escalateTier("powerful", ["fast", "balanced", "powerful"]);
 * // => null
 *
 * // Fallback to hardcoded chain
 * const fallback = escalateTier("fast");
 * // => "balanced"
 * ```
 */
export function escalateTier(current: ModelTier, tierOrder?: ModelTier[]): ModelTier | null {
  // Use config tierOrder if provided, fallback to hardcoded chain
  if (tierOrder && tierOrder.length > 0) {
    const currentIndex = tierOrder.indexOf(current);
    if (currentIndex === -1 || currentIndex === tierOrder.length - 1) {
      return null; // Not in order or at max tier
    }
    return tierOrder[currentIndex + 1];
  }

  // Fallback: explicit escalation chain
  switch (current) {
    case "fast":
      return "balanced";
    case "balanced":
      return "powerful";
    case "powerful":
      return null; // Max tier reached
    default:
      return null;
  }
}
