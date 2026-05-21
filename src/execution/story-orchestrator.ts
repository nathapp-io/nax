import { NaxError } from "../errors";
import type { Finding, FixCycle, FixCycleContext, FixStrategy, Iteration } from "../findings";
import { runFixCycle } from "../findings";
import { getSafeLogger } from "../logger";
import {
  adversarialReviewOp,
  fullSuiteGateOp,
  greenfieldGateOp,
  implementerOp,
  semanticReviewOp,
  testWriterOp,
  verifierOp,
} from "../operations";
import type {
  AdversarialReviewInput,
  CallContext,
  DeterministicOperation,
  FullSuiteGateInput,
  GreenfieldGateInput,
  ImplementerInput,
  Operation,
  RunOperation,
  SemanticReviewInput,
  TestWriterInput,
  VerifierInput,
} from "../operations";
import { callOp } from "../operations/call";
import { errorMessage } from "../utils/errors";
import { captureGitRef } from "../utils/git";

export const _storyOrchestratorDeps = {
  callOp,
  runFixCycle,
  captureGitRef,
};

const TDD_OP_NAMES = new Set<string>(["test-writer", "implementer", "verifier"]);

export interface OrchestratorSlot<I, O, C> {
  readonly op: RunOperation<I, O, C>;
  readonly input: I;
}

export interface RectificationPhaseOptions {
  readonly maxAttempts: number;
  // biome-ignore lint/suspicious/noExplicitAny: rectification strategies are heterogeneous over their fixOp input/output
  readonly strategies: FixStrategy<Finding, any, any, any>[];
  readonly abortOnIncreasingFailures: boolean;
}

export interface StoryOrchestratorResult {
  readonly success: boolean;
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  readonly phaseOutputs: Record<string, unknown>;
}

type PhaseKind =
  | "test-writer"
  | "greenfield-gate"
  | "implementer"
  | "full-suite-gate"
  | "verifier"
  | "semantic-review"
  | "adversarial-review";
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous slot list is intentionally erased internally
type AnySlot = { op: RunOperation<any, any, any> | DeterministicOperation<any, any, any>; input: unknown };

interface InternalPhase {
  readonly kind: PhaseKind;
  readonly slot: AnySlot;
}

interface InternalBuildState {
  implementer?: InternalPhase;
  testWriter?: InternalPhase;
  greenfieldGate?: InternalPhase;
  fullSuiteGate?: InternalPhase;
  verifier?: InternalPhase;
  semanticReview?: InternalPhase;
  adversarialReview?: InternalPhase;
  rectification?: RectificationPhaseOptions;
}

