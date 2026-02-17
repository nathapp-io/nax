/**
 * Manual Routing Strategy
 *
 * Reads routing decision from story.routing metadata in prd.json.
 * Users can manually specify complexity, modelTier, and testStrategy per story.
 */

import type { RoutingStrategy, RoutingContext, RoutingDecision } from "../strategy";
import type { UserStory } from "../../prd/types";

/**
 * Manual routing strategy.
 *
 * If story.routing is present in prd.json, uses that data directly.
 * Otherwise returns null (delegates to next strategy).
 *
 * Use case: Override routing for specific stories that need manual control.
 *
 * @example
 * ```json
 * {
 *   "id": "US-001",
 *   "title": "Critical database migration",
 *   "routing": {
 *     "complexity": "expert",
 *     "modelTier": "powerful",
 *     "testStrategy": "three-session-tdd",
 *     "reasoning": "Manually specified: critical migration"
 *   }
 * }
 * ```
 */
export const manualStrategy: RoutingStrategy = {
  name: "manual",

  route(story: UserStory, _context: RoutingContext): RoutingDecision | null {
    // If story has routing metadata with all required fields, use it
    if (
      story.routing &&
      story.routing.complexity &&
      story.routing.modelTier &&
      story.routing.testStrategy
    ) {
      return {
        complexity: story.routing.complexity,
        modelTier: story.routing.modelTier,
        testStrategy: story.routing.testStrategy,
        reasoning: story.routing.reasoning || "Manual routing from prd.json",
      };
    }

    // No manual routing specified, delegate to next strategy
    return null;
  },
};
