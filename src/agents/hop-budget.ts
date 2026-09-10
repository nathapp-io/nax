/**
 * Per-story agent-swap budget, and the dead-primary skip that makes it safe.
 *
 * nax#1722: `agent.fallback.maxHopsPerStory` is documented as a per-STORY budget
 * (`src/cli/config-descriptions.ts`, SPEC-context-engine-agent-fallback "Hop counter
 * is per story"), but the counter lived in a local of `runWithFallback`, so it bounded
 * swaps per OPERATION — a story running N ops could take N x the configured cap.
 *
 * Counting per story on its own would strand a story's later ops: `getDefault()`
 * ignores availability, so every op re-probes a primary already known dead, and once
 * the budget is spent it can no longer swap away from it. `resolveStartAgent` closes
 * that: an op whose primary is already unavailable starts on the first live candidate
 * instead. That is not a swap — no failure happened in this op — so it costs no hop.
 *
 * Lives outside manager.ts because that file is at its grandfathered size limit.
 */

import type { FallbackTarget } from "./swap-decision";

/** The `AgentManager` surface `resolveStartAgent` reads. */
export interface StartAgentSource {
  isUnavailable(agent: string, tier?: string, model?: string): boolean;
  nextCandidate(current: string, hopsSoFar: number): FallbackTarget | null;
}

/** Minimal logger surface — `getSafeLogger()` and the manager's override both satisfy it. */
export interface HopBudgetLogger {
  info: (scope: string, msg: string, data?: Record<string, unknown>) => void;
}

/** The endpoint an operation would dispatch to if it started on its primary. */
export interface StartEndpoint {
  readonly tier?: string;
  readonly model?: string;
}

/**
 * Whether the primary is unavailable for the endpoint an operation would actually
 * dispatch to — not the bare agent name: on the native transport one agent fronts
 * several providers, so "native is unavailable" must not be true just because some
 * OTHER tier of it is cooling.
 *
 * Falls back to the bare-agent probe when the narrow one misses and an endpoint was
 * named: a genuinely agent-wide fault (bad credentials, missing binary) and a
 * model-scoped fault whose own identity could not be resolved when it was recorded
 * (no endpoint to key on) both land on the bare agent key, and only a bare query
 * finds either — `CooldownStore` only treats that key as blanket-agent for the
 * former, but a bare *query* still surfaces it either way (see cooldown-store.ts).
 */
function isPrimaryUnavailable(source: StartAgentSource, primary: string, endpoint: StartEndpoint | undefined): boolean {
  if (source.isUnavailable(primary, endpoint?.tier, endpoint?.model)) return true;
  const namedEndpoint = endpoint?.tier !== undefined || endpoint?.model !== undefined;
  return namedEndpoint && source.isUnavailable(primary);
}

/**
 * The fallback target an operation should start on: the configured primary, unless it
 * is already marked unavailable and fallback is enabled, in which case the first live
 * candidate — with its named tier, when it has one.
 *
 * Returns the primary unchanged (as a tier-less target) when fallback is off (the
 * toggle must win), when the primary is healthy, or when no candidate is left — the
 * caller then dispatches to the dead primary and fails, which is the same terminal
 * outcome as before.
 */
export function resolveStartAgent(
  source: StartAgentSource,
  primary: string,
  fallbackEnabled: boolean | undefined,
  storyId: string | undefined,
  logger: HopBudgetLogger | null | undefined,
  endpoint?: StartEndpoint,
): FallbackTarget {
  if (!fallbackEnabled || !isPrimaryUnavailable(source, primary, endpoint)) return { agent: primary };
  const candidate = source.nextCandidate(primary, 0);
  if (!candidate) return { agent: primary };
  logger?.info("agent-manager", "Primary agent already unavailable — starting on fallback", {
    storyId,
    fromAgent: primary,
    toAgent: candidate.agent,
  });
  return candidate;
}

/**
 * Swap hops spent per story, shared by every operation of that story.
 *
 * Calls carrying no `storyId` (setup, CLI one-shots, plan-time calls that predate a
 * story) keep the old per-call budget: there is no story to bill them to, and a shared
 * "undefined" bucket would let unrelated calls starve each other.
 */
export class StoryHopBudget {
  private readonly _byStory = new Map<string, number>();

  /** Hops already spent by this story — 0 for an unbilled call. */
  spent(storyId: string | undefined): number {
    return storyId ? (this._byStory.get(storyId) ?? 0) : 0;
  }

  /** Record one more hop and return the new count. */
  spend(storyId: string | undefined, hopsSoFar: number): number {
    const next = hopsSoFar + 1;
    if (storyId) this._byStory.set(storyId, next);
    return next;
  }

  /** Drop every story's budget (run teardown / `AgentManager.reset()`). */
  clear(): void {
    this._byStory.clear();
  }
}
