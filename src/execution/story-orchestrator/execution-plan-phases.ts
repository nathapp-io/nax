/**
 * The phases of `ExecutionPlan.run()` (./execution-plan.ts).
 *
 * Split out during the complexity drain (docs/plans/STATUS-complexity-drain.md
 * A3): `run()` scored 101 as one function covering resume hydration, the
 * canonical phase loop, the post-rectification resume loop, the
 * mechanical-only resume loop, the ADR-024 non-blocking fix, and verdict
 * aggregation. Each stage is its own function here, in the same order `run()`
 * executed them. A pure extraction: no orchestration rule changed.
 *
 * `phaseCosts` and `phaseOutputs` are mutated in place throughout — exactly
 * as the original single function did (`runPhase` writes into them; nothing
 * here ever reassigns either) — so every stage takes the same two objects and
 * every later stage sees earlier stages' writes.
 *
 * `ctx` / `state` / `isThreeSession` never change once `ExecutionPlan` is
 * constructed, so they travel together as `PlanParams` instead of three
 * separate parameters at every call site.
 */

import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import { errorMessage } from "@/utils/errors";
import type { QuarantineMemo } from "@/verification";
import { hydrateFromResumePlan } from "../checkpoint/resume-hydrate";
import { nonBlockingExcludePhases, nonBlockingExtraPhases } from "../non-blocking-fix";
import { buildNbfDeps } from "./nbf-deps";
import { deriveNbfSeed } from "./nbf-seed";
import type { GateRegressionDetail } from "./phase-eval";
import { describeGateRegression, phasePassed } from "./phase-eval";
import { collectOrderedPhases } from "./phase-state";
import { runRectification } from "./rectification";
import { _storyOrchestratorDeps, runPhase } from "./run-phase";
import type { InternalBuildState, InternalPhase, RectificationResult } from "./types";

/** `ctx` / `state` / `isThreeSession` never change across one `run()` call. */
export interface PlanParams {
  ctx: CallContext;
  state: InternalBuildState;
  isThreeSession: boolean;
}

export interface PhaseTracking {
  phaseCosts: Record<string, number>;
  phaseOutputs: Record<string, unknown>;
}

/**
 * Evaluate the gate against the pre-rectification baseline, as of right now.
 *
 * Sole supplier of `describeGateRegression`'s input, so nbf's keep-decision
 * (ADR-024 §3) and the verdict's staleness guard cannot drift apart — they
 * are the same call with the same memo. Splitting them is what the §3 comment
 * at the nbf call site warns against, and filtering flakes into only one of
 * them would reintroduce exactly the main-path/nbf asymmetry #1383 is about.
 */
export function describeGateRegressionNow(
  ctx: CallContext,
  phaseOutputs: Record<string, unknown>,
  options: { gateName: string | undefined; baselineKeys: ReadonlySet<string>; quarantineMemo?: QuarantineMemo },
): GateRegressionDetail {
  const { gateName } = options;
  return describeGateRegression({
    gateOutput: gateName === undefined ? undefined : phaseOutputs[gateName],
    baselineKeys: options.baselineKeys,
    gateName,
    storyId: ctx.storyId,
    // Run-scoped: a test this run already probed and quarantined is not attributable
    // to this story, on either path (#1383).
    quarantineMemo: options.quarantineMemo ?? ctx.runtime.quarantineMemo,
  });
}

/**
 * Capture tree state and build the resume plan — seeds `phaseOutputs` from
 * prior green phases so the canonical loop skips them. Cheap gates are never
 * seeded: they always re-execute to confirm the working tree is still green.
 */
