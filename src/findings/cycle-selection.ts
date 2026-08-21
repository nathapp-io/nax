/**
 * runFixCycle — strategy selection and attempt counting.
 *
 * Extracted from cycle.ts (600-line source limit) when #1654 added the
 * remaining-claimant check. These four helpers answer "which strategies run
 * this iteration, and how many times have they run already?" — pure functions
 * over the strategy list, findings, and iteration history.
 *
 * scope: repo-scoped (pure; no I/O, no config)
 */

import type { DeclineLedger } from "./cycle-retirement";
import type { FixStrategy, Iteration } from "./cycle-types";
import type { Finding } from "./types";

// ─── Strategy selection ──────────────────────────────────────────────────────

export function selectActiveStrategies<F extends Finding>(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are opaque to the cycle
  strategies: FixStrategy<F, any, any, any>[],
  findings: F[],
  verdict: string | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: see above
): FixStrategy<F, any, any, any>[] {
  if (findings.length > 0) {
    return strategies.filter((s) => findings.some((f) => s.appliesTo(f)));
  }
  if (verdict !== undefined) {
    return strategies.filter((s) => s.appliesToVerdict?.(verdict) ?? false);
  }
  return [];
}

export function selectExecutionGroup<F extends Finding>(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are opaque to the cycle
  active: FixStrategy<F, any, any, any>[],
  // biome-ignore lint/suspicious/noExplicitAny: see above
): FixStrategy<F, any, any, any>[] {
  const exclusive = active.find((s) => !s.coRun || s.coRun === "exclusive");
  if (exclusive) return [exclusive];
  return active.filter((s) => s.coRun === "co-run-sequential");
}

/**
 * Is there still a strategy that could be dispatched for `findings`?
 *
 * Asked only after every strategy in the executed group answered UNRESOLVED
 * (#1654). Exiting `agent-gave-up` there is correct only when the group was the
 * last claimant; when another strategy still claims the findings, has not been
 * retired, and has attempts left, the cycle must dispatch it instead. The
 * caller has already recorded the give-ups in `ledger`, so the strategies that
 * just declined are excluded by `isRetiredFor` — this cannot re-select them and
 * loop forever.
 *
 * The attempt check must stay in step with the `uncappedActive` filter at the
 * top of the loop: a strategy at its cap is skipped there, so treating it as a
 * viable target here would spin the loop without dispatching anything.
 */
export function hasRemainingClaimant<F extends Finding>(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are opaque to the cycle
  strategies: readonly FixStrategy<F, any, any, any>[],
  findings: readonly F[],
  ledger: DeclineLedger<F>,
  // biome-ignore lint/suspicious/noExplicitAny: see above
  attemptsOf: (strategy: FixStrategy<F, any, any, any>) => number,
): boolean {
  return strategies.some(
    (s) => findings.some((f) => s.appliesTo(f)) && !ledger.isRetiredFor(s, findings) && attemptsOf(s) < s.maxAttempts,
  );
}

// ─── Attempt counting ────────────────────────────────────────────────────────

export function countStrategyAttempts<F extends Finding>(
  iterations: readonly Iteration<F>[],
  strategyName: string,
): number {
  return iterations.reduce(
    (sum, iter) => sum + iter.fixesApplied.filter((fa) => fa.strategyName === strategyName).length,
    0,
  );
}

export function countTotalAttempts<F extends Finding>(iterations: readonly Iteration<F>[]): number {
  return iterations.reduce((sum, iter) => sum + iter.fixesApplied.length, 0);
}
