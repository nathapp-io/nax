import type { NaxConfig } from "@/config";
import type { Logger } from "@/logger";
import type { StoryRouterDecision, StoryRouting, UserStory } from "@/prd";
import type { consultStoryRouter, StoryRouterOutcome } from "@/routing";
import type { PipelineContext } from "../types";

/** Usability also controls whether legacy plugin routers must be skipped. */
export function isStoryRouterUsable(config: NaxConfig, storyId: string, logger: Logger): boolean {
  const mode = config.routing.router?.mode ?? "off";
  if (mode === "off") return false;

  const agents = config.routing.agents;
  const usable = agents?.enabled === true && (agents.profiles?.length ?? 0) > 0;
  if (!usable) {
    logger.warnOnce("routing", "Story router enabled but routing.agents is disabled or has no profiles", {
      storyId,
    });
  }
  return usable;
}

/** Keep eligibility separate from usability: retries still skip legacy routers. */
export function shouldConsultStoryRouter(usable: boolean, story: UserStory): boolean {
  return usable && (story.escalations?.length ?? 0) === 0 && story.routing?.routerDecision === undefined;
}

interface StoryRouterConsultation {
  usable: boolean;
  mode?: "shadow" | "apply";
  plannedProfileId?: string;
  outcome?: StoryRouterOutcome;
}

/** Snapshot the plan before invoking plugin code; eligibility is independent of usability. */
export async function consultEligibleStoryRouter(
  ctx: PipelineContext,
  consult: typeof consultStoryRouter,
  logger: Logger,
): Promise<StoryRouterConsultation> {
  const usable = isStoryRouterUsable(ctx.config, ctx.story.id, logger);
  const mode = ctx.config.routing.router?.mode ?? "off";
  if (!shouldConsultStoryRouter(usable, ctx.story) || mode === "off") return { usable };
  const plannedProfileId = ctx.story.routing?.agentProfileId;
  const outcome = await consult(ctx.story, ctx.config, ctx.plugins, ctx);
  return { usable, mode, plannedProfileId, outcome };
}

/** Return a write-back patch; transient failures are logged but leave routing untouched for retries. */
export function recordStoryRouterDecision(
  storyId: string,
  consultation: StoryRouterConsultation,
  logger: Logger,
): Pick<StoryRouting, "routerDecision"> {
  const { outcome, mode, plannedProfileId } = consultation;
  if (!outcome || outcome.kind === "no-router" || !mode) return {};
  if (outcome.kind === "error" || outcome.kind === "timeout") {
    logger.warn("routing", "routing.router.failed", {
      storyId,
      mode,
      router: outcome.router,
      outcome: outcome.kind,
      ...(outcome.kind === "error" && { message: outcome.message }),
      latencyMs: outcome.latencyMs,
    });
    return {};
  }
  const decision: StoryRouterDecision = {
    mode,
    router: outcome.router,
    outcome: outcome.kind,
    ...(outcome.kind !== "declined" && { profileId: outcome.profileId }),
    ...(outcome.kind === "picked" && outcome.confidence !== undefined && { confidence: outcome.confidence }),
    ...(plannedProfileId !== undefined && { plannedProfileId }),
    applied: false,
    decidedAt: new Date().toISOString(),
  };
  logStoryRouterDecision(storyId, { decision, latencyMs: outcome.latencyMs }, logger);
  return { routerDecision: decision };
}

function logStoryRouterDecision(
  storyId: string,
  { decision, latencyMs }: { decision: StoryRouterDecision; latencyMs: number },
  logger: Logger,
): void {
  logger.info("routing", "routing.router.decision", {
    storyId,
    mode: decision.mode,
    router: decision.router,
    outcome: decision.outcome,
    plannedProfileId: decision.plannedProfileId,
    routerProfileId: decision.profileId,
    confidence: decision.confidence,
    applied: decision.applied,
    latencyMs,
  });
}
