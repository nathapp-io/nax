import { NaxError } from "../errors";
import type { Finding, FixCycle, FixCycleContext, FixStrategy, Iteration } from "../findings";
import { runFixCycle } from "../findings";
import { getSafeLogger } from "../logger";
import {
  fullSuiteGateOp,
  greenfieldGateOp,
  implementerOp,
  lintCheckOp,
  testWriterOp,
  typecheckCheckOp,
  verifierOp,
  verifyScopedOp,
} from "../operations";
import type {
  CallContext,
  DeterministicOperation,
  FullSuiteGateInput,
  GreenfieldGateInput,
  ImplementerInput,
  LintCheckInput,
  Operation,
  RunOperation,
  TestWriterInput,
  TypecheckCheckInput,
  VerifierInput,
  VerifyScopedInput,
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
  readonly rectificationExhausted?: boolean;
  readonly unfixedFindings?: readonly Finding[];
}

type PhaseKind =
  | "test-writer"
  | "greenfield-gate"
  | "implementer"
  | "full-suite-gate"
  | "verifier"
  | "verify-scoped"
  | "lint-check"
  | "typecheck-check";
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
  verifyScoped?: InternalPhase;
  lintCheck?: InternalPhase;
  typecheckCheck?: InternalPhase;
  rectification?: RectificationPhaseOptions;
}

const CANONICAL_ORDER: readonly PhaseKind[] = [
  "test-writer",
  "greenfield-gate",
  "implementer",
  "full-suite-gate",
  "verifier",
  "verify-scoped",
  "lint-check",
  "typecheck-check",
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
  "verify-scoped": "verifyScoped",
  "lint-check": "lintCheck",
  "typecheck-check": "typecheckCheck",
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
    if (kind === "verify-scoped" && state.verifyScoped) return [state.verifyScoped];
    if (kind === "lint-check" && state.lintCheck) return [state.lintCheck];
    if (kind === "typecheck-check" && state.typecheckCheck) return [state.typecheckCheck];
    return [];
  });
}

/**
 * Stricter variant of `phasePassed` for SSOT carve-out logic. Where `phasePassed`
 * defensively treats missing/undefined/non-object outputs as "passed" (to avoid
 * fail-closing on ops that don't conform to the envelope), this requires an
 * affirmative `success === true` or `passed === true`. SSOT semantics ("verifier
 * judged this OK") must not trigger off a malformed envelope.
 */
function phaseExplicitlyPassed(output: unknown): boolean {
  if (output === null || output === undefined || typeof output !== "object") return false;
  const r = output as Record<string, unknown>;
  return r.success === true || r.passed === true;
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
  verifierPhase: string | null,
  fullSuiteGatePhase?: string | null,
): Finding[] {
  const findings: Finding[] = [];
  if (fullSuiteGatePhase) {
    findings.push(...extractPhaseFindings(phaseOutputs[fullSuiteGatePhase]));
  }
  if (verifierPhase) {
    findings.push(...extractPhaseFindings(phaseOutputs[verifierPhase]));
  }
  return findings.filter((f) => f.source === "test-runner");
}

