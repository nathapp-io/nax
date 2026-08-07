/**
 * ADR-022 Phase 1 — Fix Strategy and Cycle orchestration types.
 *
 * These types sit above runRetryLoop and model the outer iteration history:
 * which strategies ran, what findings looked like before/after, and how to
 * classify progress across multiple fix attempts.
 *
 * Only types live here; behaviour is in cycle.ts (ADR-022 Phase 2).
 */

import type { Operation } from "@/operations/types";
import type { Finding } from "./types";

// ─── Iteration record ────────────────────────────────────────────────────────

export type IterationOutcome =
  | "resolved" // findingsAfter is empty
  | "partial" // findingsAfter is a strict subset of findingsBefore
  | "regressed" // findingsAfter contains new findings not in findingsBefore (same source)
  | "unchanged" // findingsAfter equals findingsBefore (same files+rules+lines)
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
  costUsd?: number;
}

export interface Iteration<F extends Finding = Finding> {
  /** 1-indexed. */
  iterationNum: number;
  /** Findings observed before the iteration ran. */
  findingsBefore: F[];
  /**
   * Strategies that ran during this iteration. At least one entry when the
   * iteration is produced by runFixCycle (one per strategy that ran).
   *
   * Exception: carry-forward iterations recorded by review orchestrators
   * (e.g. adversarial) have fixesApplied: [] because the fix ran in the
   * implementation session outside the FixCycle. The rendered table shows "-"
   * in the "Strategies run" column for these rows.
   */
  fixesApplied: FixApplied[];
  /** Findings observed after the iteration ran. */
  findingsAfter: F[];
  /**
   * Exact `findingKey(f)` per entry in the pre-iteration findings, in array
   * order. Set by `recordIteration`; omitted on carry-forward iterations
   * recorded by review orchestrators (which retain the array form above).
   * Identities match `classifyOutcome` so the iteration record can answer
   * "same defect or different?" without re-deriving the keys.
   */
  findingKeysBefore?: string[];
  /** Mirror of `findingKeysBefore` for the post-iteration findings. */
  findingKeysAfter?: string[];
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
  outcome: IterationOutcome;
  startedAt: string; // ISO-8601
  finishedAt: string; // ISO-8601
}

// ─── Cycle result ────────────────────────────────────────────────────────────

/** Structured return from a validate callback, enabling short-circuit signalling. */
export interface ValidateResult<F extends Finding> {
  readonly findings: readonly F[];
  readonly shortCircuited?: boolean;
}

export type FixCycleExitReason =
  | "resolved"
  | "no-strategy"
  | "max-attempts-total"
  | "max-attempts-per-strategy"
  | "validator-error"
  | "bail-when"
  | "agent-gave-up"
  | "validate-short-circuit";

export interface FixCycleResult<F extends Finding = Finding> {
  iterations: Iteration<F>[];
  finalFindings: F[];
  exitReason: FixCycleExitReason;
  /** Strategy name that hit its maxAttempts cap. Set when exitReason is "max-attempts-per-strategy". */
  exhaustedStrategy?: string;
  /** Human-readable detail from strategy.bailWhen(). Set when exitReason is "bail-when". */
  bailDetail?: string;
  /** Reason text from the agent's UNRESOLVED sentinel. Set when exitReason is "agent-gave-up". */
  unresolvedDetail?: string;
  /** Total cost of all fix attempts in the cycle. Only present when strategies surface cost via extractApplied. */
  costUsd?: number;
}

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * Context passed to validate and buildInput. Structural superset of CallContext
 * with storyId made required (parallel logging discipline). Satisfies CallContext
 * so runFixCycle can pass it directly to callOp.
 */
export type FixCycleContext = import("../operations/types").CallContext & {
  readonly storyId: string;
};

// ─── Config ──────────────────────────────────────────────────────────────────

export interface FixCycleConfig {
  /** Hard cap on total fix invocations across all strategies. Default: 10. */
  maxAttemptsTotal: number;
  /** How many times to retry the validator on throw before terminal exit. Default: 1. */
  validatorRetries: number;
}

