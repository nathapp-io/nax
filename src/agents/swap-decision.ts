/**
 * The agent-swap decision, with the gate that decided it.
 *
 * nax#1713: `shouldSwap` returned a bare boolean, so `runWithFallback` could
 * decline a swap and return terminally with nothing in the log. Two neighbouring
 * exits emit (the fail-stale no-candidate warning, and `onSwapExhausted`); the
 * plain decline did not, which made every other fallback defect undiagnosable
 * from artifacts — the deciding gate had to be found by elimination.
 *
 * Lives in its own module rather than on AgentManager because the decision is pure
 * over its inputs (and manager.ts is at its file-size limit).
 */

import type { AdapterFailure } from "../context/engine";
import { failurePolicyFor } from "./retry/failure-policy";

/** Which gate refused the swap. One member per decline path in `decideSwap`. */
export type SwapDeclineReason =
  /** No adapter failure to react to. */
  | "no-failure"
  /** `fail-aborted` is teardown and never swaps; a spent-lane `fail-timeout` does (nax#1883). */
  | "outcome-refused"
  /** `agent.fallback.enabled` is off. */
  | "fallback-disabled"
  /** `agent.fallback.maxHopsPerStory` already reached for this story. */
  | "hop-cap-reached"
  /** A quality failure with `agent.fallback.onQualityFailure` off. */
  | "quality-failure-declined";

export type SwapDecision = { readonly swap: true } | { readonly swap: false; readonly reason: SwapDeclineReason };

/** The `agent.fallback` slice `decideSwap` reads. */
export interface SwapFallbackConfig {
  readonly enabled?: boolean;
  readonly maxHopsPerStory?: number;
  readonly onQualityFailure?: boolean;
}

const DEFAULT_MAX_HOPS = 2;

/**
 * Decide whether to swap to a fallback agent, naming the gate on refusal.
 *
 * Gate order is load-bearing.
 *
 * nax#1722: a `hasBundle` gate sat between `fallback-disabled` and `hop-cap-reached`,
 * declining every swap that arrived without a ContextBundle. It was correct in #474,
 * where the swap lived in the execution stage and *was* the bundle rebuild; ADR-019
 * (#749) moved the swap into AgentManager and rebased the gate onto
 * `CallContext.contextBundle` — a field no call site in src/ populated at the time.
 * The gate was therefore false for every run() dispatch in production and inert on
 * the complete() path, which passed a literal `true` past it. Swapping needs no
 * bundle: the swap branch never dereferences one, and `buildHopCallback` skips the
 * rebuild when there is none. nax#1737 has since threaded the bundle from
 * `PipelineContext` onto the execution stage's CallContext, which is what makes the
 * rebuild and the context pull tools reachable — but the gate stays removed.
 */
export function decideSwap(
  failure: AdapterFailure | undefined,
  hopsSoFar: number,
  fallback: SwapFallbackConfig | undefined,
): SwapDecision {
  if (!failure) return { swap: false, reason: "no-failure" };
  const policy = failurePolicyFor(failure.outcome);
  // `fail-aborted` is teardown and must never swap. `fail-timeout` used to share
  // this gate because swapping implied pruning (nax#1371); it no longer does —
  // its policy cooldown is "none", so the agent survives the swap.
  if (policy.swap === "never") return { swap: false, reason: "outcome-refused" };
  if (!fallback?.enabled) return { swap: false, reason: "fallback-disabled" };
  if (hopsSoFar >= (fallback.maxHopsPerStory ?? DEFAULT_MAX_HOPS)) {
    return { swap: false, reason: "hop-cap-reached" };
  }
  if (policy.swap === "quality-gated") {
    return fallback.onQualityFailure ? { swap: true } : { swap: false, reason: "quality-failure-declined" };
  }
  return { swap: true };
}

/**
 * A fallback target, after all config spellings are reduced to one shape.
 * `tier` and `model` are mutually exclusive — at most one is ever set, mirroring
 * `ConfiguredModel`'s `{ agent, model }` (`model` is a tier name or a literal id;
 * see `resolveFallbackDispatchTarget` in fallback-model-identity.ts for how a
 * `.model` target that names a tier is later folded into `.tier`).
 */
