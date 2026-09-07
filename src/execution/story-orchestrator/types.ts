import type { NonBlockingFixConfig } from "@/config/selectors";
import type { Finding, FixCycleContext, FixStrategy } from "@/findings";
import type { DeterministicOperation, RunOperation } from "@/operations";
import type { AdvisoryFinding } from "@/review/review-audit";
import type { NbfFlakeTriageTransaction } from "./nbf-flake-triage";
import type { RepoScopedFixRecord } from "./repo-scoped-fix-record";

export const EXHAUSTED_EXIT_REASONS = new Set<string>([
  "max-attempts-total",
  "max-attempts-per-strategy",
  "bail-when",
  "no-strategy",
  "agent-gave-up",
  "validate-short-circuit",
]);

export const TDD_OP_NAMES = new Set<string>(["test-writer", "implementer", "verifier"]);

/**
 * A phase slot handed to `StoryOrchestratorBuilder.addX()`.
 *
 * `op` is the same union the runtime accepts (`AnySlot`): the orchestrator
 * dispatches deterministic ops through `callOp` exactly as it does run ops, so
 * the public signature must not be narrower than `setPhase`'s. `D` is the
 * deterministic op's injectable deps seam and defaults to `void`, which is the
 * `DeterministicOperation` default — a three-argument `OrchestratorSlot<I, O, C>`
 * keeps its previous meaning.
 */
export interface OrchestratorSlot<I, O, C, D = void> {
  readonly op: RunOperation<I, O, C> | DeterministicOperation<I, O, C, D>;
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
  /** Abort rectification when no progress is made for several consecutive iterations
   * (US-1496). Predicate wiring lives in US-002. Defaults to true when omitted. */
  readonly abortOnNoProgress?: boolean;
  /** Consecutive no-progress iterations required before abortOnNoProgress bails.
   * Defaults to 3 when omitted (one higher than count bail's 2). */
  readonly consecutiveNoProgressToBail?: number;
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
  /**
   * One entry per repo-scoped fix dispatch (#1658). Non-empty means this story's
   * commit may carry a repair to something the story did not break — the
   * repo-scoped strategy edits outside story scope by design. Undefined when the
   * fallthrough never fired, which is the overwhelmingly common case.
   */
  readonly repoScopedFixes?: readonly RepoScopedFixRecord[];
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
      /** Sub-threshold findings retained as advisory — carries `meta.coverageGap`. */
      advisoryFindings?: readonly AdvisoryFinding[];
      /** Prior findings the reviewer resolved or withdrew this round — see `review/acks.ts` (#1423). */
      acks?: readonly unknown[];
      /** The blockingThreshold the op resolved and used to compute `passed` (US-003 AC8 precedent). */
      blockingThreshold?: "error" | "warning" | "info";
    }
  | {
      reviewer: "semantic" | "adversarial";
      parsed: false;
      passed?: boolean;
      failOpen?: boolean;
      looksLikeFail?: boolean;
      result: null;
      /**
       * Clipped preview of the output that could not be parsed. Without it a
       * give-up leaves only a byte count behind and is undiagnosable after the
       * fact — the raw response is not retained anywhere else.
       */
      unparsedPreview?: string;
      /**
       * Present here too (not just the parsed:true branch): a fail-open /
       * looksLikeFail give-up under a mis-configured threshold is exactly the
       * case issue #1889 needs this data for.
       */
      blockingThreshold?: "error" | "warning" | "info";
    };

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous slot list is intentionally erased internally
export type AnySlot = { op: RunOperation<any, any, any> | DeterministicOperation<any, any, any, any>; input: unknown };

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

/**
 * Shared by `full-suite-rectify` and `repo-scoped-test-fix` (#1654) — the two
 * strategies that fix failing tests through `fullSuiteRectifyOp`. Named so the
 * two cannot drift: they run the same op under the same declaration protocol,
 * so a phase that goes stale for one goes stale for both.
 */