// ─── Strategy ────────────────────────────────────────────────────────────────

export interface FixStrategy<
  F extends Finding,
  I,
  O,
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; C is opaque at the cycle layer
  C = any,
> {
  name: string;

  /**
   * Returns true for findings this strategy should fix. Must be discriminating
   * (by source, category, fixTarget, or file pattern) — never `() => true`.
   */
  appliesTo: (finding: F) => boolean;

  /**
   * Optional fallback selector consulted only when findings.length === 0 (e.g.
   * acceptance fast-path verdicts that produce no structured findings). When
   * unset, the strategy is skipped in empty-findings iterations.
   */
  appliesToVerdict?: (verdict: string) => boolean;

  fixOp: Operation<I, O, C>;

  /**
   * Build the input for fixOp. Captures closure context (diagnosis, verdict,
   * test output, packageDir) — do not thread extras through FixCycleContext.
   *
   * `findings` is pre-filtered to only the findings where appliesTo returned
   * true. For empty-findings iterations (appliesToVerdict path), it is [].
   */
  buildInput: (findings: F[], priorIterations: Iteration<F>[], ctx: FixCycleContext) => I;

  /**
   * Optional: extract targetFiles, summary, and cost from the op output for FixApplied
   * record-keeping. When absent, targetFiles defaults to [], summary to "", and costUsd
   * is omitted ( FixApplied.costUsd stays undefined).
   */
  extractApplied?: (
    output: O,
    input: I,
  ) =>
    | { targetFiles?: string[]; summary?: string; costUsd?: number; unresolved?: string }
    | Promise<{ targetFiles?: string[]; summary?: string; costUsd?: number; unresolved?: string }>;

  /**
   * Optional bail predicate called before each iteration. Return a non-null
   * string reason to exit with exitReason "bail-when". Returning null continues.
   */
  bailWhen?: (priorIterations: readonly Iteration<F>[]) => string | null;

  /** Per-strategy attempt cap. Counted via fixesApplied[].strategyName. */
  maxAttempts: number;

  /**
   * Co-run discipline. Default (undefined or "exclusive") means this strategy
   * runs alone — all other matching strategies are skipped for this iteration.
   * "co-run-sequential" means run alongside other co-run-sequential strategies
   * in declaration order.
   */
  coRun?: "exclusive" | "co-run-sequential";
}

// ─── Cycle ───────────────────────────────────────────────────────────────────

export interface FixCycle<F extends Finding> {
  /** Mutable: updated to findingsAfter at the end of each iteration. */
  findings: F[];
  /** Mutable: pushed to at the end of each iteration. */
  iterations: Iteration<F>[];
  /**
   * Iterations completed by earlier cycles for the same story/tier; never mutated by
   * this cycle. Cap checks, terminal-exhaustion counters, and `bailWhen` predicates
   * read the concatenation `[...priorIterations, ...iterations]`; `cycle.iterations`
   * and `FixCycleResult.iterations` continue to report only this cycle.
   *
   * Construction of this array is the caller's responsibility (US-001/US-003).
   */
  priorIterations?: readonly Iteration<F>[];
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are coherent per-strategy
  strategies: FixStrategy<F, any, any, any>[];
  /**
   * Single validator for the cycle. Runs once per iteration, after all co-run
   * strategies complete. On throw, retried config.validatorRetries times before
   * exiting with "validator-error".
   *
   * `strategiesRun` is an optional list of strategy names that just ran in this
   * iteration. Implementations may use it to scope re-validation to only the
   * phases relevant to those strategies (e.g. skipping the full test suite when
   * only a lint-fix strategy ran).
   */
  validate: (
    ctx: FixCycleContext,
    opts: { mode: "full" | "lite"; strategiesRun?: readonly string[] },
  ) => Promise<F[] | ValidateResult<F>>;
  config: FixCycleConfig;
  /**
   * Optional verdict string used to bias strategy selection when findings is
   * empty. Passed to strategy.appliesToVerdict when findings.length === 0.
   */
  verdict?: string;
}
