/**
 * Bind `AgentManager`'s fallback identity/ladder helpers to its live `config`,
 * `models`, and `getDefault` — factored out of manager.ts purely to keep that
 * file under its `src/**` line budget; no behaviour change from what used to
 * be four private closures on `AgentManager` itself.
 *
 * `getModels` is a getter, not a snapshot: `configureRuntime` can backfill
 * `_models` after construction (see manager.ts), and these bindings must see
 * that update rather than close over the constructor-time value.
 */

import type { ModelsConfig } from "@/config/schema-types";
import type { AgentManagerConfig } from "@/config/selectors";
import { resolveFallbackDispatchTarget, resolveFallbackModelId, sameFallbackHop } from "./fallback-model-identity";
import { type NextCandidateQuery, resolveLadderDepth, resolveNextCandidate } from "./ladder-slot";
import { availableCandidates, type FallbackTarget } from "./swap-decision";

type IsExcludedFn = (candidate: string, tier?: string, model?: string) => boolean;

export interface FallbackIdentityBindings {
  modelId: (agent: string, tier?: string, model?: string) => string | undefined;
  resolveTarget: (t: FallbackTarget) => FallbackTarget;
  sameHop: (a: string, b: string | undefined, at?: string, am?: string, bt?: string, bm?: string) => boolean;
  depthOf: (agent: string, t: FallbackTarget) => number;
  /** `AgentManager.resolveFallbackChain`'s body, given the manager's own `isExcluded`. */
  chain: (agent: string, isExcluded: IsExcludedFn) => FallbackTarget[];
  /** `AgentManager.nextCandidate`'s body, given the manager's own `isExcluded`. */
  nextCandidate: (query: NextCandidateQuery, isExcluded: IsExcludedFn) => FallbackTarget | null;
}

export function createFallbackIdentityBindings(
  config: AgentManagerConfig,
  getModels: () => ModelsConfig | undefined,
  getDefault: () => string,
): FallbackIdentityBindings {
  const map = config.agent?.fallback?.map;
  const modelId = (agent: string, tier?: string, model?: string): string | undefined =>
    resolveFallbackModelId(getModels(), agent, tier, getDefault(), model);
  const resolveTarget = (t: FallbackTarget): FallbackTarget =>
    resolveFallbackDispatchTarget(getModels(), getDefault(), t);
  const sameHop = (a: string, b: string | undefined, at?: string, am?: string, bt?: string, bm?: string): boolean =>
    sameFallbackHop(getModels(), getDefault(), a, b, at, am, bt, bm);
  const depthOf = (agent: string, t: FallbackTarget): number =>
    resolveLadderDepth(map, resolveTarget, sameHop, agent, t);
  const chain = (agent: string, isExcluded: IsExcludedFn): FallbackTarget[] =>
    availableCandidates(map, agent, isExcluded, resolveTarget);
  const nextCandidate = (query: NextCandidateQuery, isExcluded: IsExcludedFn): FallbackTarget | null =>
    resolveNextCandidate(map, resolveTarget, (t) => depthOf(query.cur, t), sameHop, isExcluded, query);
  return { modelId, resolveTarget, sameHop, depthOf, chain, nextCandidate };
}