export async function hydrateResumeState(plan: PlanParams): Promise<PhaseTracking> {
  const { ctx } = plan;
  const phaseCosts: Record<string, number> = {};
  const phaseOutputs: Record<string, unknown> = {};

  const tree = await _storyOrchestratorDeps.captureTreeState(ctx.packageDir);
  const checkpoints = await _storyOrchestratorDeps.loadCheckpoints(ctx.featureDir ?? "");
  const storyCp = ctx.storyId ? (checkpoints.get(ctx.storyId) ?? null) : null;
  const resumePlan = await _storyOrchestratorDeps.buildResumePlan(storyCp, tree);
  hydrateFromResumePlan(resumePlan, phaseOutputs);

  // Carry forward seeded phases under the current run's `runId`. A phase
  // skipped in the canonical loop never reaches the `recordGreen` call at its
  // old position (the skip guard's `continue` bypasses it), so it would keep
  // only the checkpoint record from the run that originally recorded it.
  // `loadCheckpoints` now filters per-story (see `reader.ts`), so an
  // untouched story's older-run records already survive repeated resumes on
  // their own — this re-recording is a cheap consolidation, not a
  // correctness requirement: it advances this story's own checkpoint history
  // to the current `runId` under the tree state already confirmed to match by
  // `buildResumePlan`, so every still-green phase for THIS story shares one
  // consistent runId rather than accumulating one stale record per resume.
  if (ctx.storyId) {
    for (const skippedPhase of resumePlan.skipPhases) {
      await _storyOrchestratorDeps.recordGreen(ctx.storyId, skippedPhase, tree);
    }
  }

  return { phaseCosts, phaseOutputs };
}

async function recordGreenCheckpoint(plan: PlanParams, phaseName: string): Promise<void> {
  const { ctx } = plan;
  const logger = getSafeLogger();
  if (!ctx.storyId) {
    logger?.warn("story-orchestrator", "Skipping recordGreen — no storyId on CallContext", { phase: phaseName });
    return;
  }
  const currentTree = await _storyOrchestratorDeps.captureTreeState(ctx.packageDir);
  try {
    await _storyOrchestratorDeps.recordGreen(ctx.storyId, phaseName, currentTree);
  } catch (error) {
    // EXEC-9: recordGreen's CHECKPOINT_WRITE_FAILED (disk full, permission) is
    // an infra failure, not a verdict on the phase that just genuinely
    // passed. The story verdict (phasePassed above) is the SSOT — losing a
    // resume checkpoint costs a full rerun on resume, which is recoverable;
    // escalating the story through paid tiers for an infra error is not.
    if (error instanceof NaxError && error.code === "CHECKPOINT_WRITE_FAILED") {
      logger?.warn("story-orchestrator", "recordGreen failed — resume checkpoint lost, story verdict unaffected", {
        storyId: ctx.storyId,
        phase: phaseName,
        error: errorMessage(error),
      });
    } else {
      throw error;
    }
  }
}

/**
 * TDD RED → GREEN → handover contract: a gate failure halts the canonical
 * sequence unconditionally. Verifier and downstream review phases run only on
 * green (passing-gate) code — they must never judge a broken state.
 *
 * Rectification (when configured) is invoked *after* this loop regardless of
 * whether the loop broke early; it collects gate findings from phaseOutputs
 * and drives the fix cycle independently. After rectification drives the gate
 * back to green, phasesToRevalidate re-dispatches verifier and reviews so they
 * judge only the fixed code (Task 2).
 *
 * This reverts the verifierExempt path added in ff640e6b — that change let
 * the verifier run on broken-gate code as an "unrelated regression" escape
 * hatch, at the cost of every common case. The escalation boundary in
 * deriveTddFailureCategory now handles that case instead.
 *
 * #1666 amendment: `semantic-review` failing is an EXCEPTION to the
 * unconditional halt above, scoped narrowly to that one transition
 * (semantic-review -> adversarial-review, its immediate successor in
 * CANONICAL_ORDER). ff640e6b's revert does not cover this case: that change
 * let the VERIFIER run on a broken-gate tree (judging code that might not even
 * build), which is exactly the "verifier and reviews must never judge broken
 * state" hazard above. Here the working tree is green — every gate ahead of
 * semantic-review (full-suite-gate, verifier, lint-check, typecheck-check) has
 * already passed for semantic-review to have run at all. Continuing to
 * adversarial-review asks a second, independent reviewer for its own opinion
 * on that same green tree; it does not let anything judge broken code. Measured
 * across 1010 run logs, semantic-review short-circuited 231 times and took
 * adversarial-review down with it in 132 of those — a lost second opinion, not
 * a safety hatch. Every OTHER phase (gate, verifier, lint/typecheck, implementer)
 * still halts unconditionally; this is a continuation, not a general
 * "reviews are exempt" rule. The story still fails on semantic-review's own
 * finding (see `success` in the final verdict) — running adversarial-review
 * changes what gets reported, not the verdict.
 *
 * Returns the phase (if any) whose failure caused the loop to stop before
 * reaching the end of `orderedPhases`. Used only to classify a required review
 * phase that later turns up missing from `phaseOutputs`: was it never reached
 * because of a failure the story already reports elsewhere (this phase), or is
 * it the separate post-rectification resume case (US-002) that this variable
 * does not track? See `classifyMissingReviewPhases` for how the two are told
 * apart.
 */
