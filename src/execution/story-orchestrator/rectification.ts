import type { Finding, FixCycle, FixCycleContext } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { CallContext, Operation, RunOperation } from "@/operations";
import { extractPhaseFindings, orderGateLast, phasesToRevalidate } from "./phase-eval";
import { phaseExplicitlyPassed, phasePassed } from "./phase-eval";
import { _storyOrchestratorDeps, runPhase, withIncreasingFailuresBail } from "./run-phase";
import type { AnySlot, InternalBuildState, InternalPhase, RectificationOverrides, RectificationResult } from "./types";
import { EXHAUSTED_EXIT_REASONS } from "./types";

/**
 * Verifier-as-SSOT: when the verifier explicitly passed, full-suite-gate
 * failures represent unrelated regressions that this story did not cause.
 * Excluded from rectification (mirrors the carve-out in ExecutionPlan.run
 * success aggregation and post-run.ts:deriveFailureCategory).
 */
export function shouldSkipPhaseForRectification(
  phase: InternalPhase,
  state: InternalBuildState,
  phaseOutputs: Record<string, unknown>,
): boolean {
  if (phase.kind !== "full-suite-gate") return false;
  const verifierName = state.verifier?.slot.op.name;
  if (!verifierName) return false;
  return phaseExplicitlyPassed(phaseOutputs[verifierName]);
}

export function gatherRectificationFindings(
  phaseOutputs: Record<string, unknown>,
  phases: readonly InternalPhase[],
  state: InternalBuildState,
): Finding[] {
  const findings: Finding[] = [];
  for (const phase of phases) {
    if (shouldSkipPhaseForRectification(phase, state, phaseOutputs)) continue;
    for (const f of extractPhaseFindings(phaseOutputs[phase.slot.op.name])) {
      // Quarantined flakes (category === "flaky-test") are NOT actionable — the
      // story didn't cause them. Excluding them here keeps them out of the fix
      // cycle (AC3) so the cycle only drives `failed-test` findings to a fix.
      if (f.category === "flaky-test") continue;
      findings.push(f);
    }
  }
  return findings;
}

/** Triage result tuple shape — produced by `_storyOrchestratorDeps.triage`. */
export type TriageResult = readonly [Finding[], { quarantinedKeys: readonly string[] }];

/**
 * Run flake triage on the gate's `failed-test` findings BEFORE
 * `gatherRectificationFindings` reads them. Mutates `phaseOutputs[gateName]`
 * so:
 *   - the gate's findings list is replaced with the triaged set (which may
 *     contain `flaky-test` and `failed-test` entries)
 *   - when no `failed-test` entries remain, `success` / `passed` are flipped
 *     to `true` so the gate no longer blocks the story
 *
 * Callers (ExecutionPlan.run) gate this call with `overrides.skipGateTriage`
 * so the post-rectification resume's second pass does NOT re-triage already
 * triaged findings. Exported for unit testing; the triage dependency is read
 * from `_storyOrchestratorDeps.triage`, which the production wire-up binds to
 * `triageFlakyFindings`.
 */
export function triageGateFindings(
  phaseOutputs: Record<string, unknown>,
  gateName: string | undefined,
  storyId: string | undefined,
): { triaged: boolean; quarantinedKeys: readonly string[]; skipped: boolean } {
  if (!gateName) return { triaged: false, quarantinedKeys: [], skipped: true };
  const triage = (_storyOrchestratorDeps as Record<string, unknown>).triage as
    | ((findings: Finding[]) => TriageResult)
    | undefined;
  if (typeof triage !== "function") return { triaged: false, quarantinedKeys: [], skipped: true };

  const output = phaseOutputs[gateName];
  if (output === null || output === undefined || typeof output !== "object") {
    return { triaged: false, quarantinedKeys: [], skipped: true };
  }
  const record = output as Record<string, unknown>;
  // Triage runs on the gate's failed-test findings only (the seam contract).
  // extractPhaseFindings already filters to source-tagged, success=false
  // findings — i.e. the same set downstream consumers would see.
  const findings = extractPhaseFindings(output);
  if (findings.length === 0) {
    return { triaged: false, quarantinedKeys: [], skipped: true };
  }

  const [triagedFindings, report] = triage(findings);
  const quarantinedKeys = report.quarantinedKeys;

  // Replace the gate's findings list with the triaged set. When no
  // `failed-test` entries survive, flip success/passed so the story can
  // pass with quarantine warnings rather than over the gate's original
  // failure.
  const hasFailedTest = triagedFindings.some((f) => f.category === "failed-test");
  const nextRecord: Record<string, unknown> = { ...record, findings: triagedFindings };
  if (!hasFailedTest) {
    nextRecord.success = true;
    nextRecord.passed = true;
  }
  phaseOutputs[gateName] = nextRecord;

  // Emit one warn per quarantined test, keyed by `${file}::${testName}`,
  // tagged with storyId (AC6).
  if (quarantinedKeys.length > 0) {
    const logger = getSafeLogger();
    for (const key of quarantinedKeys) {
      logger?.warn("story-orchestrator", `Flake quarantined: ${key}`, {
        storyId,
        key,
        previousFailureCount: findings.length,
      });
    }
  }
  return { triaged: true, quarantinedKeys, skipped: false };
}

