import type { Finding, Iteration } from "../findings";
import { classifyOutcome } from "../findings";

/** Run-scoped, per-story adversarial-review round history. Keyed by storyId. */
export function getAdversarialIterations(store: Map<string, Iteration[]>, storyId: string): Iteration[] {
  return store.get(storyId) ?? [];
}

/**
 * Append one adversarial round to the per-story history. `fixesApplied` is `[]`
 * because the fix ran in the implementation session outside the FixCycle (see
 * the ADR-022 note on `Iteration.fixesApplied`). `findingsAfter` is this round's
 * adversarial findings (source "adversarial-review"), which recurrence-demotion
 * (`countPriorAppearances`) and the carry-forward prompt both read.
 */
export function recordAdversarialIteration(
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
