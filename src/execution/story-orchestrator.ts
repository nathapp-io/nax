/**
 * StoryOrchestratorBuilder — pure callOp dispatcher that unifies execution
 * and TDD orchestration (US-004).
 *
 * Dispatches each phase slot via callOp(ctx, op, input) in canonical order.
 * Wrapper responsibilities (rollback, verdict reading, greenfield detection)
 * remain in tdd/orchestrator.ts — this builder owns ONLY phase dispatch,
 * session lifecycle (rectification SessionKeeper), and cost aggregation.
 */

import { NaxError } from "../errors";
import type { FixStrategy } from "../findings";
import { getSafeLogger } from "../logger";
import { callOp } from "../operations/call";
import type { CallContext, RunOperation } from "../operations/types";
import { errorMessage } from "../utils/errors";

// Captured at module init time so mock.module("@/operations") live-binding
// updates (Bun 1.x global leak) cannot replace the reference used at runtime.
export const _storyOrchestratorDeps = { callOp };

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Generic slot — typed per call so add* methods accept the exact op+input
 * without requiring callers to cast (AC1).
 */
export interface OrchestratorSlot<I, O, C> {
  readonly op: RunOperation<I, O, C>;
  readonly input: I;
}

export interface RectificationPhaseOptions {
  /** Max rectification attempts. From config.execution.rectification.maxRetries. */
  readonly maxAttempts: number;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O types are opaque here
  readonly strategies: FixStrategy<any, unknown, unknown, unknown>[];
  /** Abort if failure count increases between iterations. */
  readonly abortOnIncreasingFailures: boolean;
}

export interface StoryOrchestratorResult {
  readonly success: boolean;
  /** Per-phase costs keyed by op.name. */
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  /**
   * Per-phase parsed outputs, keyed by op.name. Typed Record<string, unknown>
   * with read-site narrowing — wrappers must narrow adjacent to the named op.
   */
  readonly phaseOutputs: Record<string, unknown>;
}

// ─── Sentinel exports for test introspection (AC9) ───────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: sentinel for runtime typeof check in tests
export const StoryOrchestratorResult: any = {};

// ─── Internal types ───────────────────────────────────────────────────────────

type AnySlot = OrchestratorSlot<unknown, unknown, unknown>;

type PhaseKind = "test-writer" | "implementer" | "verifier" | "semantic-review" | "adversarial-review";

interface InternalPhase {
  readonly kind: PhaseKind;
  readonly slot: AnySlot;
}

const CANONICAL_ORDER: readonly PhaseKind[] = [
  "test-writer",
  "implementer",
  "verifier",
  "semantic-review",
  "adversarial-review",
];

// ─── ExecutionPlanImpl ────────────────────────────────────────────────────────

export class ExecutionPlan {
  constructor(
    private readonly _ctx: CallContext,
    private readonly _orderedPhases: readonly InternalPhase[],
    private readonly _verifierPhase: InternalPhase | undefined,
    private readonly _rectificationOpts: RectificationPhaseOptions | undefined,
  ) {}

  run(): Promise<StoryOrchestratorResult> {
    return runExecutionPlan(this._ctx, this._orderedPhases, this._verifierPhase, this._rectificationOpts);
  }
}

// ─── StoryOrchestratorBuilder ─────────────────────────────────────────────────

export class StoryOrchestratorBuilder {
  private readonly _phases: InternalPhase[] = [];
  private _rectificationOpts: RectificationPhaseOptions | undefined;

  addImplementer<I, O, C>(slot: OrchestratorSlot<I, O, C>): this {
    this._phases.push({ kind: "implementer", slot: slot as AnySlot });
    return this;
  }

  addTestWriter<I, O, C>(slot: OrchestratorSlot<I, O, C>): this {
    this._phases.push({ kind: "test-writer", slot: slot as AnySlot });
    return this;
  }

  addVerifier<I, O, C>(slot: OrchestratorSlot<I, O, C>): this {
    this._phases.push({ kind: "verifier", slot: slot as AnySlot });
    return this;
  }

  addSemanticReview<I, O, C>(slot: OrchestratorSlot<I, O, C>): this {
    this._phases.push({ kind: "semantic-review", slot: slot as AnySlot });
    return this;
  }

  addAdversarialReview<I, O, C>(slot: OrchestratorSlot<I, O, C>): this {
    this._phases.push({ kind: "adversarial-review", slot: slot as AnySlot });
    return this;
  }

  addRectification(opts: RectificationPhaseOptions): this {
    this._rectificationOpts = opts;
    return this;
  }

  build(ctx: CallContext): ExecutionPlan {
    const hasImplementer = this._phases.some((p) => p.kind === "implementer");
    if (!hasImplementer) {
      throw new NaxError(
        "StoryOrchestratorBuilder.build(): addImplementer() must be called before build()",
        "ORCHESTRATOR_NO_IMPLEMENTER",
        { stage: "run" },
      );
    }

    const orderedPhases = CANONICAL_ORDER.map((kind) => this._phases.find((p) => p.kind === kind)).filter(
      (p): p is InternalPhase => p !== undefined,
    );

    const verifierPhase = this._phases.find((p) => p.kind === "verifier");

    return new ExecutionPlan(ctx, orderedPhases, verifierPhase, this._rectificationOpts);
  }
}