export async function runCanonicalLoop(
  plan: PlanParams,
  tracking: PhaseTracking,
  orderedPhases: readonly InternalPhase[],
): Promise<{ shortCircuitPhase: string | undefined }> {
  const { ctx, isThreeSession } = plan;
  const { phaseCosts, phaseOutputs } = tracking;
  const logger = getSafeLogger();
  let shortCircuitPhase: string | undefined;

  for (const [phaseIndex, phase] of orderedPhases.entries()) {
    const name = phase.slot.op.name;

    // Resume skip guard: phases seeded from a prior checkpoint (via
    // hydrateFromResumePlan) are already green — skip them. Cheap gates are
    // never seeded, so they always re-execute even on resume.
    if (name in phaseOutputs && phasePassed(name, phaseOutputs[name], ctx.storyId)) {
      continue;
    }

    try {
      await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs, isThreeSession, {
        index: phaseIndex + 1,
        total: orderedPhases.length,
      });
    } catch (error) {
      logger?.error("story-orchestrator", "Phase threw unexpected error", {
        storyId: ctx.storyId,
        phase: name,
        error: errorMessage(error),
      });
      throw error;
    }

    // Short-circuit on any phase failure (spec §2C: any phase returning success=false halts execution),
    // with one narrow exception: `semantic-review` failing continues to `adversarial-review` (see the
    // #1666 amendment above) instead of halting. Every other phase still halts unconditionally — verifier
    // and reviews must never judge broken-gate code. Gate findings are captured in phaseOutputs before
    // this check, so runRectification() still consumes them.
    if (!phasePassed(name, phaseOutputs[name], ctx.storyId)) {
      shortCircuitPhase = name;
      if (name === "semantic-review") {
        logger?.warn(
          "story-orchestrator",
          "semantic-review failed — continuing to adversarial-review for a second opinion",
          { storyId: ctx.storyId, phase: name },
        );
        continue;
      }
      logger?.warn("story-orchestrator", "Short-circuiting on phase failure", { storyId: ctx.storyId, phase: name });
      break;
    }

    // Record green checkpoint: only after a phase has passed and produced output.
    // Tree state is captured fresh here (not the pre-loop `tree` used for the
    // resume-plan comparison in hydrateResumeState) because the phase that just
    // passed may have mutated the working tree — a stale, pre-loop digest would
    // make every record after the first phase disagree with the tree the reader
    // compares against on resume, forcing a spurious "tree-moved" full rerun.
    await recordGreenCheckpoint(plan, name);
  }

  return { shortCircuitPhase };
}

/**
 * Resume the canonical loop after rectification resolves. The strategy-specific
 * revalidation set (STRATEGY_TO_REVALIDATION_PHASES) is intentionally narrow —
 * e.g. full-suite-rectify excludes adversarial-review, autofix-test-writer
 * excludes semantic-review — so without this resume, any phase NOT in the
 * active strategy's set is silently skipped after the canonical loop
 * short-circuited on gate failure.
 *
 * Restores prior behavior: rectify → gate green → verifier → reviews. Walks
 * the canonical sequence and runs any phase whose output is missing or
 * non-passing. Halts on first failure (same RED→GREEN contract as the
 * canonical loop). The caller only invokes this when eligible — see
 * `run()`'s `resumeLoopEligible` — which is also the deciding line for
 * whether a still-missing required review phase is attributable to the
 * canonical loop's short-circuit, or to this resume loop's own halt (US-002).
 */
