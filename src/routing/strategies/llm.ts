/**
 * LLM-Based Routing Strategy
 *
 * Placeholder for v0.3 LLM classifier integration.
 * Currently returns null (delegates to next strategy).
 */

import type { RoutingStrategy, RoutingContext, RoutingDecision } from "../strategy";
import type { UserStory } from "../../prd/types";

/**
 * LLM-based routing strategy.
 *
 * This strategy will use an LLM to classify complexity and select model tier.
 * Implementation planned for v0.3.
 *
 * Current behavior: Always returns null (delegates to next strategy)
 */
export const llmStrategy: RoutingStrategy = {
  name: "llm",

  route(_story: UserStory, _context: RoutingContext): RoutingDecision | null {
    // TODO v0.3: Implement LLM classification
    // - Call LLM with story context
    // - Parse structured output (complexity, reasoning, estimated cost/LOC)
    // - Map to model tier
    // - Return decision

    // For now, delegate to next strategy
    return null;
  },
};
