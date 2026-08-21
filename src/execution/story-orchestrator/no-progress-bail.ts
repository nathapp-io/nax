import { findingRecurrenceKey, isNaxBailWrapper, markNaxBailWrapper } from "@/findings";
import type { Finding, FixStrategy, Iteration } from "@/findings";

// Uses the coarse recurrence key (not findingKey) so an LLM reviewer rewording
// the same finding at the same file:line:rule still reads as "no progress"
// instead of minting a new identity every iteration (nax#1581).
/**
 * True when every strategy dispatched in this iteration answered UNRESOLVED —
 * nothing was attempted, so the working tree cannot have changed (#1654).
 *
 * Such an iteration used to terminate the cycle outright, so it could never sit
 * inside a trailing window. `runFixCycle` now falls through to a repo-scoped
 * claimant instead, which puts a no-op iteration mid-history. Counting it as
 * "no progress" is a category error: nothing ran, so the iteration is evidence
 * of nothing. Left in the window it bails the very cycle the fallthrough exists
 * to continue — a story already stalled for two iterations would exit at the
 * give-up and never reach the claimant.
 *
 * Carry-forward iterations (`fixesApplied: []`, recorded by review
 * orchestrators) are NOT exempted: the fix ran outside the cycle, so the
 * iteration does carry a result.
 *
 * `withIncreasingFailuresBail` needs no equivalent guard — its predicate
 * requires `findingsAfter.length > findingsBefore.length`, which a no-op
 * iteration cannot satisfy, so it can only suppress that bail, never trigger it.
 */
function everyFixDeclined(iteration: Iteration<Finding>): boolean {
  return iteration.fixesApplied.length > 0 && iteration.fixesApplied.every((fa) => fa.unresolved !== undefined);
}

function madeNoProgress(iteration: Iteration<Finding>): boolean {
  if (iteration.findingsBefore.length === 0) return false;
  const after = new Set(iteration.findingsAfter.map(findingRecurrenceKey));
  return iteration.findingsBefore.every((finding) => after.has(findingRecurrenceKey(finding)));
}

export function withNoProgressBail(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
  enabled: boolean,
  consecutiveNoProgress: number,
): FixStrategy<Finding, unknown, unknown, unknown>[] {
  if (!enabled) return strategies;
  const threshold = Math.max(1, consecutiveNoProgress);
  return strategies.map((strategy) => {
    const innerBail = strategy.bailWhen;
    const isUserBail = innerBail !== undefined && !isNaxBailWrapper(innerBail);
    return {
      ...strategy,
      // Precedence (AC8, AC15): user-supplied bailWhen wins > no-progress > any inner
      // wrapper bail (e.g. withIncreasingFailuresBail). A wrapped inner bail must still
      // be consulted as a fallback below — dropping it silently disables that bail.
      bailWhen: markNaxBailWrapper((iterations: readonly Iteration<Finding>[]): string | null => {
        if (isUserBail) {
          const userReason = innerBail(iterations);
          if (userReason !== null) return userReason;
        }
        // Excluded, not counted as progress: a no-op iteration neither advances
        // the streak nor resets it — the window closes over the iterations that
        // actually dispatched something.
        const attempted = iterations.filter((it) => !everyFixDeclined(it));
        if (attempted.length >= threshold) {
          const trailing = attempted.slice(-threshold);
          if (trailing.every(madeNoProgress)) {
            return `no finding resolved for ${threshold} consecutive iteration(s); ${trailing.at(-1)?.findingsBefore.length ?? 0} finding(s) persisted`;
          }
        }
        if (!isUserBail && innerBail) return innerBail(iterations);
        return null;
      }),
    };
  });
}
