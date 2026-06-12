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
 * Matches the current rung by (tier, agent) tuple so that cross-agent ladders
 * with repeated tier names (e.g. opencode@balanced → claude@balanced → claude@powerful)
 * advance correctly instead of always anchoring on the first matching tier name.
 *
 * @param currentRung - Current rung as { tier, agent? }
 * @param tierOrder - Ordered tier config array from config (e.g., [{tier:"fast",attempts:5}, ...])
 * @returns Next tier and agent, or null if at max tier
 *
 * @example
 * ```typescript
 * const tiers = [{tier:"fast",agent:"claude",attempts:3}, {tier:"balanced",agent:"claude",attempts:2}];
 * escalateTier({ tier: "fast", agent: "claude" }, tiers);    // => { tier: "balanced", agent: "claude" }
 * escalateTier({ tier: "balanced", agent: "claude" }, tiers); // => null
 * ```
 */
export function escalateTier(
  currentRung: { tier: string; agent?: string },
  tierOrder: TierConfig[],
): EscalateTierResult | null {
  // When agent is specified, match by (tier, agent) tuple to correctly navigate
  // cross-agent ladders where the same tier name appears for multiple agents.
  // When agent is omitted, fall back to tier-name-only matching (first match).
  const i =
    currentRung.agent !== undefined
      ? tierOrder.findIndex((t) => t.tier === currentRung.tier && t.agent === currentRung.agent)
      : tierOrder.findIndex((t) => t.tier === currentRung.tier);
  if (i === -1 || i === tierOrder.length - 1) return null;
  const next = tierOrder[i + 1];
  return { tier: next.tier, agent: next.agent };
}

/**
 * Get the tier config for a given rung.
 *
 * When agent is provided, matches by (tier, agent) tuple so cross-agent ladders
 * with repeated tier names return the correct rung's attempt budget.
 * When agent is omitted, falls back to tier-name-only matching (first match).
 */
export function getTierConfig(rung: { tier: string; agent?: string }, tierOrder: TierConfig[]): TierConfig | undefined {
  return rung.agent !== undefined
    ? tierOrder.find((t) => t.tier === rung.tier && t.agent === rung.agent)
    : tierOrder.find((t) => t.tier === rung.tier);
}

/**
 * Calculate total max iterations from tier order (sum of all attempts).
 */
export function calculateMaxIterations(tierOrder: TierConfig[]): number {
  return tierOrder.reduce((sum, t) => sum + t.attempts, 0);
}
