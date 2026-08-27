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

/** Which gate refused the swap. One member per decline path in `decideSwap`. */
export type SwapDeclineReason =
  /** No adapter failure to react to. */
  | "no-failure"
  /** `fail-aborted` (teardown) and `fail-timeout` (pool poison) never swap. */
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
 * `CallContext.contextBundle` — a field no call site in src/ populates. The gate was
 * therefore false for every run() dispatch in production and inert on the complete()
 * path, which passed a literal `true` past it. Swapping needs no bundle: the swap
 * branch never dereferences one, and `buildHopCallback` skips the rebuild when there
 * is none. Threading the bundle to the CallContexts is a separate defect (it also
 * gates every context pull tool) tracked on its own issue.
 */
export function decideSwap(
  failure: AdapterFailure | undefined,
  hopsSoFar: number,
  fallback: SwapFallbackConfig | undefined,
): SwapDecision {
  if (!failure) return { swap: false, reason: "no-failure" };
  if (failure.outcome === "fail-aborted" || failure.outcome === "fail-timeout") {
    return { swap: false, reason: "outcome-refused" };
  }
  if (!fallback?.enabled) return { swap: false, reason: "fallback-disabled" };
  if (hopsSoFar >= (fallback.maxHopsPerStory ?? DEFAULT_MAX_HOPS)) {
    return { swap: false, reason: "hop-cap-reached" };
  }
  if (failure.category === "availability") return { swap: true };
  return fallback.onQualityFailure ? { swap: true } : { swap: false, reason: "quality-failure-declined" };
}

/**
 * The fallback candidates for `agent`, in map order, minus any the caller excludes.
 *
 * `resolveFallbackChain` and `nextCandidate` both filtered the same map by the same
 * two predicates; this is that filter, so they cannot diverge. Callers pass the
 * PRIMARY agent, not the most-recently-failed one, so a flat map like
 * `{ claude: ["codex", "gemini"] }` walks correctly: unavailable agents drop out and
 * the next available candidate in order is returned.
 */
export function availableCandidates(
  map: Record<string, readonly string[]> | undefined,
  agent: string,
  isExcluded: (candidate: string) => boolean,
): string[] {
  return (map?.[agent] ?? []).filter((candidate) => !isExcluded(candidate));
}

/**
 * Every agent whose credentials `validateCredentials` must check: the primary, plus
 * both sides of every entry in the fallback map (a `from` key can name an agent that
 * appears in no `to` list, and vice versa).
 */
export function credentialCandidates(map: Record<string, readonly string[]> | undefined, primary: string): Set<string> {
  const candidates = new Set<string>([primary]);
  for (const [from, tos] of Object.entries(map ?? {})) {
    candidates.add(from);
    for (const to of tos) candidates.add(to);
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
