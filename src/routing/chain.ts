/**
 * Strategy Chain
 *
 * Executes routing strategies in order, falling through on null returns.
 * First strategy to return a non-null decision wins.
 */

import type { UserStory } from "../prd/types";
import type { RoutingStrategy, RoutingContext, RoutingDecision } from "./strategy";

/**
 * Strategy chain that tries strategies in order until one returns a decision.
 *
 * @example
 * ```ts
 * const chain = new StrategyChain([customStrategy, adaptiveStrategy, keywordStrategy]);
 * const decision = chain.route(story, context);
 * // Tries custom first, then adaptive, then keyword
 * // Returns first non-null decision
 * ```
 */
export class StrategyChain {
  constructor(private readonly strategies: RoutingStrategy[]) {}

  /**
   * Route a story through the strategy chain.
   *
   * Tries each strategy in order:
   * - If strategy returns a decision → use it
   * - If strategy returns null → try next strategy
   * - If all strategies return null → throw error
   *
   * @param story - User story to route
   * @param context - Routing context
   * @returns Routing decision from first strategy that handles it
   * @throws Error if no strategy returns a decision
   */
  async route(story: UserStory, context: RoutingContext): Promise<RoutingDecision> {
    for (const strategy of this.strategies) {
      const decision = await strategy.route(story, context);
      if (decision !== null) {
        return decision;
      }
    }

    // This should never happen if keyword strategy is last (it never returns null)
    throw new Error(
      `No routing strategy returned a decision for story ${story.id}. ` +
      `Ensure at least one fallback strategy (e.g., keyword) is in the chain.`
    );
  }

  /**
   * Get the list of strategy names in this chain.
   *
   * @returns Array of strategy names
   */
  getStrategyNames(): string[] {
    return this.strategies.map((s) => s.name);
  }
}
