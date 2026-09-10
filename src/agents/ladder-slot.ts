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

import type { ModelsConfig } from "@/config/schema-types";
import { sameFallbackHop } from "./fallback-model-identity";
import { availableCandidates, type FallbackMap, type FallbackTarget } from "./swap-decision";

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

/**
 * The configured ladder for `primary`, resolved to dispatchable shape.
 *
 * Deliberately unfiltered: depth is a position in the CONFIGURED ladder, so it
 * must not shift with which rungs happen to be cooling at this instant.
 */
export function ladderRungs(
  map: FallbackMap | undefined,
  primary: string,
  resolve: (target: FallbackTarget) => FallbackTarget,
): FallbackTarget[] {
  return availableCandidates(map, primary, () => false, resolve);
}

/**
 * `AgentManager._depthOf` as a free function, taking `models`/`defaultAgent` the
 * same way `fallback-model-identity.ts` does — `manager.ts` is at its 600-line
 * hard limit and cannot afford the inline nested-arrow composition this needs.
 */
export function resolveLadderDepth(
  models: ModelsConfig | undefined,
  defaultAgent: string,
  map: FallbackMap | undefined,
  resolveTarget: (t: FallbackTarget) => FallbackTarget,
  target: FallbackTarget,
): number {
  const same = (a: FallbackTarget, b: FallbackTarget) =>
    sameFallbackHop(models, defaultAgent, a.agent, b.agent, a.tier, a.model, b.tier, b.model);
  return ladderDepthOf(ladderRungs(map, defaultAgent, resolveTarget), target, same);
}

/**
 * `AgentManager.nextCandidate`'s selection, made depth-aware.
 *
 * `_isExcluded`/`_sameHop`-based exclusion alone is not sufficient: it depends
 * on the just-failed endpoint actually recording a cooldown that the NEXT
 * lookup resolves to the identical key, which a same-tier dispatch carrying an
 * incidental raw model string (`dispatchedModel`) is not guaranteed to do (the
 * two resolve through `resolveFallbackModelId`'s pin-over-tier precedence
 * differently depending on which argument combination is present). Filtering
 * candidates to those whose ladder depth exceeds `hops` makes forward
 * progress a structural guarantee instead of an accident of cooldown-key
 * agreement: `runWithFallback` sets `hopsSoFar = depthOf(next)` after every
 * swap (nax#1965), so a candidate at or behind the caller's own depth is a
 * rung this operation is already considered past — offering it again is what
 * produced an infinite swap loop (`hopsSoFar` never advancing past a `decideSwap`
 * cap it can no longer reach). Bounded by `rungs.length`, so the ladder is
 * walked at most once per operation regardless of exclusion state.
 */
function nextLadderCandidate(
  candidates: readonly FallbackTarget[],
  hops: number,
  depthOf: (t: FallbackTarget) => number,
): FallbackTarget | null {
  return candidates.find((candidate) => depthOf(candidate) > hops) ?? null;
}

/** `resolveNextCandidate`'s selection request — everything but the identity-resolution deps. */
export interface NextCandidateQuery {
  readonly cur: string;
  readonly hops: number;
  readonly exclude?: string;
  readonly tier?: string;
  readonly model?: string;
}

/**
 * `AgentManager.nextCandidate` as a free function — manager.ts is at its
 * 600-line hard limit and cannot afford this body inline (see `nextLadderCandidate`
 * doc above for why the depth filter is required, not optional).
 */
export function resolveNextCandidate(
  map: FallbackMap | undefined,
  resolveTarget: (t: FallbackTarget) => FallbackTarget,
  depthOf: (t: FallbackTarget) => number,
  sameHop: (a: string, b: string | undefined, at?: string, am?: string, bt?: string, bm?: string) => boolean,
  isExcluded: (c: string, t?: string, m?: string) => boolean,
  query: NextCandidateQuery,
): FallbackTarget | null {
  const { cur, hops, exclude, tier, model } = query;
  const excluded = (c: string, t?: string, m?: string): boolean =>
    sameHop(c, exclude, t, m, tier, model) || isExcluded(c, t, m);
  return nextLadderCandidate(availableCandidates(map, cur, excluded, resolveTarget), hops, depthOf);
}
