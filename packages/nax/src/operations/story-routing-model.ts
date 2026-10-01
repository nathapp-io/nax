/**
 * The model an op should run a story at.
 *
 * Shared by the implementer and every rectification op. The rectification ops
 * declared no `model` at all, so `callOp` substituted the literal `"balanced"` and
 * they inherited the story's AGENT but neither its escalated tier nor its profile
 * pin — on an escalated attempt the implementer ran at `powerful` while the
 * rectifier silently dropped to `balanced` (nax#1967).
 *
 * `RectificationConfigSchema` deliberately has no model field: rectification
 * tracks the implementer rather than being configured against it.
 */

import type { ConfiguredModel } from "../config";
import type { UserStory } from "../prd";

export function storyRoutingModel(story: UserStory): ConfiguredModel | undefined {
  const routing = story.routing;
  // A literal profile pin selects its own agent's exact model; otherwise escalation
  // mutates modelTier in the PRD before re-dispatch. Ad-hoc callers without routing
  // return undefined, so callOp uses its default tier.
  if (routing?.profileModelPin !== undefined && routing.agent !== undefined) {
    return { agent: routing.agent, model: routing.profileModelPin };
  }
  return routing?.modelTier;
}
