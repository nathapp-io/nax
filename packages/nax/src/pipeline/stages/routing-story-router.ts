import type { NaxConfig } from "@/config";
import type { Logger } from "@/logger";
import type { UserStory } from "@/prd";
import type { consultStoryRouter } from "@/routing";
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

/** Consult eligible stories, returning usability independently of story eligibility. */
export async function consultEligibleStoryRouter(
  ctx: PipelineContext,
  consult: typeof consultStoryRouter,
  logger: Logger,
): Promise<boolean> {
  const usable = isStoryRouterUsable(ctx.config, ctx.story.id, logger);
  if (shouldConsultStoryRouter(usable, ctx.story)) {
    await consult(ctx.story, ctx.config, ctx.plugins, ctx);
  }
  return usable;
}
