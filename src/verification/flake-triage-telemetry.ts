/**
 * Flake-Triage Skip Telemetry (#1657)
 *
 * Emits one structured counter every time flake triage is skipped for a gate,
 * tagged with which skip path fired and how many findings were in play.
 *
 * Why: `repo-scoped-test-fix` (#1656) dispatches a repo-wide agent to make a
 * failing test pass. That is safe only because `triageFlakyFindings` has
 * already quarantined confirmed flakes — anything reaching the fallthrough has
 * been judged deterministic. Every skip path below is a hole in that guarantee:
 * a flake there is indistinguishable from a deterministic failure.
 *
 * Gating the fallthrough on `flakeTriageRan` means threading it through
 * run-phase → rectification → the cycle context. This module measures the hole
 * first so that plumbing is only paid for if the rate justifies it (#1657 §3).
 *
 * `flakeDetection.enabled: false` is deliberately NOT counted — that is an
 * operator turning the feature off, not a gap in a feature believed to be on.
 */

import { getSafeLogger } from "../logger";

/** Structured event name — the grep key for accruing this counter over runs. */
export const FLAKE_TRIAGE_SKIP_EVENT = "flake.triage.skipped";

/**
 * Which skip path fired. `max-probes-per-gate` is the one #1657 cares about
 * most: it skips the gate *wholesale*, and "many red tests at once" is exactly
 * the shape that deadlocks a whole package.
 */
export type FlakeTriageSkipReason =
  | "max-probes-per-gate"
  | "baseline-diff-unresolved"
  | "framework-undetected"
  | "no-test-command"
  | "context-error";

/**
 * How `candidateCount` was derived. The two emit sites can see different
 * things, and conflating them would overstate the seam's numbers:
 * - `probe-eligible` — post-baseline-filter, the exact set that would be probed.
 * - `gate-findings` — the seam bails before the baseline diff exists, so this
 *   is the gate's `failed-test` findings: an upper bound on the candidates.
 */
export type FlakeTriageCandidateBasis = "probe-eligible" | "gate-findings";

export interface FlakeTriageSkipInput {
  readonly reason: FlakeTriageSkipReason;
  readonly candidateCount: number;
  readonly candidateBasis: FlakeTriageCandidateBasis;
  readonly storyId?: string;
  /** The configured cap, when `reason` is `max-probes-per-gate`. */
  readonly maxProbesPerGate?: number;
  /** Error text, when `reason` is `context-error`. */
  readonly error?: string;
}

/** Log one skip counter. Never throws — telemetry must not fail a gate. */
export function logFlakeTriageSkip(input: FlakeTriageSkipInput): void {
  getSafeLogger()?.info("flake-triage", `Flake triage skipped — ${input.reason}`, {
    event: FLAKE_TRIAGE_SKIP_EVENT,
    reason: input.reason,
    candidateCount: input.candidateCount,
    candidateBasis: input.candidateBasis,
    ...(input.storyId !== undefined && { storyId: input.storyId }),
    ...(input.maxProbesPerGate !== undefined && { maxProbesPerGate: input.maxProbesPerGate }),
    ...(input.error !== undefined && { error: input.error }),
  });
}