const CANONICAL_ORDER: readonly PhaseKind[] = [
  "test-writer",
  "greenfield-gate",
  "implementer",
  "full-suite-gate",
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

const PHASE_KIND_TO_STATE_KEY: Record<PhaseKind, keyof InternalBuildState> = {
  "test-writer": "testWriter",
  "greenfield-gate": "greenfieldGate",
  implementer: "implementer",
  "full-suite-gate": "fullSuiteGate",
  verifier: "verifier",
  "semantic-review": "semanticReview",
  "adversarial-review": "adversarialReview",
};

function setPhase(state: InternalBuildState, kind: PhaseKind, slot: AnySlot): void {
  const key = PHASE_KIND_TO_STATE_KEY[kind];
  if (state[key] !== undefined) {
    throw new NaxError(
      `StoryOrchestratorBuilder: addX was called twice for phase "${kind}"`,
      "ORCHESTRATOR_PHASE_DUPLICATE",
      { stage: "execution", kind },
    );
  }
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous slot widened intentionally
  (state as any)[key] = { kind, slot };
}

function collectOrderedPhases(state: InternalBuildState): InternalPhase[] {
  return CANONICAL_ORDER.flatMap((kind) => {
    if (kind === "test-writer" && state.testWriter) return [state.testWriter];
    if (kind === "greenfield-gate" && state.greenfieldGate) return [state.greenfieldGate];
    if (kind === "implementer" && state.implementer) return [state.implementer];
    if (kind === "full-suite-gate" && state.fullSuiteGate) return [state.fullSuiteGate];
    if (kind === "verifier" && state.verifier) return [state.verifier];
    if (kind === "semantic-review" && state.semanticReview) return [state.semanticReview];
    if (kind === "adversarial-review" && state.adversarialReview) return [state.adversarialReview];
    return [];
  });
}

function phasePassed(opName: string, output: unknown): boolean {
  if (output === null || output === undefined) {
    getSafeLogger()?.warn("story-orchestrator", "Phase produced no output — treating as pass", {
      storyId: undefined,
      phase: opName,
    });
    return true;
  }
  if (typeof output !== "object") return true;
  const r = output as Record<string, unknown>;
  if ("success" in r) return r.success !== false;
  if ("passed" in r) return r.passed !== false;
  getSafeLogger()?.warn("story-orchestrator", "Phase output has neither 'success' nor 'passed' — treating as pass", {
    storyId: undefined,
    phase: opName,
  });
  return true;
}

/**
 * Extract structured Findings from a phase output. Each op produces `findings: Finding[]`
 * in its parsed envelope (verifierOp / semanticReviewOp / adversarialReviewOp all conform);
 * we only need to read the array when the phase did not pass.
 */
function extractPhaseFindings(output: unknown): Finding[] {
  if (output === null || output === undefined || typeof output !== "object") {
    return [];
  }
  const record = output as Record<string, unknown>;
  const findings = Array.isArray(record.findings) ? (record.findings as Finding[]) : [];
  const success =
    "success" in record ? record.success === true : "passed" in record ? record.passed === true : findings.length === 0;
  return success ? [] : findings;
}

function gatherRectificationFindings(
  phaseOutputs: Record<string, unknown>,
  verifierPhase: InternalPhase,
  fullSuiteGatePhase: InternalPhase | undefined,
  semanticPhase: InternalPhase | undefined,
  adversarialPhase: InternalPhase | undefined,
): Finding[] {
  const findings: Finding[] = [];
  if (fullSuiteGatePhase) {
    findings.push(...extractPhaseFindings(phaseOutputs[fullSuiteGatePhase.slot.op.name]));
  }
  findings.push(...extractPhaseFindings(phaseOutputs[verifierPhase.slot.op.name]));
  if (semanticPhase) {
    findings.push(...extractPhaseFindings(phaseOutputs[semanticPhase.slot.op.name]));
  }
  if (adversarialPhase) {
    findings.push(...extractPhaseFindings(phaseOutputs[adversarialPhase.slot.op.name]));
  }
  return findings;
}

async function runPhase(
  ctx: CallContext,
  slot: AnySlot,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
): Promise<unknown> {
  const opName = slot.op.name;
  const isTddPhase = TDD_OP_NAMES.has(opName);

  const beforeRef = isTddPhase ? await _storyOrchestratorDeps.captureGitRef(ctx.packageDir) : undefined;
  const dispatchInput =
    isTddPhase && beforeRef
      ? { ...(slot.input as Record<string, unknown>), beforeRef }
      : slot.input;

  const scope = ctx.runtime.costAggregator.openScope();
  try {
    const output = await _storyOrchestratorDeps.callOp({ ...ctx, scopeId: scope.scopeId }, slot.op, dispatchInput);
    phaseOutputs[opName] = output;
    return output;
  } finally {
    phaseCosts[opName] = (phaseCosts[opName] ?? 0) + scope.snapshot().totalCostUsd;
    scope.close();
  }
}

/**
 * Wrap each strategy with a bailWhen predicate that fires when the last iteration's
 * findingsAfter count exceeds its findingsBefore count. Preserves user-supplied bailWhen
 * if present (user predicate wins). Returns the unchanged strategies when the option is off.
 */
function withIncreasingFailuresBail(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
  enabled: boolean,
): FixStrategy<Finding, unknown, unknown, unknown>[] {
  if (!enabled) return strategies;
  return strategies.map((strategy) => ({
    ...strategy,
    bailWhen: (iterations: Iteration<Finding>[]): string | null => {
      const userReason = strategy.bailWhen?.(iterations) ?? null;
      if (userReason !== null) return userReason;
      const last = iterations[iterations.length - 1];
      if (last && last.findingsAfter.length > last.findingsBefore.length) {
        return `failure count increased: ${last.findingsBefore.length} -> ${last.findingsAfter.length}`;
      }
      return null;
    },
  }));
}

/**
 * Run the rectification loop via `runFixCycle` (findings/cycle.ts) — the SSOT for
 * strategy selection, per-strategy attempt caps, bail predicates, outcome
 * classification, and iteration record-keeping. Replaces the ported
 * `selectExecutionGroup` that previously lived here (silent-drift risk vs ADR-022).
 *
 * Per spec §2D:
 *  - Failures aggregate verifier + semantic + adversarial findings on entry (fed to
 *    runFixCycle as initial `cycle.findings`).
 *  - `cycle.validate` re-runs the verifier only — semantic/adversarial outputs are
 *    stale between iterations, so the validator returns verifier-only findings to
 *    drive termination math.
 *  - `abortOnIncreasingFailures` is expressed as a per-strategy `bailWhen` wrapper
 *    so runFixCycle exits with reason "bail-when" when failures regress.
 *  - Implementer warm-lifetime handle reuse is owned by callOp middleware via
 *    `implementerOp.session.lifetime === "warm"`; the orchestrator does not manage
 *    a separate SessionKeeper.
 *  - Each fix-op + verifier dispatch is wrapped in `runPhase` so per-phase cost and
 *    phaseOutputs stay coherent with the rest of the plan.
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
  if (ctx.runtime.signal?.aborted) {
    return;
  }

  const initialFindings = gatherRectificationFindings(
    phaseOutputs,
    verifierPhase,
    state.fullSuiteGate,
    state.semanticReview,
    state.adversarialReview,
  );
  if (initialFindings.length === 0) {
    return;
  }
  if (!ctx.storyId) {
    // runFixCycle requires storyId for parallel-log correlation.
    return;
  }

  // Separate map for fix-op outputs so intermediate implementer results don't contaminate
  // the final phaseOutputs success aggregation. The validate callback continues to write
  // gate/verifier re-run results into phaseOutputs so they ARE reflected in the final success.
  const fixOpPhaseOutputs: Record<string, unknown> = {};
  const wrappedCallOp = async <I, O, C>(cycleCtx: FixCycleContext, op: Operation<I, O, C>, input: I): Promise<O> => {
    // runFixCycle dispatches fixOps, which are Operation<I,O,C> (run or complete). The
    // builder's runPhase wrapper only needs op.name + dispatch, so widening the cast is safe.
    const slot: AnySlot = { op: op as unknown as RunOperation<unknown, unknown, unknown>, input };
    return (await runPhase(cycleCtx, slot, phaseCosts, fixOpPhaseOutputs)) as O;
  };

  const fullSuiteGatePhase = state.fullSuiteGate;
  const cycle: FixCycle<Finding> = {
    findings: [...initialFindings],
    iterations: [],
    strategies: withIncreasingFailuresBail(
      rectification.strategies as FixStrategy<Finding, unknown, unknown, unknown>[],
      rectification.abortOnIncreasingFailures,
    ),
    config: { maxAttemptsTotal: rectification.maxAttempts, validatorRetries: 1 },
    validate: async (_validateCtx, opts) => {
      if (ctx.runtime.signal?.aborted) return [];
      const lite = opts?.mode === "lite";
      // Re-run validators in canonical order: gate before verifier (matches phase order).
      // Lite mode skips the full-suite gate to keep terminal exhausted re-validation cheap.
      if (fullSuiteGatePhase && !lite) {
        await runPhase(ctx, fullSuiteGatePhase.slot, phaseCosts, phaseOutputs);
      }
      await runPhase(ctx, verifierPhase.slot, phaseCosts, phaseOutputs);
      const findings: Finding[] = [];
      if (fullSuiteGatePhase && !lite) {
        findings.push(...extractPhaseFindings(phaseOutputs[fullSuiteGatePhase.slot.op.name]));
      }
      findings.push(...extractPhaseFindings(phaseOutputs[verifierPhase.slot.op.name]));
      return findings;
    },
  };

  const cycleResult = await _storyOrchestratorDeps.runFixCycle(
    cycle,
    ctx as FixCycleContext,
    "story-orchestrator-rectification",
    { callOp: wrappedCallOp },
  );
  // "validator-error" means runPhase threw during re-validation (e.g. session failure).
  // runFixCycle demotes it to a clean exit rather than throwing, so we surface it here
  // to prevent the failure from being completely silent.
  if (cycleResult.exitReason === "validator-error") {
    getSafeLogger()?.warn("story-orchestrator", "rectification cycle aborted — validator infrastructure error", {
      storyId: ctx.storyId,
    });
  }
}

export class ExecutionPlan {
  constructor(
    private readonly ctx: CallContext,
    private readonly state: InternalBuildState,
  ) {}

  /**
   * Returns the names of all phases in canonical execution order.
   * Phase names correspond to op.name on each RunOperation.
   * When rectification is configured, the sentinel "rectification" appears last.
   */
  phaseNames(): readonly string[] {
    const names = collectOrderedPhases(this.state).map((p) => p.slot.op.name);
    if (this.state.rectification) {
      return [...names, "rectification"];
    }
    return names;
  }

  async run(): Promise<StoryOrchestratorResult> {
    const phaseCosts: Record<string, number> = {};
    const phaseOutputs: Record<string, unknown> = {};
    const startedAt = Date.now();
    const logger = getSafeLogger();

    // Exempt gate + verifier from short-circuit only when rectification is configured
    // (it will consume their failures). Without rectification, failures still halt the plan.
    // Use the registered slot op names — a custom slot may register a different op whose
    // name differs from the default op constant (fullSuiteGateOp.name / verifierOp.name).
    const shortCircuitExempt = this.state.rectification
      ? new Set<string>([
          ...(this.state.fullSuiteGate ? [this.state.fullSuiteGate.slot.op.name] : []),
          ...(this.state.verifier ? [this.state.verifier.slot.op.name] : []),
        ])
      : new Set<string>();

    for (const phase of collectOrderedPhases(this.state)) {
      try {
        await runPhase(this.ctx, phase.slot, phaseCosts, phaseOutputs);
      } catch (error) {
        logger?.error("story-orchestrator", "Phase threw unexpected error", {
          storyId: this.ctx.storyId,
          phase: phase.slot.op.name,
          error: errorMessage(error),
        });
        throw error;
      }

      // Short-circuit on any phase failure (spec §2C: any phase returning success=false halts execution).
      // Exception: phases in shortCircuitExempt continue so rectification can consume their findings.
      if (!phasePassed(phase.slot.op.name, phaseOutputs[phase.slot.op.name])) {
        if (!shortCircuitExempt.has(phase.slot.op.name)) {
          break;
        }
      }
    }

    await runRectification(this.ctx, this.state, phaseCosts, phaseOutputs);

    // Aggregate success across every op that produced output, including fix-ops
    // dispatched during rectification (spec §2C / AC: "success === false when
    // any op returns { success: false }").
    const success = Object.entries(phaseOutputs).every(([name, output]) => phasePassed(name, output));
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

  addGreenfieldGate<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addGreenfieldGate(input: GreenfieldGateInput): this;
  addGreenfieldGate(value: GreenfieldGateInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "greenfield-gate", isSlot(value) ? value : { op: greenfieldGateOp, input: value });
    return this;
  }

  addVerifier<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addVerifier(input: VerifierInput): this;
  addVerifier(value: VerifierInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "verifier", isSlot(value) ? value : { op: verifierOp, input: value });
    return this;
  }

  addFullSuiteGate<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addFullSuiteGate(input: FullSuiteGateInput): this;
  addFullSuiteGate(value: FullSuiteGateInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "full-suite-gate", isSlot(value) ? value : { op: fullSuiteGateOp, input: value });
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
