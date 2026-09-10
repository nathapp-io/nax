/**
 * Where one (story, tier, agent, role) sits on its fallback ladder.
 *
 * `depth` is a ladder INDEX, not a count of swap events: 0 is the configured
 * primary and 1..n are `agent.fallback.map[<primary>]` positions. A slot that
 * starts at rung 2 because rungs 0-1 are cooling IS at depth 2 and does not get a
 * fresh budget from there, which is what lets `maxHopsPerStory` bound how far down
 * the ladder a story travels rather than how many swaps each operation may make.
 *
 * Role is part of the key because slots remember "where I landed" per role, while
 * the CooldownStore propagates "what is dead" across all of them: an implementer's
 * rate-limit protects a reviewer without overriding the reviewer's own model pin.
 */

import type { FallbackTarget } from "./swap-decision";

export interface LadderSlot {
  /** The endpoint this slot dispatches to: agent plus tier or literal pin. */
  readonly target: FallbackTarget;
  /** Ladder index of `target`. 0 = configured primary. */
  readonly depth: number;
}

export function ladderSlotKey(
  storyId: string,
  tier: string | undefined,
  agent: string,
  role: string | undefined,
): string {
  return `${storyId}::${tier ?? "default"}::${agent}::${role ?? "default"}`;
}

/**
 * The 1-based position of `target` in `rungs`, or 0 when it is on no rung — which
 * is the configured primary (or an unknown target, which is treated the same: a
 * target we cannot place must not silently consume ladder depth).
 */
export function ladderDepthOf(
  rungs: readonly FallbackTarget[],
  target: FallbackTarget,
  same: (a: FallbackTarget, b: FallbackTarget) => boolean,
): number {
  const index = rungs.findIndex((rung) => same(rung, target));
  return index === -1 ? 0 : index + 1;
}
