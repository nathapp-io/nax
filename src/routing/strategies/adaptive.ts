/**
 * Adaptive Routing Strategy
 *
 * Uses historical metrics to optimize model tier selection based on cost-effectiveness.
 * Routes to the cheapest tier that maintains acceptable success rates, accounting for
 * escalation costs.
 */

import type { Complexity, ModelTier } from "../../config";
import type { AggregateMetrics } from "../../metrics/types";
import type { UserStory } from "../../prd/types";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../strategy";
import { keywordStrategy } from "./keyword";

/**
 * Estimated costs per model tier (USD per story, approximate).
 * These are rough estimates based on typical story complexity.
 * Actual costs vary based on input/output tokens.
 */
const ESTIMATED_TIER_COSTS: Record<ModelTier, number> = {
  fast: 0.005, // ~$0.005 per simple story
  balanced: 0.02, // ~$0.02 per medium story
  powerful: 0.08, // ~$0.08 per complex story
};

/**
 * Calculate effective cost for a model tier given historical metrics.
 *
 * effectiveCost = baseCost + (failRate × escalationCost)
 *
 * Where:
 * - baseCost = cost of using this tier
 * - failRate = probability of failure (requiring escalation)
 * - escalationCost = cost of escalating to next tier
 *
 * @param tier - Model tier to evaluate
 * @param complexity - Story complexity level
 * @param metrics - Historical aggregate metrics
 * @param tierOrder - Escalation tier order
 * @returns Effective cost (USD)
 */
function calculateEffectiveCost(
  tier: ModelTier,
  complexity: Complexity,
  metrics: AggregateMetrics,
  tierOrder: ModelTier[],
): number {
  const baseCost = ESTIMATED_TIER_COSTS[tier];

  // Get historical pass rate for this tier on this complexity level
  const complexityStats = metrics.complexityAccuracy[complexity];
  if (!complexityStats || complexityStats.predicted < 1) {
    // No data for this complexity level — assume base cost (no escalation)
    return baseCost;
  }

  // Calculate fail rate (stories that needed escalation)
  // mismatchRate = percentage of stories where initial tier != final tier
  const failRate = complexityStats.mismatchRate;

  // Find next tier in escalation chain
  const currentIndex = tierOrder.indexOf(tier);
  const nextTier = currentIndex < tierOrder.length - 1 ? tierOrder[currentIndex + 1] : null;

  if (!nextTier) {
    // Already at highest tier — no escalation possible
    return baseCost;
  }

  // Escalation cost = cost of trying this tier + cost of next tier
  const escalationCost = ESTIMATED_TIER_COSTS[nextTier];

  return baseCost + failRate * escalationCost;
}

/**
 * Find the most cost-effective tier for a given complexity level.
 *
 * Evaluates all tiers in the escalation chain and selects the one with
 * the lowest effective cost (including escalation probability).
 *
 * @param complexity - Story complexity
 * @param metrics - Historical metrics
 * @param tierOrder - Escalation tier order
 * @param costThreshold - Switch threshold (0-1)
 * @returns Best tier and reasoning
 */
function selectOptimalTier(
  complexity: Complexity,
  metrics: AggregateMetrics,
  tierOrder: ModelTier[],
  costThreshold: number,
): { tier: ModelTier; reasoning: string } {
  // Calculate effective cost for each tier
  const costs = tierOrder.map((tier) => ({
    tier,
    effectiveCost: calculateEffectiveCost(tier, complexity, metrics, tierOrder),
  }));

  // Sort by effective cost (lowest first)
  costs.sort((a, b) => a.effectiveCost - b.effectiveCost);

  const optimal = costs[0];
  const complexityStats = metrics.complexityAccuracy[complexity];

  // If the cheapest tier's effective cost is within threshold of next tier, use it
  const reasoning = complexityStats
    ? `adaptive: ${complexity} → ${optimal.tier} (cost: $${optimal.effectiveCost.toFixed(4)}, ` +
      `samples: ${complexityStats.predicted}, mismatch: ${(complexityStats.mismatchRate * 100).toFixed(1)}%)`
    : `adaptive: ${complexity} → ${optimal.tier} (insufficient data, using base cost: $${optimal.effectiveCost.toFixed(4)})`;

  return { tier: optimal.tier, reasoning };
}

