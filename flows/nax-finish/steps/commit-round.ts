/**
 * Assembling the audit round a `commit_<phase>` node records.
 *
 * Split out of `nax-finish.flow.ts` for room — that file sits against the
 * 600-line source cap — but the split earns its keep independently: the round's
 * shape is a data decision with four conditional fields, and it is now unit
 * testable without driving a flow node through a git mock.
 *
 * Pairs with `./review-round`, which records the rounds that produce no commit.
 */
import type { Finding, FinishPhase, FinishRound, FinishRoundOutcome } from "../types";

/** Phases that own a reviewer node; every other phase's round has nobody behind it. */
const REVIEWED_PHASES: FinishPhase[] = ["spec", "quality"];

/**
 * What produced this round, given the successor the commit routed to.
 *
 * The `route` argument is why this is computed after the commit rather than
 * alongside it: `tests-only` is only known once the committed paths have been
 * classified, and it is the difference between "no reviewer exists for this
 * phase" and "a reviewer exists, was owed a look, and was skipped".
 */
export function commitRoundOutcome(phase: FinishPhase, route: string): FinishRoundOutcome {
  if (REVIEWED_PHASES.includes(phase)) return "fixed";
  // Only `gate` can skip an owed re-review; `acceptance` has no reviewer to
  // skip, so its `tests-only`-shaped routes (it has none today) stay honest.
  if (phase === "gate" && route === "tests-only") return "review-skipped";
  return "no-reviewer";
}

export interface CommitRoundInput {
  phase: FinishPhase;
  attempt: number;
  committed: boolean;
  /** The successor this commit routed to — see `commitRoundOutcome`. */
  route: string;
  findings: Finding[];
  /** Gate commands that were red this round; omitted for non-gate phases. */
  failing?: string[];
  /** Post-commit HEAD, when there was a commit. */
  shaAfter?: string | null;
  now: string;
}

/**
 * Build the round record for a commit checkpoint.
 *
 * `sha` and `failing` are omitted rather than set to null/undefined: a reader of
 * the JSONL distinguishes "no commit" from "record lost" by the key's absence,
 * and that only works if absence is never used to mean anything else.
 */
export function buildCommitRound(i: CommitRoundInput): FinishRound {
  return {
    ts: i.now,
    phase: i.phase,
    attempt: i.attempt,
    committed: i.committed,
    outcome: commitRoundOutcome(i.phase, i.route),
    findings: i.findings,
    ...(i.failing ? { failing: i.failing } : {}),
    ...(i.committed && i.shaAfter ? { sha: i.shaAfter } : {}),
  };
}