async function runPhase(
  ctx: CallContext,
  slot: AnySlot,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
  isThreeSession = false,
): Promise<unknown> {
  const logger = getSafeLogger();
  const opName = slot.op.name;
  // Isolation enforcement + TDD-stage logs only apply when the orchestrator is
  // executing a three-session-tdd strategy. The single-session ("no-test") path
  // reuses implementerOp but has no boundary semantics to enforce, so capturing
  // beforeRef and emitting "Session: implementer" / "Isolation maintained" there
  // would be misleading.
  const isTddPhase = isThreeSession && TDD_OP_NAMES.has(opName);

  // Pre-phase: capture git ref for TDD phases; emit phase-begin log.
  const beforeRef = isTddPhase ? await _storyOrchestratorDeps.captureGitRef(ctx.packageDir) : undefined;
  const dispatchInput =
    isTddPhase && beforeRef ? { ...(slot.input as Record<string, unknown>), beforeRef } : slot.input;

  if (isTddPhase) {
    logger?.info("tdd", `-> Session: ${opName}`, { storyId: ctx.storyId, role: opName });
  } else if (isThreeSession && opName === "full-suite-gate") {
    logger?.info("tdd", "-> Running full test suite gate (before Verifier)", { storyId: ctx.storyId });
  }

  const phaseStartedAt = Date.now();
  const scope = ctx.runtime.costAggregator.openScope();
  try {
    const output = await _storyOrchestratorDeps.callOp({ ...ctx, scopeId: scope.scopeId }, slot.op, dispatchInput);
    phaseOutputs[opName] = output;

    // Post-phase logs (TDD phases only).
    if (isTddPhase) {
      const durationMs = Date.now() - phaseStartedAt;
      logger?.info("tdd", `Session complete: ${opName}`, {
        storyId: ctx.storyId,
        role: opName,
        durationMs,
      });

      const filesChanged = (output as { filesChanged?: readonly string[] })?.filesChanged ?? [];
      if (opName === "test-writer" && filesChanged.length > 0) {
        logger?.info("tdd", "Created test files", {
          storyId: ctx.storyId,
          testFilesCount: filesChanged.length,
          testFiles: [...filesChanged],
        });
      }

      const isolation = (output as { isolation?: { passed: boolean; violations: string[] } })?.isolation;
      if (isolation) {
        if (isolation.passed) {
          logger?.info("tdd", "Isolation maintained", { storyId: ctx.storyId, role: opName });
        } else {
          logger?.error("tdd", "Isolation violated", {
            storyId: ctx.storyId,
            role: opName,
            violations: isolation.violations,
          });
        }
      }
    }

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
interface RectificationResult {
  rectificationExhausted?: boolean;
  unfixedFindings?: readonly Finding[];
}

async function runRectification(
  ctx: CallContext,
  state: InternalBuildState,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
): Promise<RectificationResult> {
  const rectification = state.rectification;
  const verifierPhase = state.verifier;
  if (!rectification || !verifierPhase) {
    return {};
  }
  if (ctx.runtime.signal?.aborted) {
    return {};
  }

  const initialFindings = gatherRectificationFindings(
    phaseOutputs,
    verifierPhase.slot.op.name,
    state.fullSuiteGate?.slot.op.name ?? null,
  );
  if (initialFindings.length === 0) {
    return {};
  }
  if (!ctx.storyId) {
    // runFixCycle requires storyId for parallel-log correlation.
    return {};
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

  phaseOutputs.rectification = { iterationCount: cycleResult.iterations.length };

  // "validator-error" means runPhase threw during re-validation (e.g. session failure).
  // runFixCycle demotes it to a clean exit rather than throwing, so we surface it here
  // to prevent the failure from being completely silent.
  if (cycleResult.exitReason === "validator-error") {
    getSafeLogger()?.warn("story-orchestrator", "rectification cycle aborted — validator infrastructure error", {
      storyId: ctx.storyId,
    });
  }

  const exhaustedReasons = new Set<string>(["max-attempts-total", "max-attempts-per-strategy", "bail-when"]);
  if (exhaustedReasons.has(cycleResult.exitReason) && cycleResult.finalFindings.length > 0) {
    return { rectificationExhausted: true, unfixedFindings: cycleResult.finalFindings };
  }

  return {};
}

export class ExecutionPlan {
  constructor(
    private readonly ctx: CallContext,
    private readonly state: InternalBuildState,
    /**
     * When true, the orchestrator emits TDD-stage logs and captures per-phase
     * `beforeRef` so isolation `verify` hooks run. The single-session path
     * reuses implementerOp but has no boundary semantics, so this stays false
     * for that strategy. Set by `buildPlanForStrategy` based on `isThreeSessionStrategy`.
     */
    private readonly isThreeSession: boolean = false,
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

    // Verifier is the SSOT for the TDD verdict — it must run after the gate even when
    // the gate failed, so it can judge whether failures are this story's fault or
    // pre-existing/unrelated regressions. The gate is therefore always exempt from
    // short-circuit when verifier is present in the plan (regardless of rectification).
    // Rectification, when configured, additionally consumes their findings.
    // Use the registered slot op names — a custom slot may register a different op whose
    // name differs from the default op constant (fullSuiteGateOp.name / verifierOp.name).
    const verifierPresent = this.state.verifier !== undefined;
    const rectificationExempt = this.state.rectification
      ? [
          ...(this.state.fullSuiteGate ? [this.state.fullSuiteGate.slot.op.name] : []),
          ...(this.state.verifier ? [this.state.verifier.slot.op.name] : []),
        ]
      : [];
    const verifierExempt = verifierPresent && this.state.fullSuiteGate ? [this.state.fullSuiteGate.slot.op.name] : [];
    const shortCircuitExempt = new Set<string>([...rectificationExempt, ...verifierExempt]);

    for (const phase of collectOrderedPhases(this.state)) {
      try {
        await runPhase(this.ctx, phase.slot, phaseCosts, phaseOutputs, this.isThreeSession);
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

    const rectResult = await runRectification(this.ctx, this.state, phaseCosts, phaseOutputs);

    // Aggregate success across every op that produced output, including fix-ops
    // dispatched during rectification (spec §2C / AC: "success === false when
    // any op returns { success: false }").
    //
    // Verifier-as-SSOT carve-out: when a verifier ran AND passed, the full-suite
    // gate's failure represents pre-existing/unrelated regressions (verifier's
    // judgment). Exempt the gate from aggregation so the story doesn't roll back
    // over failures it didn't cause. The gate output stays in `phaseOutputs` for
    // diagnostics; rectification (when configured) still consumes its findings.
    const verifierName = this.state.verifier?.slot.op.name;
    const gateName = this.state.fullSuiteGate?.slot.op.name;
    // SSOT requires an explicit pass — see `phaseExplicitlyPassed` for why we
    // don't use the defensive `phasePassed` here.
    const verifierPassedSsot = verifierName !== undefined && phaseExplicitlyPassed(phaseOutputs[verifierName]);
    if (verifierPassedSsot && gateName !== undefined && !phasePassed(gateName, phaseOutputs[gateName])) {
      logger?.warn(
        "story-orchestrator",
        "Full-suite gate failed but verifier judged story OK — treating gate failures as unrelated regressions",
        { storyId: this.ctx.storyId, packageDir: this.ctx.packageDir },
      );
    }
    const success = Object.entries(phaseOutputs).every(([name, output]) => {
      if (verifierPassedSsot && name === gateName) return true;
      return phasePassed(name, output);
    });
    const totalCostUsd = Object.values(phaseCosts).reduce((sum, cost) => sum + cost, 0);

    return {
      success,
      phaseCosts,
      totalCostUsd,
      durationMs: Date.now() - startedAt,
      phaseOutputs,
      ...rectResult,
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

  addVerifyScoped<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addVerifyScoped(input: VerifyScopedInput): this;
  addVerifyScoped(value: VerifyScopedInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "verify-scoped", isSlot(value) ? value : { op: verifyScopedOp, input: value });
    return this;
  }

  addLintCheck<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addLintCheck(input: LintCheckInput): this;
  addLintCheck(value: LintCheckInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "lint-check", isSlot(value) ? value : { op: lintCheckOp, input: value });
    return this;
  }

  addTypecheckCheck<I, O, C>(slot: OrchestratorSlot<I, O, C>): this;
  addTypecheckCheck(input: TypecheckCheckInput): this;
  addTypecheckCheck(value: TypecheckCheckInput | OrchestratorSlot<unknown, unknown, unknown>): this {
    setPhase(this.state, "typecheck-check", isSlot(value) ? value : { op: typecheckCheckOp, input: value });
    return this;
  }

  addRectification(opts: RectificationPhaseOptions): this {
    this.state.rectification = opts;
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
