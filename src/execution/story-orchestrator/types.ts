import type { NonBlockingFixConfig } from "@/config/selectors";
import type { Finding, FixCycleContext, FixStrategy } from "@/findings";
import type { DeterministicOperation, RunOperation } from "@/operations";

export const EXHAUSTED_EXIT_REASONS = new Set<string>([
  "max-attempts-total",
  "max-attempts-per-strategy",
  "bail-when",
  "no-strategy",
  "agent-gave-up",
  "validate-short-circuit",
]);

export const TDD_OP_NAMES = new Set<string>(["test-writer", "implementer", "verifier"]);

export interface OrchestratorSlot<I, O, C> {
  readonly op: RunOperation<I, O, C>;
  readonly input: I;
}

export interface RectificationPhaseOptions {
  readonly maxAttempts: number;
  // biome-ignore lint/suspicious/noExplicitAny: rectification strategies are heterogeneous over their fixOp input/output
  readonly strategies: FixStrategy<Finding, any, any, any>[];
  readonly abortOnIncreasingFailures: boolean;
  /** Consecutive regressing iterations required before the increasing-failures
   * bail fires. Defaults to 1 (legacy single-iteration behaviour) when omitted. */
  readonly consecutiveIncreasesToBail?: number;
  /** Optional: transform findings after validate() returns, before next iteration's strategy selection. */
  readonly postValidate?: (findings: Finding[], ctx: FixCycleContext) => Promise<Finding[]>;
}

export interface StoryOrchestratorResult {
  readonly success: boolean;
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  readonly phaseOutputs: Record<string, unknown>;
  readonly rectificationExhausted?: boolean;
  readonly unfixedFindings?: readonly Finding[];
  /** Set when rectification short-circuited with empty findings — resume ran scope-backfill. */
  readonly liteScopeIncomplete?: boolean;
  /**
   * True when rectification introduced full-suite-gate failures absent from the
   * verifier-time baseline — the verifier verdict is stale and no longer exempts
   * the gate (carve-out staleness fix). Surfaced so post-run categorization can
   * route the failure to escalation as `tests-failing`.
   */
  readonly gateRegressedDuringRect?: boolean;
  /**
   * Names of configured review phases (semantic-review / adversarial-review) that
   * never executed before the verdict — e.g. the post-rectification resume loop
   * broke at a still-red full-suite-gate (canonical pos 4) before reaching the
   * review (pos 9-10). A non-empty list forces success=false and routes to
   * escalation via `deriveTddFailureCategory` → `review-incomplete`, so the story
   * cannot pass on the verifier-SSOT carve-out without semantic/adversarial
   * judgment (US-002 regression).
   */
  readonly missingRequiredReviewPhases?: readonly string[];
  /** When rectification exited via agent-gave-up, the implementer's UNRESOLVED: reason text.
   *  Surfaced into the escalation reason so the next tier's priorErrors carries the diagnosis. */
  readonly unresolvedDetail?: string;
}

export type PhaseKind =
  | "test-writer"
  | "greenfield-gate"
  | "implementer"
  | "test-presence-gate"
  | "full-suite-gate"
  | "mutation-check"
  | "verifier"
  | "verify-scoped"
  | "lint-check"
  | "typecheck-check"
  | "semantic-review"
  | "adversarial-review";

export type DroppedFindingSummary = {
  code?: string;
  severity?: string;
  file?: string;
  line?: number;
  issue?: string;
  acIndex?: number;
};

export type ReviewDecisionPayload =
  | {
      reviewer: "semantic" | "adversarial";
      parsed: true;
      passed: boolean;
      result: { passed: boolean; findings: unknown[] };
      acDropped?: DroppedFindingSummary[];
    }
  | {
      reviewer: "semantic" | "adversarial";
      parsed: false;
      passed?: boolean;
      failOpen?: boolean;
      looksLikeFail?: boolean;
      result: null;
    };

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous slot list is intentionally erased internally
export type AnySlot = { op: RunOperation<any, any, any> | DeterministicOperation<any, any, any>; input: unknown };

export interface InternalPhase {
  readonly kind: PhaseKind;
  readonly slot: AnySlot;
}

export interface InternalBuildState {
  implementer?: InternalPhase;
  testWriter?: InternalPhase;
  greenfieldGate?: InternalPhase;
  testPresenceGate?: InternalPhase;
  fullSuiteGate?: InternalPhase;
  mutationCheck?: InternalPhase;
  verifier?: InternalPhase;
  verifyScoped?: InternalPhase;
  lintCheck?: InternalPhase;
  typecheckCheck?: InternalPhase;
  semanticReview?: InternalPhase;
  adversarialReview?: InternalPhase;
  rectification?: RectificationPhaseOptions;
  /** ADR-024 — non-blocking best-effort fix config, resolved at build time. */
  nonBlockingFix?: NonBlockingFixConfig;
  /** ADR-024 — scope-aware best-effort strategy set, built at plan time. */
  nonBlockingFixStrategies?: FixStrategy<Finding, unknown, unknown, unknown>[];
  /** ADR-024 — postValidate bound to nbSink; drains declarations from the nbf cycle (#1227). */
  nonBlockingFixPostValidate?: (findings: Finding[], ctx: FixCycleContext) => Promise<Finding[]>;
}

