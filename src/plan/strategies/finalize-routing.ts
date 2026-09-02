import { resolveAgentAssignment } from "@/agents";
import type { AgentRoutingConfig, ModelsConfig } from "@/config";
import type { PRD, StoryRouting } from "@/prd/types";

/**
 * Mode-agnostic post-step that resolves each story's agentProfileId to a
 * concrete agent + tier, stamps origin fields (initialAgent / initialProfileId),
 * and records the config-profile name at PRD root.
 *
 * Pure function — never mutates the input PRD.
 */
export function finalizePrdRouting(
  prd: PRD,
  agentRouting: AgentRoutingConfig | undefined,
  profileName: string | undefined,
  models: ModelsConfig,
  defaultAgent: string,
): PRD {
  const userStories = prd.userStories.map((story) => {
    const assignment = resolveAgentAssignment(
      story.routing?.agentProfileId,
      agentRouting,
      story.id,
      models,
      defaultAgent,
    );
    if (!assignment) return story;
    // story.routing is guaranteed to be defined if assignment resolved (routing
    // has complexity required by StoryRouting); cast to satisfy TypeScript.
    const routing = {
      ...story.routing,
      agent: assignment.agent,
      agentProfileId: assignment.agentProfileId,
      ...(assignment.profileModelTier !== undefined ? { profileModelTier: assignment.profileModelTier } : {}),
      ...(assignment.profileModelPin !== undefined ? { profileModelPin: assignment.profileModelPin } : {}),
      initialAgent: story.routing?.initialAgent ?? assignment.agent,
      initialProfileId: story.routing?.initialProfileId ?? assignment.agentProfileId,
      ...((story.routing?.initialModelTier ?? assignment.profileModelTier)
        ? { initialModelTier: story.routing?.initialModelTier ?? assignment.profileModelTier }
        : {}),
      ...((story.routing?.initialModelPin ?? assignment.profileModelPin)
        ? { initialModelPin: story.routing?.initialModelPin ?? assignment.profileModelPin }
        : {}),
    } as StoryRouting;
    return { ...story, routing };
  });

  return { ...prd, userStories, routingProfile: profileName ?? "default" };
}