export async function runPostRectificationResume(
  plan: PlanParams,
  tracking: PhaseTracking,
  preRectGateFailureKeys: ReadonlySet<string>,
): Promise<void> {
  const { ctx, state, isThreeSession } = plan;
  const { phaseCosts, phaseOutputs } = tracking;
  const logger = getSafeLogger();
  // The first rectification ran with a strategy-specific revalidation set
  // (STRATEGY_TO_REVALIDATION_PHASES) that may have excluded phases this
  // resume block runs for the first time (e.g. full-suite-rectify excludes
  // adversarial-review). A failure here is therefore a *new* finding that
  // rectification never had as input — distinct from "rectification tried
  // and could not fix this." Allow one additional rectification pass per
  // story for such fresh failures before declaring terminal. Per-story
  // (not per-phase) on purpose: bounds total LLM cost on the recovery path.
  let resumeRectifyUsed = false;
  for (const phase of collectOrderedPhases(state)) {
    const name = phase.slot.op.name;
    if (name in phaseOutputs && phasePassed(name, phaseOutputs[name], ctx.storyId)) {
      continue;
    }
    try {
      await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs, isThreeSession);
    } catch (error) {
      logger?.error("story-orchestrator", "Phase threw unexpected error (post-rectification resume)", {
        storyId: ctx.storyId,
        phase: name,
        error: errorMessage(error),
      });
      throw error;
    }
    if (phasePassed(name, phaseOutputs[name], ctx.storyId)) continue;

    if (!resumeRectifyUsed) {
      // Fresh failure: this phase was not in the prior strategy's
      // revalidation scope, so rectification has never seen its findings.
      // Invoke rectification once more on the now-current phaseOutputs.
      // Bounded to a single retry per story; the inner cycle has its own
      // maxAttempts budget so this cannot loop.
      resumeRectifyUsed = true;
      logger?.info(
        "story-orchestrator",
        "Phase failed in post-rectification resume — invoking second rectification pass",
        {
          storyId: ctx.storyId,
          phase: name,
          source: "post-rectification-resume",
        },
      );
      const secondRect = await runRectification(ctx, state, phaseCosts, phaseOutputs, {
        skipGateTriage: true,
        gateBaselineKeys: preRectGateFailureKeys,
        isThreeSession,
        extraRevalidationKinds: [phase.kind],
      });
      if (secondRect.rectificationExhausted) {
        logger?.warn("story-orchestrator", "Second rectification pass exhausted — terminal failure", {
          storyId: ctx.storyId,
          phase: name,
          source: "post-rectification-resume",
        });
        break;
      }
      // `extraRevalidationKinds` puts the failed phase in revalidation even when the
      // fixing strategy excludes it (autofix-implementer never revalidates the
      // verifier, #2264). If it now passes, continue; otherwise terminal.
      if (phasePassed(name, phaseOutputs[name], ctx.storyId)) continue;
    }
    logger?.warn("story-orchestrator", "Terminal phase failure (post-rectification resume — bypasses rectification)", {
      storyId: ctx.storyId,
      phase: name,
      source: "post-rectification-resume",
      secondRectifyUsed: resumeRectifyUsed,
    });
    break;
  }
}

/**
 * Mechanical-only resume: when rectification exhausted with only lint/typecheck
 * findings, phases that never executed (e.g. semantic-review, adversarial-review)
 * still need to run. Lint-style errors (E501 line-too-long in docstrings) do not
 * invalidate LLM analysis — skipping reviews would mean the story passes without
 * semantic/adversarial judgment, which is unsound. Unlike `runPostRectificationResume`,
 * this loop skips phases already in phaseOutputs (pass or fail) rather than
 * re-running failed phases — the gate will not green since the style error remains.
 */
export async function runMechanicalOnlyResume(
  plan: PlanParams,
  tracking: PhaseTracking,
  rectResult: RectificationResult,
): Promise<void> {
  const mechanicalOnly =
    !!rectResult.unfixedFindings?.length &&
    rectResult.unfixedFindings.every((f) => f.source === "lint" || f.source === "typecheck");
  if (!mechanicalOnly) return;

  const { ctx, state, isThreeSession } = plan;
  const { phaseCosts, phaseOutputs } = tracking;
  const logger = getSafeLogger();
  for (const phase of collectOrderedPhases(state)) {
    const name = phase.slot.op.name;
    if (name in phaseOutputs) continue; // already ran (passed or failed)
    try {
      await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs, isThreeSession);
    } catch (error) {
      logger?.error("story-orchestrator", "Phase threw unexpected error (mechanical-only resume)", {
        storyId: ctx.storyId,
        phase: name,
        error: errorMessage(error),
      });
      throw error;
    }
    if (!phasePassed(name, phaseOutputs[name], ctx.storyId)) {
      logger?.warn("story-orchestrator", "Phase failed in mechanical-only resume", {
        storyId: ctx.storyId,
        phase: name,
      });
      break;
    }
  }
}