export interface FallbackTarget {
  readonly agent: string;
  readonly tier?: string;
  readonly model?: string;
}

export type FallbackMapValue = string | { agent: string; tier: string } | { agent: string; model: string };
export type FallbackMap = Record<string, readonly FallbackMapValue[]>;

/**
 * All three spellings reduce here, and nothing downstream sees the raw union.
 * A plain string is a target with no tier — which is what every existing
 * config is, so the no-tier path must stay the untouched one.
 */
export function normaliseFallbackTarget(value: FallbackMapValue): FallbackTarget {
  if (typeof value === "string") return { agent: value };
  if ("tier" in value) return { agent: value.agent, tier: value.tier };
  return { agent: value.agent, model: value.model };
}

/**
 * The fallback candidates for `agent`, in map order, minus any the caller excludes.
 *
 * `resolveFallbackChain` and `nextCandidate` both filtered the same map by the same
 * two predicates; this is that filter, so they cannot diverge. Callers pass the
 * PRIMARY agent, not the most-recently-failed one, so a flat map like
 * `{ claude: ["codex", "gemini"] }` walks correctly: unavailable agents drop out and
 * the next available candidate in order is returned.
 *
 * `isExcluded` also receives the candidate's tier — and, for a `{ agent, model }`
 * target naming a literal id rather than a tier, that literal pin — so a caller can
 * key exclusion on the candidate's resolved identity rather than the bare agent
 * name: a same-agent, different-tier target must survive exclusion of the tier
 * that actually failed, and a literal pin naming the same model as a tier spelling
 * must collide with it exactly as that tier spelling would. A predicate that ignores
 * the extra arguments (every predicate written before this identity split) keeps its
 * original agent-only behaviour — TypeScript's function-parameter contravariance
 * makes a narrower `(candidate: string) => boolean` assignable here.
 *
 * `resolve` runs BEFORE the filter, not after: a `{ agent, model }` target naming a
 * tier does not carry `.tier` until it is folded in, so filtering first judged it
 * tier-less and excluded it — while the identical target spelled `{ agent, tier }`
 * survived. Two spellings of one target must be indistinguishable here, which is
 * the whole point of accepting the ConfiguredModel spelling. The default is
 * identity, so a caller that cannot resolve (no `models`) keeps the raw shapes.
 */
export function availableCandidates(
  map: FallbackMap | undefined,
  agent: string,
  isExcluded: (candidate: string, tier?: string, model?: string) => boolean,
  resolve: (target: FallbackTarget) => FallbackTarget = (target) => target,
): FallbackTarget[] {
  return (map?.[agent] ?? [])
    .map(normaliseFallbackTarget)
    .map(resolve)
    .filter((candidate) => !isExcluded(candidate.agent, candidate.tier, candidate.model));
}

/**
 * Every agent whose credentials `validateCredentials` must check: the primary, plus
 * both sides of every entry in the fallback map (a `from` key can name an agent that
 * appears in no `to` list, and vice versa).
 *
 * Names only — a tier says nothing about credentials.
 */
export function credentialCandidates(map: FallbackMap | undefined, primary: string): Set<string> {
  const candidates = new Set<string>([primary]);
  for (const [from, tos] of Object.entries(map ?? {})) {
    candidates.add(from);
    for (const to of tos) candidates.add(normaliseFallbackTarget(to).agent);
  }
  return candidates;
}

/** Minimal logger surface the decline reporter needs. */
interface DeclineLogger {
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Report a declined swap (#1713): the deciding gate plus the failure it declined.
 * `storyId` is mandated on every log call by project conventions and is already
 * carried by both neighbouring decline exits.
 */
export function logSwapDecline(
  logger: DeclineLogger | null | undefined,
  reason: SwapDeclineReason,
  input: { storyId: string | undefined; agent: string; hopsSoFar: number; failure: AdapterFailure | undefined },
): void {
  logger?.warn("agent-manager", "Fallback swap declined", {
    storyId: input.storyId,
    reason,
    agent: input.agent,
    hopsSoFar: input.hopsSoFar,
    outcome: input.failure?.outcome,
    category: input.failure?.category,
  });
}
