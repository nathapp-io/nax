/**
 * The interruption evidence a mechanical gate op carries out of the quality
 * runner (review-and-gate-guards US-008).
 *
 * `runQualityCommand` reports two ways a command can end without finishing: a
 * wall-clock deadline, and a detector stop (repeated output or silence, US-005).
 * Both leave the same shape — `timedOut: true`, plus a `stopReason` only the
 * detector can supply — and both mean the same thing to a gate: the command
 * never produced a verdict, so whatever it printed is partial.
 *
 * The op outputs and the workflow gates both need that shape and the same words
 * for it, so it lives here rather than being re-spelled in each of them.
 */
import type { QualityCommandResult } from "../quality/runner";
import type { GateStopReason } from "../utils/gate-stall";

/** What an interrupted gate command carries: `timedOut`, and the reason when there is one. */
export interface CheckInterruption {
  readonly timedOut?: true;
  /**
   * Present only on a detector stop. A wall deadline carries no reason of its
   * own, so the property is absent rather than undefined on that path.
   */
  readonly stopReason?: GateStopReason;
}

/** The interruption fields for one runner result; empty when the command finished. */
export function interruptionEvidence(res: QualityCommandResult): CheckInterruption {
  if (!res.timedOut) return {};
  return res.stopReason === undefined ? { timedOut: true } : { timedOut: true, stopReason: res.stopReason };
}

/**
 * The detector evidence in words — the stream and the repetition that tripped,
 * or the silence setting. Never the repeated line itself, and never raw output.
 */
export function earlyStopEvidence(reason: GateStopReason): string {
  return reason.kind === "repeated-output"
    ? `${reason.stream} repeated the same line ${reason.count} times (threshold ${reason.threshold})`
    : `no output for ${reason.silenceTimeoutSeconds}s`;
}

/**
 * Why a gate command produced no usable verdict, for a partial-output finding:
 * "" when the command finished, otherwise the interruption named in full. A
 * caller that only says "failed" would let a partial stream read as the whole
 * linter's opinion.
 */
export function interruptionNote(res: QualityCommandResult): string {
  if (!res.timedOut) return "";
  const why =
    res.stopReason === undefined
      ? "it hit its timeout before finishing"
      : `it was stopped early: ${earlyStopEvidence(res.stopReason)}`;
  return `${why}, so any parsed output is incomplete`;
}
