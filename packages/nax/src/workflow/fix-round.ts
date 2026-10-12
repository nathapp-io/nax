/** Model for a fix round (spec §4 "Implementer model"): warm rounds keep the routed model; each fresh round past the warm cap climbs one rung. */
import type { ConfiguredModel, ModelTier, TierConfig } from "@/config";
import { escalateTier } from "@/execution/escalation";
import type { UserStory } from "@/prd";

export function fixModelFor(
  story: UserStory,
  tierOrder: readonly TierConfig[],
  stepUps: number,
): ConfiguredModel | undefined {
  const routing = story.routing;
  if (stepUps <= 0 || !routing?.modelTier || routing.profileModelPin !== undefined) return undefined;
  // Same rule as tier-escalation.ts: match by (tier, agent) only on agent-qualified ladders.
  const hasAgentRungs = tierOrder.some((r) => r.agent !== undefined);
  let rung: { tier: string; agent?: string } = hasAgentRungs
    ? { tier: routing.modelTier, agent: routing.agent }
    : { tier: routing.modelTier };
  for (let i = 0; i < stepUps; i++) {
    const next = escalateTier(rung, [...tierOrder]);
    if (!next) break;
    rung = next;
  }
  if (rung.tier === routing.modelTier && (rung.agent ?? routing.agent) === routing.agent) return undefined;
  return rung.agent !== undefined ? { agent: rung.agent, model: rung.tier as ModelTier } : (rung.tier as ModelTier);
}
