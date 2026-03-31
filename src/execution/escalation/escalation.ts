/**
 * Model Tier Escalation (ADR-003)
 *
 * Handles escalating model tiers through configurable tier chain
 * with per-tier attempt budgets.
 */

import type { TierConfig } from "../../config";

/** Result of escalateTier — includes both the next tier name and optional next agent. */
export interface EscalateTierResult {
  tier: string;
  agent?: string;
}

/**
 * Escalate to the next tier in the configured order.
 *
 * @param currentTier - Current tier name
 * @param tierOrder - Ordered tier config array from config (e.g., [{tier:"fast",attempts:5}, ...])
 * @returns Next tier and agent, or null if at max tier
 *
 * @example
 * ```typescript
 * const tiers = [{tier:"fast",agent:"claude",attempts:3}, {tier:"balanced",agent:"claude",attempts:2}];
 * escalateTier("fast", tiers);    // => { tier: "balanced", agent: "claude" }
 * escalateTier("balanced", tiers); // => null
 * ```
 */
export function escalateTier(currentTier: string, tierOrder: TierConfig[]): EscalateTierResult | null {
  const getName = (t: TierConfig) => t.tier ?? (t as unknown as { name?: string }).name ?? null;
  const currentIndex = tierOrder.findIndex((t) => getName(t) === currentTier);
  if (currentIndex === -1 || currentIndex === tierOrder.length - 1) {
    return null;
  }
  const next = tierOrder[currentIndex + 1];
  const nextName = getName(next);
  if (!nextName) return null;
  return { tier: nextName, agent: next.agent };
}

/**
 * Get the tier config for a given tier name.
 */
export function getTierConfig(tierName: string, tierOrder: TierConfig[]): TierConfig | undefined {
  const getName = (t: TierConfig) => t.tier ?? (t as unknown as { name?: string }).name ?? null;
  return tierOrder.find((t) => getName(t) === tierName);
}

/**
 * Calculate total max iterations from tier order (sum of all attempts).
 */
export function calculateMaxIterations(tierOrder: TierConfig[]): number {
  return tierOrder.reduce((sum, t) => sum + t.attempts, 0);
}
