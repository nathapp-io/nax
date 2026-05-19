import { NaxError } from "../errors";
import type { FixCycleContext, FixStrategy } from "../findings";
import { getSafeLogger } from "../logger";
import { adversarialReviewOp, implementerOp, semanticReviewOp, testWriterOp, verifierOp } from "../operations";
import type {
  AdversarialReviewInput,
  CallContext,
  ImplementerInput,
  RunOperation,
  SemanticReviewInput,
  TestWriterInput,
  VerifierInput,
} from "../operations";
import { callOp } from "../operations/call";
import type { ReviewCheckResult } from "../review/types";
import { errorMessage } from "../utils/errors";

// Mirrors findings/cycle.ts:selectExecutionGroup — exclusive strategy wins,
// otherwise all co-run-sequential strategies run in declaration order.
function selectExecutionGroup(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O are opaque here
  strategies: readonly FixStrategy<any, unknown, unknown, unknown>[],
  failures: readonly ReviewCheckResult[],
  // biome-ignore lint/suspicious/noExplicitAny: see above
): FixStrategy<any, unknown, unknown, unknown>[] {
  const active = strategies.filter((strategy) => failures.some((failure) => strategy.appliesTo(failure)));
  if (active.length === 0) return [];
  const exclusive = active.find((strategy) => !strategy.coRun || strategy.coRun === "exclusive");
  if (exclusive) return [exclusive];
  return active.filter((strategy) => strategy.coRun === "co-run-sequential");
}

export const _storyOrchestratorDeps = {
  callOp,
  selectExecutionGroup,
};

export interface OrchestratorSlot<I, O, C> {
  readonly op: RunOperation<I, O, C>;
  readonly input: I;
}

export interface RectificationPhaseOptions {
  readonly maxAttempts: number;
  // biome-ignore lint/suspicious/noExplicitAny: rectification strategies are heterogeneous here
  readonly strategies: FixStrategy<any, unknown, unknown, unknown>[];
  readonly abortOnIncreasingFailures: boolean;
}

export interface StoryOrchestratorResult {
  readonly success: boolean;
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  readonly phaseOutputs: Record<string, unknown>;
}

type PhaseKind = "test-writer" | "implementer" | "verifier" | "semantic-review" | "adversarial-review";
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous slot list is intentionally erased internally
type AnySlot = { op: RunOperation<any, any, any>; input: unknown };

interface InternalPhase {
  readonly kind: PhaseKind;
  readonly slot: AnySlot;
}

interface InternalBuildState {
  implementer?: InternalPhase;
  testWriter?: InternalPhase;
  verifier?: InternalPhase;
  semanticReview?: InternalPhase;
  adversarialReview?: InternalPhase;
  rectification?: RectificationPhaseOptions;
}

const CANONICAL_ORDER: readonly PhaseKind[] = [
  "test-writer",
  "implementer",
  "verifier",
  "semantic-review",
  "adversarial-review",
];

function isSlot<I, O, C>(value: unknown): value is OrchestratorSlot<I, O, C> {
  return (
    value !== null &&
    typeof value === "object" &&
    "op" in value &&
    "input" in value &&
    typeof (value as { op?: { kind?: string } }).op?.kind === "string"
  );
}

function setPhase(state: InternalBuildState, kind: PhaseKind, slot: AnySlot): void {
  if (kind === "test-writer") state.testWriter = { kind, slot };
  else if (kind === "implementer") state.implementer = { kind, slot };
  else if (kind === "verifier") state.verifier = { kind, slot };
  else if (kind === "semantic-review") state.semanticReview = { kind, slot };
  else state.adversarialReview = { kind, slot };
}

function collectOrderedPhases(state: InternalBuildState): InternalPhase[] {
  return CANONICAL_ORDER.flatMap((kind) => {
    if (kind === "test-writer" && state.testWriter) return [state.testWriter];
    if (kind === "implementer" && state.implementer) return [state.implementer];
    if (kind === "verifier" && state.verifier) return [state.verifier];
    if (kind === "semantic-review" && state.semanticReview) return [state.semanticReview];
    if (kind === "adversarial-review" && state.adversarialReview) return [state.adversarialReview];
    return [];
  });
}