/**
 * Check if there's sufficient data for adaptive routing.
 *
 * @param complexity - Story complexity
 * @param metrics - Historical metrics
 * @param minSamples - Minimum samples required
 * @returns True if sufficient data exists
 */
function hasSufficientData(complexity: Complexity, metrics: AggregateMetrics, minSamples: number): boolean {
  const complexityStats = metrics.complexityAccuracy[complexity];
  return Boolean(complexityStats && complexityStats.predicted >= minSamples);
}

/**
 * Adaptive routing strategy.
 *
 * Uses historical metrics to select the most cost-effective model tier.
 * Falls back to configured strategy when insufficient data is available.
 *
 * Algorithm:
 * 1. Check if sufficient historical data exists (>= minSamples)
 * 2. If yes: Calculate effective cost for each tier (base + fail × escalation)
 * 3. Select tier with lowest effective cost
 * 4. If no: Delegate to fallback strategy
 *
 * @example
 * ```ts
 * const decision = adaptiveStrategy.route(story, context);
 * // With sufficient data:
 * // {
 * //   complexity: "medium",
 * //   modelTier: "fast",
 * //   reasoning: "adaptive: medium → fast (cost: $0.0078, samples: 23, mismatch: 12.5%)"
 * // }
 * //
 * // Without sufficient data:
 * // {
 * //   complexity: "medium",
 * //   modelTier: "balanced",
 * //   reasoning: "adaptive: insufficient data (7/10 samples) → fallback to llm"
 * // }
 * ```
 */
export const adaptiveStrategy: RoutingStrategy = {
  name: "adaptive",

  async route(story: UserStory, context: RoutingContext): Promise<RoutingDecision | null> {
    const { config, metrics } = context;

    // Require metrics to be present - use keyword as ultimate fallback
    if (!metrics) {
      const fallbackStrategy = config.routing.adaptive?.fallbackStrategy || "llm";
      const decision = await keywordStrategy.route(story, context); // keyword never returns null
      if (!decision) return null;

      return {
        ...decision,
        reasoning: `adaptive: no metrics available → fallback to ${fallbackStrategy}`,
      };
    }

    // Get adaptive config
    const adaptiveConfig = config.routing.adaptive || {
      minSamples: 10,
      costThreshold: 0.8,
      fallbackStrategy: "llm" as const,
    };

    // First, classify complexity using fallback strategy
    // (We need to know complexity before checking metrics)
    // Always use keyword as the classification source since it never returns null
    const fallbackDecision = await keywordStrategy.route(story, context);
    if (!fallbackDecision) return null;

    const complexity = fallbackDecision.complexity;

    // Check if we have sufficient historical data for this complexity
    if (!hasSufficientData(complexity, metrics, adaptiveConfig.minSamples)) {
      const complexityStats = metrics.complexityAccuracy[complexity];
      const sampleCount = complexityStats?.predicted || 0;

      return {
        ...fallbackDecision,
        reasoning:
          `adaptive: insufficient data (${sampleCount}/${adaptiveConfig.minSamples} samples) ` +
          `→ fallback to ${adaptiveConfig.fallbackStrategy}`,
      };
    }

    // We have sufficient data — calculate optimal tier
    const tierOrder = config.autoMode.escalation.tierOrder.map((t) => t.tier);
    const { tier, reasoning } = selectOptimalTier(complexity, metrics, tierOrder, adaptiveConfig.costThreshold);

    return {
      complexity,
      modelTier: tier,
      testStrategy: fallbackDecision.testStrategy, // Use fallback's test strategy decision
      reasoning,
    };
  },
};