export interface NonBlockingFixOptions {
  gateName: string | undefined;
  preRectGateFailureKeys: ReadonlySet<string>;
}

/**
 * ADR-024 — non-blocking best-effort fix over advisory findings from the
 * `review.nonBlockingFix.sources`-declared reviewer set (US-002 union). Only
 * when the story is currently green (every phase that produced output
 * passed) and rectification did not exhaust.
 *
 * This green precondition is load-bearing, not cosmetic: nbf's floor guarantee
 * (§5, restore-to-adversarial-passed) only holds when the entry state IS the
 * adversarial-passed tree. Without the guard, a story whose outer rectification
 * exhausted with unfixed review findings (e.g. semantic-review short-circuit)
 * still entered nbf, kept cosmetic edits on the red tree, and then escalated on
 * the real failures it never touched — polluting the next tier's working tree
 * for no benefit (log 2026-06-24, US-001). Skip nbf entirely when the story is
 * red: there is no passed state to improve upon, and the blocking failures must
 * flow to escalation untouched.
 */
export async function maybeRunNonBlockingFix(
  plan: PlanParams,
  tracking: PhaseTracking,
  rectResult: RectificationResult,
  opts: NonBlockingFixOptions,
): Promise<void> {
  const { ctx, state, isThreeSession } = plan;
  const { phaseCosts, phaseOutputs } = tracking;
  const { gateName, preRectGateFailureKeys } = opts;

  const storyCurrentlyGreen =
    !rectResult.rectificationExhausted &&
    Object.entries(phaseOutputs).every(([name, output]) => phasePassed(name, output, ctx.storyId));
  const nbfCfg = state.nonBlockingFix;
  const seed = deriveNbfSeed({ phaseOutputs, sources: nbfCfg?.sources ?? [], storyId: ctx.storyId });
  const shouldRunNbf =
    !!nbfCfg &&
    storyCurrentlyGreen &&
    !!state.rectification &&
    !!ctx.storyId &&
    (!!state.adversarialReview || !!state.semanticReview) &&
    seed.shouldRun;
  if (!shouldRunNbf || !nbfCfg) return;

  await _storyOrchestratorDeps.runNonBlockingFix(
    {
      workdir: ctx.packageDir,
      storyId: ctx.storyId as string,
      advisoryFindings: seed.findings,
      cfg: nbfCfg,
      phaseOutputs,
      phaseCosts,
      quarantineMemo: ctx.runtime.quarantineMemo,
      gateBaselineKeys: preRectGateFailureKeys,
      blockedWorktrees: ctx.runtime.dirtyWorktrees,
      runRectify: (maxAttempts, nbfFlakeTriage) =>
        runRectification(ctx, state, phaseCosts, phaseOutputs, {
          initialFindings: seed.findings,
          nbfFlakeTriage,
          strategies: state.nonBlockingFixStrategies ?? [],
          excludePhaseKinds: nonBlockingExcludePhases(),
          extraRevalidationKinds: nonBlockingExtraPhases(nbfCfg),
          maxAttempts,
          postValidate: state.nonBlockingFixPostValidate,
          isThreeSession,
        }),
      // ADR-024 §3 — restore any kept pass that regressed the full-suite gate.
      // Same predicate + baseline the final verdict's staleness guard uses
      // (`gateRegressedDuringRect`), so nbf's keep-decision can never disagree
      // with the verdict: a fix the guard would fail on is restored to
      // adversarial-passed here instead, leaving the story green with zero net
      // change. Detail-returning (not boolean) so the restore log can name the
      // regressing test identities — the only point at which they still exist
      // (#1382).
      keptTreeRegressed: (quarantineMemo) =>
        describeGateRegressionNow(ctx, phaseOutputs, {
          gateName,
          baselineKeys: preRectGateFailureKeys,
          quarantineMemo,
        }),
    },
    buildNbfDeps({ ctx, findings: seed.findings }),
  );
}

// Verdict aggregation (buildStoryOrchestratorResult) lives in
// ./execution-plan-verdict.ts — this file reached 684 lines against the
// 600-line gate once that logic joined the other extracted phases.