/**
 * Collect all phases that participate in the rectification validation sweep.
 * Verifier is included here because phasesToRevalidate() allows it to be
 * re-dispatched when a code-editing strategy (full-suite-rectify only) ran.
 * Without this, a stale verifier failure from before rectification would remain
 * in phaseOutputs and mark the story failed even after the gate goes green.
 * shouldSkipPhaseForRectification() gates the gate phase when verifier already
 * explicitly passed (unrelated-regression case).
 */
export function collectRectificationPhases(state: InternalBuildState): InternalPhase[] {
  return [
    state.fullSuiteGate,
    state.verifier,
    state.verifyScoped,
    state.lintCheck,
    state.typecheckCheck,
    state.semanticReview,
    state.adversarialReview,
  ].filter((phase): phase is InternalPhase => phase !== undefined);
}

/**
 * @internal
 * Run the rectification loop and return a structured result describing the exit.
 * Returns `{ liteScopeIncomplete: true }` when the cycle exited with
 * "validate-short-circuit" and no remaining findings — the resume block must
 * still dispatch phases that were absent during the short-circuited validate.
 *
 * Exported for unit testing; not for external callers — use `ExecutionPlan.run`.
 */
export async function runRectification(
  ctx: CallContext,
  state: InternalBuildState,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
  overrides?: RectificationOverrides,
): Promise<RectificationResult> {
  const rectification = state.rectification;
  const baseValidationPhases = collectRectificationPhases(state);
  const validationPhases = overrides?.excludePhaseKinds
    ? baseValidationPhases.filter((p) => !overrides.excludePhaseKinds?.includes(p.kind))
    : baseValidationPhases;
  if (!rectification || validationPhases.length === 0) {
    return {};
  }
  if (ctx.runtime.signal?.aborted) {
    return {};
  }

  let initialFindings: Finding[];
  if (overrides?.initialFindings) {
    // ADR-024 nbf path — triage is a separate concern owned by the main gate path.
    initialFindings = [...overrides.initialFindings];
  } else {
    // US-003 — Flake triage runs on the gate's failed-test findings BEFORE
    // gatherRectificationFindings reads them, but only when this is the
    // orchestrator's first rectification pass on this gate's findings.
    // ExecutionPlan.run gates the call to `triageGateFindings` so the second
    // (post-resume) pass does NOT re-triage already-triaged findings.
    const gateName = state.fullSuiteGate?.slot.op.name;
    if (overrides?.skipGateTriage !== true) {
      triageGateFindings(phaseOutputs, gateName, ctx.storyId);
    }
    initialFindings = gatherRectificationFindings(phaseOutputs, validationPhases, state);
  }
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

  const cycle: FixCycle<Finding> = {
    findings: [...initialFindings],
    iterations: [],
    strategies: withIncreasingFailuresBail(
      (overrides?.strategies ?? rectification.strategies) as import("@/findings").FixStrategy<
        Finding,
        unknown,
        unknown,
        unknown
      >[],
      rectification.abortOnIncreasingFailures,
      rectification.consecutiveIncreasesToBail ?? 1,
    ),
    config: { maxAttemptsTotal: overrides?.maxAttempts ?? rectification.maxAttempts, validatorRetries: 1 },
    validate: async (_validateCtx, opts) => {
      if (ctx.runtime.signal?.aborted) return { findings: [], shortCircuited: false };
      // opts is required by the FixCycle.validate contract but guard defensively for
      // plugin-supplied cycles that may call validate without opts (legacy shape).
      const lite = (opts?.mode ?? "full") === "lite";
      const selected = phasesToRevalidate(opts?.strategiesRun, validationPhases);
      const extra = overrides?.extraRevalidationKinds
        ? validationPhases.filter(
            (p) => overrides.extraRevalidationKinds?.includes(p.kind) && !selected.some((s) => s.kind === p.kind),
          )
        : [];
      const selectedWithExtra = [...selected, ...extra];
      // Terminal lite-validate: the full-suite gate is the most expensive phase
      // AND, for gate-seeded cycles (full-suite-rectify), the actual arbiter of
      // "resolved". It used to be SKIPPED entirely in lite mode, which let the
      // cycle declare "resolved" off the cheaper phases alone (semantic last)
      // without ever re-running the gate that had just received a fix — a
      // dishonest exit. Instead run it LAST: a failing cheaper phase
      // short-circuits before the gate is ever dispatched (preserving the cost
      // saving that motivated lite mode), and when everything cheaper is green
      // the gate is re-run to validate the fix.
      //
      // Caveat — the verifier-SSOT carve-out still applies: when a verifier ran
      // and passed, `shouldSkipPhaseForRectification` discards the gate's finding
      // (unrelated-regression policy, lines ~430), so in that case the gate is
      // dispatched (validating the just-applied fix per Q1) but does NOT block
      // "resolved". The gate is the decisive arbiter only when no passing
      // verifier overrides it (single-session, or a failed/absent verifier).
      // Session-agnostic — also covers a single-session per-story
      // full-suite-gate; verify-scoped was never skipped and is unaffected.
      const phases = lite ? orderGateLast(selectedWithExtra) : selectedWithExtra;
      getSafeLogger()?.debug("story-orchestrator", "rectification validate scope", {
        storyId: ctx.storyId,
        mode: opts?.mode ?? "full",
        strategiesRun: opts?.strategiesRun,
        phasesSelected: phases.map((p) => p.kind),
      });
      const findings: Finding[] = [];
      let shortCircuited = false;
      for (const phase of phases) {
        await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs);
        if (shouldSkipPhaseForRectification(phase, state, phaseOutputs)) continue;
        const output = phaseOutputs[phase.slot.op.name];
        findings.push(...extractPhaseFindings(output));
        // Mirror the main loop's halt-on-failure contract (spec §2C, PR #1127):
        // verifier and reviews must never judge broken-gate code, even inside the
        // rectification revalidation sweep. Findings collected so far feed the next
        // fix iteration; downstream phases are skipped to avoid stale-verdict pollution.
        if (!phasePassed(phase.slot.op.name, output, ctx.storyId)) {
          getSafeLogger()?.warn("story-orchestrator", "Short-circuiting revalidation on phase failure", {
            storyId: ctx.storyId,
            phase: phase.slot.op.name,
          });
          shortCircuited = true;
          break;
        }
      }
      const postValidateFn = overrides?.postValidate ?? rectification.postValidate;
      const validated = postValidateFn ? await postValidateFn(findings, _validateCtx) : findings;
      return { findings: validated, shortCircuited };
    },
  };

  const cycleResult = await _storyOrchestratorDeps.runFixCycle(
    cycle,
    ctx as FixCycleContext,
    "story-orchestrator-rectification",
    { callOp: wrappedCallOp },
  );

  phaseOutputs.rectification = {
    success: cycleResult.exitReason === "resolved",
    iterationCount: cycleResult.iterations.length,
    exitReason: cycleResult.exitReason,
    finalFindingsCount: cycleResult.finalFindings.length,
  };

  // Rectification cycle summary — one line so the JSONL records what happened
  // (entry findings, iterations run, unfixed findings, exit reason, total cost).
  const rectLogger = getSafeLogger();
  const rectSummary = {
    storyId: ctx.storyId,
    initialFindingsCount: initialFindings.length,
    iterationCount: cycleResult.iterations.length,
    finalFindingsCount: cycleResult.finalFindings.length,
    exitReason: cycleResult.exitReason,
    costUsd: cycleResult.costUsd,
  };
  if (cycleResult.exitReason === "resolved") {
    rectLogger?.info("story-orchestrator", "Rectification resolved all findings", rectSummary);
  } else {
    rectLogger?.warn("story-orchestrator", `Rectification exited: ${cycleResult.exitReason}`, rectSummary);
  }

  // "validator-error" means runPhase threw during re-validation (e.g. session failure).
  // runFixCycle demotes it to a clean exit rather than throwing, so we surface it here
  // to prevent the failure from being completely silent.
  if (cycleResult.exitReason === "validator-error") {
    rectLogger?.warn("story-orchestrator", "rectification cycle aborted — validator infrastructure error", {
      storyId: ctx.storyId,
    });
  }

  if (EXHAUSTED_EXIT_REASONS.has(cycleResult.exitReason) && cycleResult.finalFindings.length > 0) {
    return {
      rectificationExhausted: true,
      unfixedFindings: cycleResult.finalFindings,
      ...(cycleResult.unresolvedDetail ? { unresolvedDetail: cycleResult.unresolvedDetail } : {}),
    };
  }
  if (cycleResult.exitReason === "validate-short-circuit") {
    // Empty findings — surface the lite-scope-backfill flag so resume can still run.
    return { liteScopeIncomplete: true };
  }

  return {};
}
