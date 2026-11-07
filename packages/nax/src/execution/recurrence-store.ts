/**
 * Cross-attempt review-finding recurrence state (#1666 Part C).
 *
 * The story loop's within-cycle oscillation counter (deleted with the story
 * orchestrator) counted a resolved-then-reappearing finding SOURCE within
 * one rectification cycle's iterations — it is structurally blind to a finding that
 * simply recurs, unchanged, across SEPARATE escalation attempts of the same story
 * (different `ExecutionPlan.run()` calls, possibly at a different tier). That is
 * exactly the shape #1666 produces once semantic-review and adversarial-review both
 * run every attempt (Part B): semantic-review keeps raising the same objection while
 * adversarial-review keeps passing, and the story re-escalates tier after tier with
 * no progress. This module is a parallel, independent counter for that case — it
 * never shared state with that counter.
 *
 * Only the state's shape remains here. The recorder and the reader
 * (`recordReviewFindings`, `getReviewRecurrenceCount`) and the
 * `findingRecurrenceKey` identity they keyed on went with the findings fix cycle
 * in C1 wave B2b-3; B3 slims the runtime field that still carries this store.
 *
 * TRAP (the same one the oscillation counter documented): rectification's revalidation
 * short-circuits on the first failing phase, so downstream reviewers are revealed
 * one attempt at a time as the phases ahead of them go green. A reviewer's FIRST
 * appearance for a story must never count as a recurrence (issue #1355's
 * false-positive class) — a (storyId, source) pair with no prior record has an
 * empty comparison set, so every key in a first recording is necessarily new.
 */

export interface ReviewRecurrenceEntry {
  /** How many attempts each finding identity key has been seen in, for this (storyId, source). */
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
