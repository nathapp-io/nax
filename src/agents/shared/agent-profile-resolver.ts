import type { AgentRoutingConfig, AgentRoutingProfile, ModelsConfig, ModelTier } from "@/config";
import { MODEL_SHORTHAND_TIERS, resolveTierMembership } from "@/config";
import { getSafeLogger } from "@/logger";

const NATIVE_AGENT = "native";

export interface ResolvedAgentAssignment {
  agent: string;
  agentProfileId: string;
  /** Set when the profile target names a tier for its agent. Mutually exclusive with profileModelPin. */
  profileModelTier?: ModelTier;
  /** Set when the profile target names a literal model. Mutually exclusive with profileModelTier. */
  profileModelPin?: string;
}

export function resolveAgentAssignment(
  selectedProfileId: string | undefined,
  agentRouting: AgentRoutingConfig | undefined,
  storyId: string,
  models: ModelsConfig,
  defaultAgent: string,
): ResolvedAgentAssignment | null {
  if (agentRouting?.enabled !== true) return null;

  const profiles = agentRouting.profiles ?? [];
  if (profiles.length === 0) return null;

  const defaultProfile = agentRouting.default ? profiles.find((p) => p.id === agentRouting.default) : undefined;

  if (selectedProfileId) {
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (profile) return toAssignment(profile, models, defaultAgent);

    getSafeLogger()?.warn(
      "routing",
      `Story ${storyId} selected unknown agent profile "${selectedProfileId}" — falling back to ${
        defaultProfile ? `default profile "${defaultProfile.id}"` : "no profile"
      }`,
      { storyId, agentProfileId: selectedProfileId },
    );
  }

  return defaultProfile ? toAssignment(defaultProfile, models, defaultAgent) : null;
}

function toAssignment(p: AgentRoutingProfile, models: ModelsConfig, defaultAgent: string): ResolvedAgentAssignment {
  const targetModel = MODEL_SHORTHAND_TIERS[p.target.model.toLowerCase()] ?? p.target.model;
  const membership = resolveTierMembership(models, p.target.agent, targetModel, defaultAgent);
  if (!membership.isTier) {
    return { agent: p.target.agent, agentProfileId: p.id, profileModelPin: p.target.model };
  }
  if (membership.viaDefaultAgentFallback && (p.target.agent === NATIVE_AGENT) !== (defaultAgent === NATIVE_AGENT)) {
    // Spec §2 step 2: the fallback-resolved entry may name a provider this agent's protocol cannot serve.
    getSafeLogger()?.warn("routing", "Profile tier resolves only via the default agent across a protocol boundary", {
      profileId: p.id,
      agent: p.target.agent,
      tier: targetModel,
      defaultAgent,
    });
  }
  return { agent: p.target.agent, agentProfileId: p.id, profileModelTier: targetModel };
}
