import type { NonBlockingFixConfig } from "@/config/selectors";
import { NaxError } from "@/errors";
import type { Finding, FixCycleContext, FixStrategy } from "@/findings";
import type { CallContext } from "@/operations";
import {
  adversarialReviewOp,
  fullSuiteGateOp,
  greenfieldGateOp,
  implementerOp,
  lintCheckOp,
  mutationCheckOp,
  semanticReviewOp,
  testPresenceGateOp,
  testWriterOp,
  typecheckCheckOp,
  verifierOp,
  verifyScopedOp,
} from "@/operations";
import type {
  AdversarialReviewInput,
  FullSuiteGateInput,
  GreenfieldGateInput,
  ImplementerInput,
  LintCheckInput,
  MutationCheckInput,
  SemanticReviewInput,
  TestPresenceGateInput,
  TestWriterInput,
  TypecheckCheckInput,
  VerifierInput,
  VerifyScopedInput,
} from "@/operations";
import { ExecutionPlan } from "./execution-plan";
import { isSlot, setPhase } from "./phase-state";
import type { InternalBuildState, OrchestratorSlot, RectificationPhaseOptions } from "./types";

export class StoryOrchestratorBuilder {
  private readonly state: InternalBuildState = {};

  addImplementer<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addImplementer(input: ImplementerInput): this;
  addImplementer(value: ImplementerInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "implementer", isSlot(value) ? value : { op: implementerOp, input: value });
    return this;
  }

  addTestWriter<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addTestWriter(input: TestWriterInput): this;
  addTestWriter(value: TestWriterInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "test-writer", isSlot(value) ? value : { op: testWriterOp, input: value });
    return this;
  }

  addGreenfieldGate<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addGreenfieldGate(input: GreenfieldGateInput): this;
  addGreenfieldGate(value: GreenfieldGateInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "greenfield-gate", isSlot(value) ? value : { op: greenfieldGateOp, input: value });
    return this;
  }

  addTestPresenceGate<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addTestPresenceGate(input: TestPresenceGateInput): this;
  addTestPresenceGate(value: TestPresenceGateInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "test-presence-gate", isSlot(value) ? value : { op: testPresenceGateOp, input: value });
    return this;
  }

  addVerifier<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addVerifier(input: VerifierInput): this;
  addVerifier(value: VerifierInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "verifier", isSlot(value) ? value : { op: verifierOp, input: value });
    return this;
  }

  addFullSuiteGate<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addFullSuiteGate(input: FullSuiteGateInput): this;
  addFullSuiteGate(value: FullSuiteGateInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "full-suite-gate", isSlot(value) ? value : { op: fullSuiteGateOp, input: value });
    return this;
  }

  addMutationCheck<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addMutationCheck(input: MutationCheckInput): this;
  addMutationCheck(value: MutationCheckInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "mutation-check", isSlot(value) ? value : { op: mutationCheckOp, input: value });
    return this;
  }

  addVerifyScoped<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addVerifyScoped(input: VerifyScopedInput): this;
  addVerifyScoped(value: VerifyScopedInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "verify-scoped", isSlot(value) ? value : { op: verifyScopedOp, input: value });
    return this;
  }

  addLintCheck<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addLintCheck(input: LintCheckInput): this;
  addLintCheck(value: LintCheckInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "lint-check", isSlot(value) ? value : { op: lintCheckOp, input: value });
    return this;
  }

  addTypecheckCheck<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addTypecheckCheck(input: TypecheckCheckInput): this;
  addTypecheckCheck(value: TypecheckCheckInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "typecheck-check", isSlot(value) ? value : { op: typecheckCheckOp, input: value });
    return this;
  }

  addSemanticReview<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addSemanticReview(input: SemanticReviewInput): this;
  addSemanticReview(value: SemanticReviewInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "semantic-review", isSlot(value) ? value : { op: semanticReviewOp, input: value });
    return this;
  }

  addAdversarialReview<I, O, C, D>(slot: OrchestratorSlot<I, O, C, D>): this;
  addAdversarialReview(input: AdversarialReviewInput): this;
  addAdversarialReview(value: AdversarialReviewInput | OrchestratorSlot<unknown, unknown, unknown, unknown>): this {
    setPhase(this.state, "adversarial-review", isSlot(value) ? value : { op: adversarialReviewOp, input: value });
    return this;
  }

  addRectification(opts: RectificationPhaseOptions): this {
    this.state.rectification = opts;
    return this;
  }

  /** ADR-024 — set the non-blocking best-effort fix config + scope-aware strategy set. */
  addNonBlockingFix(
    cfg: NonBlockingFixConfig,
    strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
    postValidate?: (findings: Finding[], ctx: FixCycleContext) => Promise<Finding[]>,
  ): this {
    this.state.nonBlockingFix = cfg;
    this.state.nonBlockingFixStrategies = strategies;
    this.state.nonBlockingFixPostValidate = postValidate;
    return this;
  }

  build(ctx: CallContext, opts: { isThreeSession?: boolean } = {}): ExecutionPlan {
    if (!this.state.implementer) {
      throw new NaxError(
        "StoryOrchestratorBuilder.build(): addImplementer() must be called before build()",
        "ORCHESTRATOR_NO_IMPLEMENTER",
        { stage: "execution" },
      );
    }

    return new ExecutionPlan(ctx, { ...this.state }, opts.isThreeSession ?? false);
  }
}
