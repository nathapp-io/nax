/**
 * Cross-attempt review-finding recurrence store (#1666 Part C).
 *
 * `oscillation-store.ts` counts a resolved-then-reappearing finding SOURCE within
 * one rectification cycle's iterations — it is structurally blind to a finding that
 * simply recurs, unchanged, across SEPARATE escalation attempts of the same story
 * (different `ExecutionPlan.run()` calls, possibly at a different tier). That is
 * exactly the shape #1666 produces once semantic-review and adversarial-review both
 * run every attempt (Part B): semantic-review keeps raising the same objection while
 * adversarial-review keeps passing, and the story re-escalates tier after tier with
 * no progress. This module is a parallel, independent counter for that case — it
 * does not repurpose `oscillation-store.ts`.
 *
 * Keyed by `findingRecurrenceKey` (not `findingKey`) so an LLM reviewer rewording
 * the same finding at the same location still counts as the same finding (#1581).
 *
 * TRAP (mirrors the note in oscillation-store.ts): rectification's revalidation
 * short-circuits on the first failing phase, so downstream reviewers are revealed
 * one attempt at a time as the phases ahead of them go green. A reviewer's FIRST
 * appearance for a story must never count as a recurrence (issue #1355's
 * false-positive class). `recordReviewFindings` gets this for free: a (storyId,
 * source) pair with no prior record has an empty comparison set, so every key in
 * its first call is necessarily new and contributes zero recurrences.
 */
import type { Finding } from "@/findings";
import { findingRecurrenceKey } from "@/findings";

export interface ReviewRecurrenceEntry {
  /** How many attempts each `findingRecurrenceKey` has been seen in, for this (storyId, source). */
  readonly keySightings: ReadonlyMap<string, number>;
  /**
   * Recurrences of the single most persistent finding — `max(sightings) - 1`.
   *
   * Deliberately a MAX over keys, not a sum. Summing conflates "one finding the
   * reviewer keeps re-raising" (the deadlock #1666 is about) with "several
   * different findings that each happened to reappear once" (a story that may
   * well be making partial progress). Only the former should trip the breaker,
   * and only the former matches the operator-facing reason text.
   */
  readonly maxRecurrences: number;
}

/** Run-scoped store: one entry per (storyId, reviewer source) pair. */
export type ReviewRecurrenceStore = Map<string, ReviewRecurrenceEntry>;

function storeKey(storyId: string, source: string): string {
  return `${storyId}::${source}`;
}

/**
 * Record one attempt's findings from a single reviewer source and return the
 * number of NEW recurrences detected this call — findings whose
 * `findingRecurrenceKey` matches one already seen from this same (storyId,
 * source) pair in an earlier attempt.
 *
 * The first-ever call for a (storyId, source) pair always returns 0: there is no
 * prior comparison set yet, so nothing can be a "repeat" (see the TRAP note above).
 */
export function recordReviewFindings(
  store: ReviewRecurrenceStore,
  storyId: string,
  source: string,
  findings: readonly Finding[],
): number {
  const key = storeKey(storyId, source);
  const prior = store.get(key);
  const priorSightings = prior?.keySightings ?? new Map<string, number>();
  const currentKeys = new Set(findings.map((f) => findingRecurrenceKey(f)));

  const keySightings = new Map(priorSightings);
  let newRecurrences = 0;
  for (const k of currentKeys) {
    const seenBefore = priorSightings.get(k) ?? 0;
    if (seenBefore > 0) newRecurrences += 1;
    keySightings.set(k, seenBefore + 1);
  }

  let maxRecurrences = 0;
  for (const sightings of keySightings.values()) {
    if (sightings - 1 > maxRecurrences) maxRecurrences = sightings - 1;
  }

  store.set(key, { keySightings, maxRecurrences });
  return newRecurrences;
}

/**
 * Recurrences of the most persistent single finding for one (storyId, source)
 * pair — `max(sightings) - 1`. Zero when never recorded, and zero after a first
 * attempt (nothing can have repeated yet).
 */
export function getReviewRecurrenceCount(store: ReviewRecurrenceStore, storyId: string, source: string): number {
  return store.get(storeKey(storyId, source))?.maxRecurrences ?? 0;
}