function phasePassed(output: unknown): boolean {
  if (output === null || output === undefined || typeof output !== "object") {
    return true;
  }

  const record = output as Record<string, unknown>;
  if ("success" in record) {
    return record.success !== false;
  }
  if ("passed" in record) {
    return record.passed !== false;
  }
  return true;
}

function collectReviewFailures(output: unknown, check: ReviewCheckResult["check"]): ReviewCheckResult[] {
  if (output === null || output === undefined || typeof output !== "object") {
    return [];
  }

  const record = output as Record<string, unknown>;
  const findings = Array.isArray(record.findings) ? record.findings : [];
  const success =
    "success" in record ? record.success === true : "passed" in record ? record.passed === true : findings.length === 0;

  if (success) {
    return [];
  }

  return [
    {
      check,
      success: false,
      command: "",
      exitCode: 1,
      output: "",
      durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
      findings: findings as ReviewCheckResult["findings"],
    },
  ];
}

function gatherRectificationFailures(
  phaseOutputs: Record<string, unknown>,
  verifierPhase: InternalPhase,
  semanticPhase: InternalPhase | undefined,
  adversarialPhase: InternalPhase | undefined,
): ReviewCheckResult[] {
  const failures: ReviewCheckResult[] = [];

  failures.push(...collectReviewFailures(phaseOutputs[verifierPhase.slot.op.name], "test"));
  if (semanticPhase) {
    failures.push(...collectReviewFailures(phaseOutputs[semanticPhase.slot.op.name], "semantic"));
  }
  if (adversarialPhase) {
    failures.push(...collectReviewFailures(phaseOutputs[adversarialPhase.slot.op.name], "adversarial"));
  }

  return failures;
}

async function runPhase(
  ctx: CallContext,
  phase: InternalPhase,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
): Promise<unknown> {
  const scope = ctx.runtime.costAggregator.openScope();
  try {
    const output = await _storyOrchestratorDeps.callOp(
      { ...ctx, scopeId: scope.scopeId },
      phase.slot.op,
      phase.slot.input,
    );
    phaseOutputs[phase.slot.op.name] = output;
    return output;
  } finally {
    phaseCosts[phase.slot.op.name] = (phaseCosts[phase.slot.op.name] ?? 0) + scope.snapshot().totalCostUsd;
    scope.close();
  }
}

/**
 * Run the rectification loop.
 *
 * Per spec §2D:
 *  - Failures aggregate verifier + semantic + adversarial outputs (fed to strategies).
 *  - Termination/abort math keys on the verifier slot only — semantic/adversarial
 *    outputs are stale between iterations (only the verifier is re-run), so mixing
 *    them into the abort heuristic produced false positives (H4).
 *  - Implementer warm-lifetime handle reuse is owned by callOp middleware via
 *    `implementerOp.session.lifetime === "warm"`; the orchestrator does not manage
 *    a separate SessionKeeper (the previous one was dead code — H3).
 *  - Strategy selection mirrors findings/cycle.ts:selectExecutionGroup (H2/M3).
 */