export const CANONICAL_ORDER: readonly PhaseKind[] = [
  "test-writer",
  "greenfield-gate",
  "implementer",
  "test-presence-gate",
  "full-suite-gate",
  "mutation-check",
  "verifier",
  "verify-scoped",
  "lint-check",
  "typecheck-check",
  "semantic-review",
  "adversarial-review",
];

export const PHASE_KIND_TO_STATE_KEY: Record<PhaseKind, keyof InternalBuildState> = {
  "test-writer": "testWriter",
  "greenfield-gate": "greenfieldGate",
  implementer: "implementer",
  "test-presence-gate": "testPresenceGate",
  "full-suite-gate": "fullSuiteGate",
  "mutation-check": "mutationCheck",
  verifier: "verifier",
  "verify-scoped": "verifyScoped",
  "lint-check": "lintCheck",
  "typecheck-check": "typecheckCheck",
  "semantic-review": "semanticReview",
  "adversarial-review": "adversarialReview",
};

export const STRATEGY_TO_REVALIDATION_PHASES: Record<string, readonly PhaseKind[]> = {
  // Mechanical fixes are AST-preserving (import-sort, formatting, unused-var removal).
  // They cannot introduce semantic regressions, so only lint-check needs re-running.
  // If a mechanical fix strategy ever edits logic (not just style), widen this set.
  "mechanical-lintfix": ["lint-check"],
  "mechanical-formatfix": ["lint-check"],
  // autofix-implementer addresses semantic/adversarial review findings on source
  // code. It does NOT modify the test-writer/implementer TDD boundary, so the
  // verifier (TDD isolation judge) is intentionally excluded — the verifier is a
  // once-per-story phase, picked up by post-rectification-resume if not yet run.
  "autofix-implementer": ["lint-check", "typecheck-check", "full-suite-gate", "semantic-review", "adversarial-review"],
  // autofix-test-writer rewrites tests in response to adversarial-review findings.
  // It does not re-do the TDD test-writer/implementer pair, so verifier stays
  // excluded. Same once-per-story semantics as above.
  "autofix-test-writer": ["lint-check", "typecheck-check", "full-suite-gate", "adversarial-review"],
  // full-suite-rectify edits TEST code to fix failing tests — this legitimately
  // changes the verifier's verdict, so verifier IS re-judged. adversarial-review is
  // included because it specifically judges test quality/coverage: rewriting tests is
  // exactly when its prior verdict goes stale, so it must re-run rather than be read as
  // a pre-rectification pass by the post-rectification resume. (Audit #2.)
  "full-suite-rectify": [
    "lint-check",
    "typecheck-check",
    "full-suite-gate",
    "verifier",
    "verify-scoped",
    "semantic-review",
    "adversarial-review",
  ],
};

/**
 * ADR-024 — overrides that repurpose the rectification harness for the
 * non-blocking best-effort pass. All optional; omitting them preserves the
 * blocking-cycle behavior exactly.
 */
export interface RectificationOverrides {
  /** Seed findings instead of gatherRectificationFindings(...). */
  initialFindings?: readonly Finding[];
  /** Strategy set instead of state.rectification.strategies (scope filtering). */
  strategies?: FixStrategy<Finding, unknown, unknown, unknown>[];
  /** Phase kinds removed from validationPhases (e.g. the LLM reviews). */
  excludePhaseKinds?: readonly PhaseKind[];
  /** Phase kinds force-added to each revalidation sweep (e.g. verifier for test edits). */
  extraRevalidationKinds?: readonly PhaseKind[];
  /** maxAttemptsTotal override (1 + regressionAttempts for best-effort). */
  maxAttempts?: number;
  /** Override postValidate — nbf path uses a closure bound to nbSink instead of the main sink. */
  postValidate?: (findings: Finding[], ctx: FixCycleContext) => Promise<Finding[]>;
  /**
   * Skip the gate-triage seam on this pass. Set by ExecutionPlan.run for the
   * post-rectification resume's second pass — gate findings were already triaged
   * on the initial pass, and the gate's runPhase overwrite drops the triaged
   * marker. This override keeps triage idempotent across both passes.
   */
  skipGateTriage?: boolean;
}

export interface RectificationResult {
  rectificationExhausted?: boolean;
  unfixedFindings?: readonly Finding[];
  /** Validate short-circuited with empty findings — resume must still run scope-backfill phases. */
  liteScopeIncomplete?: boolean;
  /** Populated when exitReason is "agent-gave-up" — the implementer's UNRESOLVED: reason text. */
  unresolvedDetail?: string;
}

export const STRICT_VERDICT_PHASE_NAMES = new Set<string>([
  "full-suite-gate",
  "verify-scoped",
  "lint-check",
  "typecheck-check",
  "verifier",
]);
