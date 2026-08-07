import type { Finding, Iteration } from "@/findings";

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

/** Minimal iteration shape the oscillation counter needs: the finding sources before/after. */
type OscillationIteration = Pick<Iteration, "findingsBefore" | "findingsAfter">;

function sourceSet(findings: ReadonlyArray<Pick<Finding, "source">> | number | undefined): Set<Finding["source"]> {
  // Defensive: this runs in the rectification hot path. A malformed or partial
  // iteration (e.g. a carry-forward record missing its findings arrays, or a
  // post-US-002 iteration that stored only a numeric count) must degrade to
  // "no sources", never crash the counter.
  return new Set((Array.isArray(findings) ? findings : []).map((f) => f.source));
}

/**
 * Count genuine reviewer oscillation across a cycle's iterations — a finding
 * source that was previously RESOLVED (present in an earlier iteration's
 * `findingsBefore`, then absent from its `findingsAfter`) REAPPEARING in a
 * later iteration's `findingsAfter`. That "fixed, then came back" reversal is
 * the ping-pong the circuit-breaker exists to catch.
 *
 * It deliberately does NOT count a source that merely appears for the first
 * time. Rectification revalidation short-circuits on the first failing phase
 * (see `story-orchestrator/rectification.ts`), so downstream reviewers
 * (semantic, then adversarial) are structurally revealed one at a time as the
 * phases ahead of them go green. The old counter treated each first reveal as
 * `regressed-different-source` and counted it, pausing stories that were making
 * monotonic forward progress (issue #1355). A strictly-forward reveal chain
 * (`typecheck → semantic → adversarial`, each once) never revisits a source and
 * now counts zero; only a source coming back after a fix increments the count.
 *
 * The per-story counter accumulates across escalation attempts at the increment
 * site (one `recordOscillations` call per cycle).
 */
export function countOscillationOutcomes(iterations: ReadonlyArray<OscillationIteration>): number {
  const resolvedSources = new Set<Finding["source"]>();
  let count = 0;
  for (const iteration of iterations) {
    const beforeSources = sourceSet(iteration.findingsBefore);
    const afterSources = sourceSet(iteration.findingsAfter);
    // A previously-resolved source reappearing after a fix is a real reversal.
    for (const source of afterSources) {
      if (resolvedSources.has(source)) count += 1;
    }
    // A source present-before and absent-after is now "resolved" — a later
    // reappearance in `findingsAfter` will register as oscillation.
    for (const source of beforeSources) {
      if (!afterSources.has(source)) resolvedSources.add(source);
    }
  }
  return count;
}