async function runRectification(
  ctx: CallContext,
  state: InternalBuildState,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
): Promise<void> {
  const rectification = state.rectification;
  const verifierPhase = state.verifier;
  if (!rectification || !verifierPhase) {
    return;
  }

  const countVerifierFailures = (): number =>
    collectReviewFailures(phaseOutputs[verifierPhase.slot.op.name], "test").length;

  let priorVerifierFailureCount = countVerifierFailures();
  let attempts = 0;

  while (attempts < rectification.maxAttempts) {
    if (ctx.runtime.signal?.aborted) {
      return;
    }

    const failures = gatherRectificationFailures(
      phaseOutputs,
      verifierPhase,
      state.semanticReview,
      state.adversarialReview,
    );
    if (failures.length === 0) {
      return;
    }

    const group = _storyOrchestratorDeps.selectExecutionGroup(rectification.strategies, failures);
    if (group.length === 0) {
      return;
    }

    for (const strategy of group) {
      const relevant = failures.filter((failure) => strategy.appliesTo(failure));
      const input = strategy.buildInput(relevant, [], ctx as FixCycleContext);
      const fixPhase: InternalPhase = {
        kind: "implementer",
        slot: { op: strategy.fixOp as RunOperation<unknown, unknown, unknown>, input },
      };
      await runPhase(ctx, fixPhase, phaseCosts, phaseOutputs);
    }
    attempts += 1;

    const verifierOutput = await runPhase(ctx, verifierPhase, phaseCosts, phaseOutputs);
    if (phasePassed(verifierOutput)) {
      return;
    }

    const nextVerifierFailureCount = countVerifierFailures();
    if (rectification.abortOnIncreasingFailures && nextVerifierFailureCount > priorVerifierFailureCount) {
      return;
    }
    priorVerifierFailureCount = nextVerifierFailureCount;
  }
}

export class ExecutionPlan {
  constructor(
    private readonly ctx: CallContext,
    private readonly state: InternalBuildState,
  ) {}

  async run(): Promise<StoryOrchestratorResult> {
    const phaseCosts: Record<string, number> = {};
    const phaseOutputs: Record<string, unknown> = {};
    const startedAt = Date.now();
    const logger = getSafeLogger();

    for (const phase of collectOrderedPhases(this.state)) {
      try {
        await runPhase(this.ctx, phase, phaseCosts, phaseOutputs);
      } catch (error) {
        logger?.error("story-orchestrator", "Phase threw unexpected error", {
          storyId: this.ctx.storyId,
          phase: phase.slot.op.name,
          error: errorMessage(error),
        });
        throw error;
      }
    }

    await runRectification(this.ctx, this.state, phaseCosts, phaseOutputs);

    // Aggregate success across every op that produced output, including fix-ops
    // dispatched during rectification (spec §2C / AC: "success === false when
    // any op returns { success: false }").
    const success = Object.values(phaseOutputs).every((output) => phasePassed(output));
    const totalCostUsd = Object.values(phaseCosts).reduce((sum, cost) => sum + cost, 0);

    return {
      success,
      phaseCosts,
      totalCostUsd,
      durationMs: Date.now() - startedAt,
      phaseOutputs,
    };
  }
}

export class StoryOrchestratorBuilder {
  private readonly state: InternalBuildState = {};

  addImplementer<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addImplementer(input: ImplementerInput): this;
  addImplementer(value: ImplementerInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "implementer", isSlot(value) ? value : { op: implementerOp, input: value });
    return this;
  }

  addTestWriter<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addTestWriter(input: TestWriterInput): this;
  addTestWriter(value: TestWriterInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "test-writer", isSlot(value) ? value : { op: testWriterOp, input: value });
    return this;
  }

  addVerifier<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addVerifier(input: VerifierInput): this;
  addVerifier(value: VerifierInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "verifier", isSlot(value) ? value : { op: verifierOp, input: value });
    return this;
  }

  addSemanticReview<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addSemanticReview(input: SemanticReviewInput): this;
  addSemanticReview(value: SemanticReviewInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "semantic-review", isSlot(value) ? value : { op: semanticReviewOp, input: value });
    return this;
  }

  addAdversarialReview<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addAdversarialReview(input: AdversarialReviewInput): this;
  addAdversarialReview(value: AdversarialReviewInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "adversarial-review", isSlot(value) ? value : { op: adversarialReviewOp, input: value });
    return this;
  }

  addRectification(opts: RectificationPhaseOptions): this {
    this.state.rectification = opts;
    return this;
  }

  build(ctx: CallContext): ExecutionPlan {
    if (!this.state.implementer) {
      throw new NaxError(
        "StoryOrchestratorBuilder.build(): addImplementer() must be called before build()",
        "ORCHESTRATOR_NO_IMPLEMENTER",
        { stage: "execution" },
      );
    }

    return new ExecutionPlan(ctx, { ...this.state });
  }
}
