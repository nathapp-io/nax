/**
 * ADR-022 Phase 1 — iteration record types.
 *
 * These types model one fix attempt's history: which strategies ran, what the
 * findings looked like before/after, and how progress was classified across
 * attempts.
 *
 * Only types live here. The cycle behaviour that produced these records
 * (`cycle.ts`, ADR-022 Phase 2) went with the findings fix cycle in C1 wave
 * B2b-3.
 */

import type { Finding } from "./types";

// ─── Iteration record ────────────────────────────────────────────────────────

export type IterationOutcome =
  | "resolved" // findingsAfter is empty
  | "partial" // findingsAfter is a strict subset of findingsBefore
  | "regressed" // findingsAfter contains new findings not in findingsBefore (same source)
  | "unchanged" // findingsAfter equals findingsBefore (same files+rules+lines)
  | "rotated" // every finding was replaced by a different one — the defect moved, nothing converged (nax#2154)
  | "regressed-different-source"; // before had source A, after has source B

export interface FixApplied {
  strategyName: string;
  /** Operation name from RunOperation.name / CompleteOperation.name. */
  op: string;
  targetFiles: string[];
  /** First ~500 chars of agent response or stdout. Empty when unavailable. */
  summary: string;
  /** Set when the agent explicitly signals it cannot resolve the findings. Triggers agent-gave-up exit. */
  unresolved?: string;
  /**
   * Total spend for this fix — successful plus failed-dispatch (#1960) — read
   * from the run's cost ledger (#1932) unless the strategy's `extractApplied`
   * supplied its own. Populated on every fix since #1932 — the `?` is retained
   * only for the records the cycle's own exit paths build without a dispatch.
   *
   * Folds failed-dispatch spend, mirroring the story orchestrator's per-phase
   * `phaseCosts` (that seam went with the story loop, B2b-1); the failed half is
   * still carried beside it in `errorCostUsd`.
   */
  costUsd?: number;
  /**
   * Failed-dispatch spend for this fix — the attempts that threw, which
   * `callOp`'s retry loop keys under the same `callId` as the attempt that
   * eventually succeeded (#1948).
   *
   * The failed half of `costUsd`, which folds it in (#1960); carried here so
   * wasted spend stays measurable, exactly like `RunMetrics.errorCostUsd`.
   * Omitted (rather than zero) when nothing failed, so its presence always
   * means a dispatch attempt actually threw.
   *
   * Unlike `costUsd`, a strategy's `extractApplied` cannot override this: it
   * knows what its successful call billed, not what the attempts that threw
   * before it burned.
   */
  errorCostUsd?: number;
}

export interface Iteration<F extends Finding = Finding> {
  /** 1-indexed. */
  iterationNum: number;
  /** Findings observed before the iteration ran. */
  findingsBefore: F[];
  /**
   * Strategies that ran during this iteration. At least one entry when the fix
   * cycle produced the iteration (one per strategy that ran).
   *
   * Exception: carry-forward iterations recorded by review orchestrators
   * (e.g. adversarial) have fixesApplied: [] because the fix ran in the
   * implementation session outside the fix cycle. The rendered table shows "-"
   * in the "Strategies run" column for these rows.
   */
  fixesApplied: FixApplied[];
  /** Findings observed after the iteration ran. */
  findingsAfter: F[];
  /**
   * Exact finding key (message included) per entry in the pre-iteration
   * findings, in array order. Set by the iteration recorder; omitted on
   * carry-forward iterations recorded by review orchestrators (which retain
   * the array form above). This is the strict identity — for the coarser
   * identity the outcome classifier used, see
   * `findingRecurrenceKeysBefore`/`After` (nax#1581).
   */
  findingKeysBefore?: string[];
  /** Mirror of `findingKeysBefore` for the post-iteration findings. */
  findingKeysAfter?: string[];
  /**
   * The coarse recurrence key per entry in the pre-iteration findings, in
   * array order — the message-excluded identity the outcome classifier used
   * to compute `outcome`. Logged alongside the strict `findingKeys*`
   * fields so a reader can tell why two `message`-differing findings were
   * classified as the same defect (nax#1581).
   */
  findingRecurrenceKeysBefore?: string[];
  /** Mirror of `findingRecurrenceKeysBefore` for the post-iteration findings. */
  findingRecurrenceKeysAfter?: string[];
  /**
   * De-duplicated union of `fixesApplied[].targetFiles` in first-seen order.
   * Omitted when `fixesApplied` is empty so carry-forward iterations don't
   * carry a zero-length array.
   */
  fixTargetFiles?: string[];
  /** One entry per `fixesApplied` entry, in input order. Omitted when empty. */
  fixSummaries?: string[];
  /**
   * Sum of `fixesApplied[].costUsd` for this iteration. Omitted when the
   * total is zero so the record stays free of zero-cost entries.
   */
  costUsd?: number;
  /**
   * Sum of `fixesApplied[].errorCostUsd` for this iteration — the spend of
   * dispatch attempts that threw (#1948). Omitted at zero on the same reasoning
   * as `costUsd`, so its presence always means a dispatch actually failed.
   */
  errorCostUsd?: number;
  /**
   * US-003 — the iteration's dispatch raised `CALL_OP_NO_DISPATCH`: no hop of
   * the operation ever reached a model, so nothing was edited and `validate`
   * was skipped (`findingsAfter` equals `findingsBefore`, and the failed
   * dispatch's spend rides on `fixesApplied` like any other attempt).
   *
   * Consumers cared about exactly one thing: the no-progress bail excluded these
   * iterations from the no-progress window. An iteration that reached no model
   * is evidence of nothing — it neither advances the streak nor resets it —
   * where a completed no-edit iteration (same `outcome`, no marker) is real
   * evidence about whether progress is possible.
   */
  noDispatch?: true;
  outcome: IterationOutcome;
  startedAt: string; // ISO-8601
  finishedAt: string; // ISO-8601
}