const FULL_SUITE_RECTIFY_REVALIDATION: readonly PhaseKind[] = [
  "lint-check",
  "typecheck-check",
  "full-suite-gate",
  "verifier",
  "verify-scoped",
  "semantic-review",
  "adversarial-review",
];

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
  "full-suite-rectify": FULL_SUITE_RECTIFY_REVALIDATION,
  // #1654 — the repo-scoped fallthrough claimant for the same failing-test
  // findings, through the same op and the same test-edit declaration protocol.
  // It edits a wider set of FILES, but not a different set of PHASES: the
  // verifier's verdict and both reviews go stale in exactly the same way.
  //
  // Declared rather than left to `phasesToRevalidate`'s unknown-strategy
  // fallback, which returns ALL phases — and "all" includes `test-writer`,
  // `greenfield-gate`, and `implementer`, so a strategy that only fixed a
  // failing test would re-run the story's authoring sessions.
  "repo-scoped-test-fix": FULL_SUITE_RECTIFY_REVALIDATION,
};

/**
 * ADR-024 — overrides that repurpose the rectification harness for the
 * non-blocking best-effort pass. All optional; omitting them preserves the
 * blocking-cycle behavior exactly.
 */
export interface RectificationOverrides {
  /**
   * Seed findings instead of `gatherRectificationFindings(...)`.
   *
   * Load-bearing beyond seeding: setting this field IS the ADR-024 nbf discriminator, and
   * `runRectification` derives two further behaviours from it — flake triage is skipped
   * (#1383) and the verifier-SSOT carve-out is disabled in the validate sweep, with the
   * quarantine-memo exclusion applied there instead (#1401). A caller that seeds findings
   * for some other reason inherits all three. `ExecutionPlan.run`'s nbf branch is currently
   * the only such caller; a second one should promote this to an explicit flag.
   */
  initialFindings?: readonly Finding[];
  /** Transaction-local, read-only gate triage for the ADR-024 NBF path (#1404). */
  nbfFlakeTriage?: NbfFlakeTriageTransaction;
  /**
   * Gate failure keys as of the verifier-time baseline (`gateFailureKeys(phaseOutputs[gate])`
   * captured before rectification).
   *
   * Read by the validate sweep when the verifier-SSOT carve-out fires on a red gate: failures
   * present in this baseline stay exempt (the verifier already judged them unrelated), while
   * failures absent from it — i.e. regressions rectification itself introduced — are fed to
   * the fix cycle instead of being discarded (#1452). Omitting it means "no baseline known",
   * so every failure counts as a regression: the safe direction, since findings reach the
   * cycle rather than vanish.
   */
  gateBaselineKeys?: ReadonlySet<string>;
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
  /**
   * The plan's session model (`ExecutionPlan.isThreeSession`), not a behavioural
   * override. Threaded through so `runPhase` can resolve the right context-engine
   * stage (nax#1737 Phase B follow-up) for both the fix-op dispatch and the
   * revalidation sweep — without it, `isThreeSession` silently defaulted to `false`
   * inside rectification and a three-session run's revalidation `verifier` never
   * mapped to `tdd-verifier`.
   */
  isThreeSession?: boolean;
}

export interface RectificationResult {
  rectificationExhausted?: boolean;
  unfixedFindings?: readonly Finding[];
  /** Verifier diagnosed an incorrect test; automatic fixes must stop for human review. */
  terminalReviewRequired?: boolean;
  /** Validate short-circuited with empty findings — resume must still run scope-backfill phases. */
  liteScopeIncomplete?: boolean;
  /** Populated when exitReason is "agent-gave-up" — the implementer's UNRESOLVED: reason text. */
  unresolvedDetail?: string;
  /** One entry per repo-scoped fix dispatch (#1658). Omitted when none fired. */
  repoScopedFixes?: readonly RepoScopedFixRecord[];
}

export const STRICT_VERDICT_PHASE_NAMES = new Set<string>([
  "full-suite-gate",
  "verify-scoped",
  "lint-check",
  "typecheck-check",
  "verifier",
]);
