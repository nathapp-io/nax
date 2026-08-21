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
 * - `gate-findings` — the whole finding set handed to the seam, unfiltered by
 *   category (`extractPhaseFindings` keeps `execution-failed` and friends too):
 *   an upper bound on the candidates, never an exact probe count.
 */
export type FlakeTriageCandidateBasis = "probe-eligible" | "gate-findings";

/**
 * Which cycle the skipped gate belongs to. Load-bearing for #1657 §3: only
 * `blocking-gate` can dispatch `repo-scoped-test-fix` — the strategy is
 * "registered on the blocking cycle only" (see `build-plan-for-strategy.ts`).
 * `nbf` emits are multiplied by the per-attempt revalidation loop and `regression`
 * is the run-scoped deferred gate; counting either toward the decision would
 * argue for plumbing on traffic that carries none of the risk. Required, not
 * defaulted — a mislabeled row is unrecoverable once the data has accrued.
 */
export type FlakeTriageScope = "blocking-gate" | "nbf" | "regression";

export interface FlakeTriageSkipInput {
  readonly reason: FlakeTriageSkipReason;
  readonly scope: FlakeTriageScope;
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
  // Enforced, not merely asserted: this is called from gate paths whose whole
  // point is to degrade rather than throw, including one inside a catch block.
  try {
    getSafeLogger()?.info("flake-triage", `Flake triage skipped — ${input.reason}`, {
      event: FLAKE_TRIAGE_SKIP_EVENT,
      reason: input.reason,
      scope: input.scope,
      candidateCount: input.candidateCount,
      candidateBasis: input.candidateBasis,
      ...(input.storyId !== undefined && { storyId: input.storyId }),
      ...(input.maxProbesPerGate !== undefined && { maxProbesPerGate: input.maxProbesPerGate }),
      ...(input.error !== undefined && { error: input.error }),
    });
  } catch {
    // Telemetry must never fail a gate.
  }
}

/**
 * The denominator. Without it "#1657 §3: only if path 1 shows up at a
 * meaningful rate" has no rate — skip counts alone are absolute. Emitted at
 * `debug` so it costs no console lines in a normal run while still landing in
 * the JSONL, which records every level.
 */
export const FLAKE_TRIAGE_RAN_EVENT = "flake.triage.ran";

export interface FlakeTriageRanInput {
  readonly scope: FlakeTriageScope;
  readonly candidateCount: number;
  readonly quarantinedCount: number;
  readonly storyId?: string;
}

/** Log one completed-triage counter. Never throws. */
export function logFlakeTriageRan(input: FlakeTriageRanInput): void {
  try {
    getSafeLogger()?.debug("flake-triage", "Flake triage ran", {
      event: FLAKE_TRIAGE_RAN_EVENT,
      scope: input.scope,
      candidateCount: input.candidateCount,
      quarantinedCount: input.quarantinedCount,
      ...(input.storyId !== undefined && { storyId: input.storyId }),
    });
  } catch {
    // Telemetry must never fail a gate.
  }
}
