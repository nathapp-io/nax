import type { AgentRoutingConfig, AgentRoutingProfile, ModelTier } from "@/config";
import { getSafeLogger } from "@/logger";

export interface ResolvedAgentAssignment {
  agent: string;
  agentProfileId: string;
  profileModelTier: ModelTier;
}

export function resolveAgentAssignment(
  selectedProfileId: string | undefined,
  agentRouting: AgentRoutingConfig | undefined,
  storyId: string,
): ResolvedAgentAssignment | null {
  if (agentRouting?.enabled !== true) return null;

  const profiles = agentRouting.profiles ?? [];
  if (profiles.length === 0) return null;

  const defaultProfile = agentRouting.default ? profiles.find((p) => p.id === agentRouting.default) : undefined;

  if (selectedProfileId) {
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (profile) return toAssignment(profile);

    getSafeLogger()?.warn(
      "routing",
      `Story ${storyId} selected unknown agent profile "${selectedProfileId}" — falling back to ${
        defaultProfile ? `default profile "${defaultProfile.id}"` : "no profile"
      }`,
      { storyId, agentProfileId: selectedProfileId },
    );
  }

  return defaultProfile ? toAssignment(defaultProfile) : null;
}

function toAssignment(p: AgentRoutingProfile): ResolvedAgentAssignment {
  return { agent: p.target.agent, agentProfileId: p.id, profileModelTier: p.target.model };
}
