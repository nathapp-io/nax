import type { IterationOutcome } from "@/findings/cycle-types";

export function recordOscillations(store: Map<string, number>, storyId: string, delta: number): number {
  if (!Number.isSafeInteger(delta) || delta < 1) {
    throw new RangeError("[execution] oscillation delta must be a positive safe integer");
  }
  const total = (store.get(storyId) ?? 0) + delta;
  store.set(storyId, total);
  return total;
}

export function getOscillations(store: Map<string, number>, storyId: string): number {
  return store.get(storyId) ?? 0;
}

const OSCILLATION_OUTCOME: IterationOutcome = "regressed-different-source";

/**
 * Count how many iterations in a cycle carry the `regressed-different-source`
 * outcome — the source-agnostic oscillation signal used by the
 * circuit-breaker. Each match increments the per-story counter at the
 * increment site (one recordOscillations call per cycle is the norm, but
 * batched counts are valid too).
 */
export function countOscillationOutcomes(iterations: ReadonlyArray<{ outcome: IterationOutcome }>): number {
  let count = 0;
  for (const iteration of iterations) {
    if (iteration.outcome === OSCILLATION_OUTCOME) count += 1;
  }
  return count;
}
