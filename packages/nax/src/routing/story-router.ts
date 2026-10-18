import { errorMessage } from "@nathapp/nax-agent/internal";
import { type NaxConfig, StoryRouterConfigSchema } from "@/config";
import type { PluginRegistry } from "@/plugins";
import type { UserStory } from "@/prd";
import type { DispatchContext } from "@/runtime";
import type { RoutingDecision } from "./decision";

export type StoryRouterOutcome =
  | { kind: "no-router" }
  | { kind: "picked"; router: string; profileId: string; confidence?: number; reasoning: string; latencyMs: number }
  | { kind: "declined"; router: string; latencyMs: number }
  | { kind: "unknown-profile"; router: string; profileId: string; latencyMs: number }
  | { kind: "error"; router: string; message: string; latencyMs: number }
  | { kind: "timeout"; router: string; latencyMs: number };

function decisionOutcome(
  decision: RoutingDecision | null,
  config: NaxConfig,
  details: { router: string; latencyMs: number },
): StoryRouterOutcome {
  const profileId = decision?.agentProfileId;
  if (!decision || typeof profileId !== "string" || profileId.trim().length === 0)
    return { kind: "declined", ...details };
  if (!config.routing.agents?.profiles.some((profile) => profile.id === profileId)) {
    return { kind: "unknown-profile", profileId, ...details };
  }
  const confidence = decision?.confidence;
  return {
    kind: "picked",
    profileId,
    ...details,
    reasoning: decision.reasoning,
    ...(typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
      ? { confidence }
      : {}),
  };
}

export const _storyRouterDeps = {
  now: () => performance.now(),
  // Cancellable deadline exception: the losing timer must not outlive consultation.
  setTimer: (callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> | number =>
    setTimeout(callback, timeoutMs),
  clearTimer: (timer: ReturnType<typeof setTimeout> | number | undefined): void => clearTimeout(timer),
};

/** Consult only the first router; plugin failures never block routing. */
export async function consultStoryRouter(
  story: UserStory,
  config: NaxConfig,
  plugins: PluginRegistry | undefined,
  context: DispatchContext,
): Promise<StoryRouterOutcome> {
  const router = plugins?.getRouters()[0];
  if (!router) return { kind: "no-router" };
  const timeoutMs = config.routing.router?.timeoutMs ?? StoryRouterConfigSchema.parse({}).timeoutMs;
  let timer: ReturnType<typeof _storyRouterDeps.setTimer> | undefined;
  const timeout = Symbol("router-timeout");
  const deadline = new Promise<typeof timeout>((resolve) => {
    // Cancellable deadline: clearTimeout in finally prevents a losing timer outliving the call.
    timer = _storyRouterDeps.setTimer(() => resolve(timeout), timeoutMs);
  });
  const started = _storyRouterDeps.now();
  try {
    const decision = await Promise.race([router.route(story, { ...context, config }), deadline]);
    const details = { router: router.name, latencyMs: _storyRouterDeps.now() - started };
    return decision === timeout ? { kind: "timeout", ...details } : decisionOutcome(decision, config, details);
  } catch (error) {
    return {
      kind: "error",
      router: router.name,
      message: errorMessage(error),
      latencyMs: _storyRouterDeps.now() - started,
    };
  } finally {
    _storyRouterDeps.clearTimer(timer);
  }
}
