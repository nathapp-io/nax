import type { Finding, Iteration } from "../findings";
import { classifyOutcome } from "../findings";

/** Run-scoped, per-story review round history. Keyed by storyId. One store per reviewer. */
export function getReviewIterations(store: Map<string, Iteration[]>, storyId: string): Iteration[] {
  return store.get(storyId) ?? [];
}

/**
 * Append one review round to the per-story history. `fixesApplied` is `[]`
 * because the fix ran in the implementation session outside the FixCycle (see
 * the ADR-022 note on `Iteration.fixesApplied`). `findingsAfter` is this round's
 * source-tagged findings, which recurrence-demotion (`countPriorAppearances`)
 * and the carry-forward prompt both read.
 *
 * Reviewer-agnostic: callers pass the store for their own reviewer, so the
 * semantic and adversarial histories never mix.
 */
export function recordReviewIteration(
  store: Map<string, Iteration[]>,
  storyId: string,
  roundFindings: readonly Finding[],
): void {
  const prior = store.get(storyId) ?? [];
  const findingsBefore = prior.length > 0 ? prior[prior.length - 1].findingsAfter : [];
  const findingsAfter = [...roundFindings];
  const now = new Date().toISOString();
  const iteration: Iteration = {
    iterationNum: prior.length + 1,
    findingsBefore,
    fixesApplied: [],
    findingsAfter,
    outcome: classifyOutcome(findingsBefore, findingsAfter),
    startedAt: now,
    finishedAt: now,
  };
  store.set(storyId, [...prior, iteration]);
}