// ─── Execution logic ──────────────────────────────────────────────────────────

async function runExecutionPlan(
  ctx: CallContext,
  orderedPhases: readonly InternalPhase[],
  verifierPhase: InternalPhase | undefined,
  rectificationOpts: RectificationPhaseOptions | undefined,
): Promise<StoryOrchestratorResult> {
  const startTime = Date.now();
  const phaseCosts: Record<string, number> = {};
  const phaseOutputs: Record<string, unknown> = {};
  let overallSuccess = true;
  const logger = getSafeLogger();

  for (const phase of orderedPhases) {
    const opName = phase.slot.op.name;
    phaseCosts[opName] = 0;

    try {
      const output = await _storyOrchestratorDeps.callOp(ctx, phase.slot.op, phase.slot.input);
      phaseOutputs[opName] = output;

      if (isFailureOutput(output)) {
        overallSuccess = false;
      }
    } catch (err) {
      logger?.error("story-orchestrator", "Phase threw unexpected error", {
        storyId: ctx.storyId,
        phase: opName,
        error: errorMessage(err),
      });
      throw err;
    }
  }

  if (rectificationOpts && verifierPhase) {
    const newSuccess = await runRectificationPhase(
      ctx,
      verifierPhase,
      rectificationOpts,
      phaseOutputs,
      phaseCosts,
      logger,
    );
    if (newSuccess) {
      overallSuccess = true;
    } else if (!overallSuccess) {
      overallSuccess = false;
    }
  }

  const totalCostUsd = Object.values(phaseCosts).reduce((sum, c) => sum + c, 0);

  return {
    success: overallSuccess,
    phaseCosts,
    totalCostUsd,
    durationMs: Date.now() - startTime,
    phaseOutputs,
  };
}

/**
 * Returns true if output signals a phase failure.
 * Only checks for explicit `{ success: false }` — undefined or missing success
 * field does NOT trigger failure (the phase succeeded).
 */
function isFailureOutput(output: unknown): boolean {
  return (
    output !== null &&
    output !== undefined &&
    typeof output === "object" &&
    (output as Record<string, unknown>).success === false
  );
}

async function runRectificationPhase(
  ctx: CallContext,
  verifierPhase: InternalPhase,
  opts: RectificationPhaseOptions,
  phaseOutputs: Record<string, unknown>,
  phaseCosts: Record<string, number>,
  logger: ReturnType<typeof getSafeLogger>,
): Promise<boolean> {
  const verifierOpName = verifierPhase.slot.op.name;
  const verifierOutput = phaseOutputs[verifierOpName];

  // If verifier already succeeded, no rectification needed.
  if (!isFailureOutput(verifierOutput)) {
    return true;
  }

  if (opts.strategies.length === 0) {
    // No strategies to apply.
    return false;
  }

  let attempts = 0;
  let prevFailureCount = Number.POSITIVE_INFINITY;

  while (attempts < opts.maxAttempts) {
    const currentOutput = phaseOutputs[verifierOpName];
    if (!isFailureOutput(currentOutput)) {
      return true;
    }

    const failures = extractFindings(currentOutput);
    const failureCount = failures.length;

    if (opts.abortOnIncreasingFailures && failureCount > prevFailureCount) {
      logger?.warn("story-orchestrator", "Aborting rectification: failure count increased", {
        storyId: ctx.storyId,
        prevFailureCount,
        failureCount,
      });
      return false;
    }

    let strategiesRan = false;
    for (const strategy of opts.strategies) {
      const applicable = failures.filter((f) => strategy.appliesTo(f));
      if (applicable.length === 0) continue;

      const fixInput = strategy.buildInput(applicable, [], ctx as import("../findings").FixCycleContext);
      await _storyOrchestratorDeps.callOp(ctx, strategy.fixOp as RunOperation<unknown, unknown, unknown>, fixInput);
      strategiesRan = true;
      break;
    }

    if (!strategiesRan) {
      return false;
    }

    prevFailureCount = failureCount;
    attempts++;

    if (ctx.runtime.signal?.aborted) {
      return false;
    }

    // Re-run verifier.
    try {
      const newOutput = await _storyOrchestratorDeps.callOp(ctx, verifierPhase.slot.op, verifierPhase.slot.input);
      phaseOutputs[verifierOpName] = newOutput;
      phaseCosts[verifierOpName] = (phaseCosts[verifierOpName] ?? 0) + 0;
    } catch (err) {
      logger?.error("story-orchestrator", "Verifier threw error during rectification", {
        storyId: ctx.storyId,
        phase: verifierOpName,
        error: errorMessage(err),
      });
      return false;
    }
  }

  return !isFailureOutput(phaseOutputs[verifierOpName]);
}

function extractFindings(output: unknown): unknown[] {
  if (output === null || output === undefined || typeof output !== "object") return [];
  const findings = (output as Record<string, unknown>).findings;
  return Array.isArray(findings) ? findings : [];
}
