import type { Finding, Iteration } from "../findings";
import { classifyOutcome } from "../findings";

/**
 * PERF-1: bound the per-story review history. Each round copies the
 * previous round's full `findingsAfter` into `findingsBefore`, so a story
 * with N rounds retains ~N² cumulative `Finding` objects. The semantic +
 * adversarial stores are run-scoped and never pruned, so on long parallel
 * runs (200 stories × 20 rounds × full-text findings) the in-memory store
 * can grow to tens of MB. The oldest rounds are no longer needed for any
 * downstream consumer (recurrence-demotion only reads the most recent few),
 * so a bounded tail keeps memory flat.
 */
export const MAX_ITERATIONS_PER_STORY = 10;

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
 *
 * PERF-1: when the per-story history would exceed MAX_ITERATIONS_PER_STORY,
 * drop the oldest rounds. `iterationNum` is rewritten so downstream consumers
 * see a contiguous 1..N sequence (otherwise a 21st round would be labelled
 * 21 with rounds 1-10 dropped, confusing recurrence counts).
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
  const merged = [...prior, iteration];
  const trimmed = merged.length > MAX_ITERATIONS_PER_STORY ? merged.slice(-MAX_ITERATIONS_PER_STORY) : merged;
  const renumbered = trimmed.map((it, i) => ({ ...it, iterationNum: i + 1 }));
  store.set(storyId, renumbered);
}
