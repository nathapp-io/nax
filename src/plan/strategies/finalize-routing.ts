import { resolveAgentAssignment } from "@/agents";
import type { AgentRoutingConfig, ModelsConfig } from "@/config";
import type { PRD, StoryRouting } from "@/prd/types";

/**
 * Mode-agnostic post-step that resolves each story's agentProfileId to a
 * concrete agent + tier, stamps origin fields (initialAgent / initialProfileId),
 * and records the config-profile name at PRD root.
 *
 * `only`, when given, restricts resolution to those story ids; every other story
 * is returned by identity. `routingProfile` is stamped regardless -- it is a PRD
 * property, not a story one.
 *
 * `preserveExistingAgent` keeps an already selected active agent while still
 * resolving unassigned stories. Decomposition uses this for children that inherit
 * a parent's escalated assignment (ADR-025).
 *
 * Pure function — never mutates the input PRD.
 */
export function finalizePrdRouting(
  prd: PRD,
  agentRouting: AgentRoutingConfig | undefined,
  profileName: string | undefined,
  models: ModelsConfig,
  defaultAgent: string,
  only?: ReadonlySet<string>,
  preserveExistingAgent = false,
): PRD {
  const userStories = prd.userStories.map((story) => {
    // nax#2080: a scoped write (decompose) adds stories to a PRD that may already
    // be executing. Re-resolving an existing story would overwrite `routing.agent`
    // from current config, resetting an escalated story's recorded agent back to
    // its profile default -- `initialAgent` is sticky, but `agent` is not.
    if (only && !only.has(story.id)) return story;

    const assignment = resolveAgentAssignment(
      story.routing?.agentProfileId,
      agentRouting,
      story.id,
      models,
      defaultAgent,
    );
    if (!assignment) return story;
    const agent = preserveExistingAgent && story.routing?.agent !== undefined ? story.routing.agent : assignment.agent;
    // story.routing is guaranteed to be defined if assignment resolved (routing
    // has complexity required by StoryRouting); cast to satisfy TypeScript.
    const routing = {
      ...story.routing,
      agent,
      agentProfileId: assignment.agentProfileId,
      ...(assignment.profileModelTier !== undefined ? { profileModelTier: assignment.profileModelTier } : {}),
      ...(assignment.profileModelPin !== undefined ? { profileModelPin: assignment.profileModelPin } : {}),
      initialAgent: story.routing?.initialAgent ?? agent,
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
