/**
 * US-005 — scoped fix review around the blocking cycle's `autofix-test-writer`
 * dispatch.
 *
 * A fix dispatch can silently contradict the story: the test-writer edits a test
 * until it passes, and the edit drops the very assertion the AC demanded. The
 * blocking cycle re-runs the seeded reviewers afterwards, but the seeded
 * reviewers re-read the whole story, so a contradiction between the fix's own
 * delta and an AC has no cheap, targeted check.
 *
 * This module supplies that check as a *wrapper* around a `FixStrategy`: it
 * records the findings handed to `buildInput`, snapshots the working tree in
 * `beforeDispatch` (before the fix edits anything), and after the dispatch runs
 * the scoped fix review over the delta. Only an AC-anchored contradiction — a
 * `contradiction` verdict carrying an `acIndex` — becomes a `Finding` for the
 * cycle to act on; every other non-pass warns and is dropped, per nax#1359
 * (scope violations and description-only contradictions are not defects).
 *
 * Declarations only for now: the wrapper's behaviour lands with the
 * implementation.
 */

import type { Finding } from "@/findings";
import type { FixStrategy } from "@/findings/cycle-types";
import type { CallContext } from "@/operations";
import type { UserStory } from "@/prd";
import type { FixReviewVerdict } from "@/review/fix-review";
import type { ReviewConfig } from "@/review/types";

/** A strategy wrapper that runs the scoped fix review after each dispatch. */
export interface FixReviewWrapper {
  /** Returns a copy of `strategy` that runs the scoped fix review after each dispatch. */
  wrap<F extends Finding, I, O, C>(strategy: FixStrategy<F, I, O, C>): FixStrategy<F, I, O, C>;
  /** Findings produced by fix reviews since the last call, then cleared. */
  drainFindings(): Finding[];
}

/** An AC-anchored contradiction: the only verdict that may block (nax#1359 ruling). */
export type AnchoredContradiction = Extract<FixReviewVerdict, { cause: "contradiction" }> & {
  readonly acIndex: number;
};

/** Placeholder returned until the mapping is implemented. */
const UNIMPLEMENTED_FINDING: Finding = {
  source: "lint",
  severity: "info",
  category: "fix-review",
  message: "",
};

/** Map an AC-anchored contradiction onto the cycle's finding wire format. */
export function toFixReviewFinding(_verdict: AnchoredContradiction): Finding {
  return UNIMPLEMENTED_FINDING;
}

/** Build the wrapper that reviews each dispatch of the strategy it wraps. */
export function createFixReviewWrapper(_args: {
  ctx: CallContext;
  story: UserStory;
  config: ReviewConfig;
}): FixReviewWrapper {
  return { wrap: (strategy) => strategy, drainFindings: () => [] };
}
