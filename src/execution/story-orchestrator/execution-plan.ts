import type { Finding } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import { errorMessage } from "@/utils/errors";
import {
  createMeasureSourceDiff,
  nonBlockingExcludePhases,
  nonBlockingExtraPhases,
  shouldRunNonBlockingFix,
} from "../non-blocking-fix";
import { gateFailureKeys, gateRegressedAfterRectification, phaseExplicitlyPassed, phasePassed } from "./phase-eval";
import { collectOrderedPhases } from "./phase-state";
import { runRectification } from "./rectification";
import { _storyOrchestratorDeps, runPhase } from "./run-phase";
import type { InternalBuildState, StoryOrchestratorResult } from "./types";

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

    // TDD RED → GREEN → handover contract: a gate failure halts the canonical
    // sequence unconditionally. Verifier and downstream review phases run only on
    // green (passing-gate) code — they must never judge a broken state.
    //
    // Rectification (when configured) is invoked *after* this loop regardless of
    // whether the loop broke early; it collects gate findings from phaseOutputs
    // and drives the fix cycle independently. After rectification drives the gate
    // back to green, phasesToRevalidate re-dispatches verifier and reviews so they
    // judge only the fixed code (Task 2).
    //
    // This reverts the verifierExempt path added in ff640e6b — that change let
    // the verifier run on broken-gate code as an "unrelated regression" escape
    // hatch, at the cost of every common case. The escalation boundary in
    // deriveTddFailureCategory now handles that case instead.
    const orderedPhases = collectOrderedPhases(this.state);
    for (const [phaseIndex, phase] of orderedPhases.entries()) {
      try {
        await runPhase(this.ctx, phase.slot, phaseCosts, phaseOutputs, this.isThreeSession, {
          index: phaseIndex + 1,
          total: orderedPhases.length,
        });
      } catch (error) {
        logger?.error("story-orchestrator", "Phase threw unexpected error", {
          storyId: this.ctx.storyId,
          phase: phase.slot.op.name,
          error: errorMessage(error),
        });
        throw error;
      }

      // Short-circuit on any phase failure (spec §2C: any phase returning success=false halts execution).
      // No exemptions — verifier and reviews must never judge broken-gate code. Gate findings are
      // captured in phaseOutputs before this check, so runRectification() still consumes them.
      if (!phasePassed(phase.slot.op.name, phaseOutputs[phase.slot.op.name], this.ctx.storyId)) {
        logger?.warn("story-orchestrator", "Short-circuiting on phase failure", {
          storyId: this.ctx.storyId,
          phase: phase.slot.op.name,
        });
        break;
      }
    }

    // Baseline of gate failures the verifier implicitly blessed. The main loop
    // halts on any phase failure (no exemptions), so a verifier that ran-and-passed
    // means the gate was green at that point — any gate failure observed after
    // rectification was therefore introduced by it. Captured before any
    // rectification (including the ADR-024 non-blocking pass) mutates the gate.
    const gateName = this.state.fullSuiteGate?.slot.op.name;
    const preRectGateFailureKeys = gateName ? gateFailureKeys(phaseOutputs[gateName]) : new Set<string>();

    const rectResult = await runRectification(this.ctx, this.state, phaseCosts, phaseOutputs);

    // Resume the canonical loop after rectification resolves. The strategy-specific
    // revalidation set (STRATEGY_TO_REVALIDATION_PHASES) intentionally narrow — e.g.
    // full-suite-rectify excludes adversarial-review, autofix-test-writer excludes
    // semantic-review — so without this resume, any phase NOT in the active strategy's
    // set is silently skipped after the main loop short-circuited on gate failure.
    //
    // Restores prior behavior: rectify → gate green → verifier → reviews. Walks the
    // canonical sequence and runs any phase whose output is missing or non-passing.
    // Halts on first failure (same RED→GREEN contract as the main loop). Skipped
    // entirely when rectification was exhausted — the story is already terminal.
    if (this.state.rectification && (!rectResult.rectificationExhausted || rectResult.liteScopeIncomplete)) {
      // The first rectification ran with a strategy-specific revalidation set
      // (STRATEGY_TO_REVALIDATION_PHASES) that may have excluded phases this
      // resume block runs for the first time (e.g. full-suite-rectify excludes
      // adversarial-review). A failure here is therefore a *new* finding that
      // rectification never had as input — distinct from "rectification tried
      // and could not fix this." Allow one additional rectification pass per
      // story for such fresh failures before declaring terminal. Per-story
      // (not per-phase) on purpose: bounds total LLM cost on the recovery path.
      let resumeRectifyUsed = false;
      for (const phase of collectOrderedPhases(this.state)) {
        const name = phase.slot.op.name;
        if (name in phaseOutputs && phasePassed(name, phaseOutputs[name], this.ctx.storyId)) {
          continue;
        }
        try {
          await runPhase(this.ctx, phase.slot, phaseCosts, phaseOutputs, this.isThreeSession);
        } catch (error) {
          logger?.error("story-orchestrator", "Phase threw unexpected error (post-rectification resume)", {
            storyId: this.ctx.storyId,
            phase: name,
            error: errorMessage(error),
          });
          throw error;
        }
        if (!phasePassed(name, phaseOutputs[name], this.ctx.storyId)) {
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
              { storyId: this.ctx.storyId, phase: name, source: "post-rectification-resume" },
            );
            const secondRect = await runRectification(this.ctx, this.state, phaseCosts, phaseOutputs);
            if (secondRect.rectificationExhausted) {
              logger?.warn("story-orchestrator", "Second rectification pass exhausted — terminal failure", {
                storyId: this.ctx.storyId,
                phase: name,
                source: "post-rectification-resume",
              });
              break;
            }
            // Re-check the failed phase: revalidation inside runRectification
            // may have re-run it. If it now passes, continue; otherwise terminal.
            if (phasePassed(name, phaseOutputs[name], this.ctx.storyId)) {
              continue;
            }
          }
          logger?.warn(
            "story-orchestrator",
            "Terminal phase failure (post-rectification resume — bypasses rectification)",
            {
              storyId: this.ctx.storyId,
              phase: name,
              source: "post-rectification-resume",
              secondRectifyUsed: resumeRectifyUsed,
            },
          );
          break;
        }
      }
    }

    // Mechanical-only resume: when rectification exhausted with only lint/typecheck
    // findings, phases that never executed (e.g. semantic-review, adversarial-review)
    // still need to run. Lint-style errors (E501 line-too-long in docstrings) do not
    // invalidate LLM analysis — skipping reviews would mean the story passes without
    // semantic/adversarial judgment, which is unsound. Unlike the normal resume above,
    // this loop skips phases already in phaseOutputs (pass or fail) rather than
    // re-running failed phases — the gate will not green since the style error remains.
    if (this.state.rectification && rectResult.rectificationExhausted) {
      const mechanicalOnly =
        !!rectResult.unfixedFindings?.length &&
        rectResult.unfixedFindings.every((f) => f.source === "lint" || f.source === "typecheck");
      if (mechanicalOnly) {
        for (const phase of collectOrderedPhases(this.state)) {
          const name = phase.slot.op.name;
          if (name in phaseOutputs) continue; // already ran (passed or failed)
          try {
            await runPhase(this.ctx, phase.slot, phaseCosts, phaseOutputs, this.isThreeSession);
          } catch (error) {
            logger?.error("story-orchestrator", "Phase threw unexpected error (mechanical-only resume)", {
              storyId: this.ctx.storyId,
              phase: name,
              error: errorMessage(error),
            });
            throw error;
          }
          if (!phasePassed(name, phaseOutputs[name], this.ctx.storyId)) {
            logger?.warn("story-orchestrator", "Phase failed in mechanical-only resume", {
              storyId: this.ctx.storyId,
              phase: name,
            });
            break;
          }
        }
      }
    }

    // ADR-024 — non-blocking best-effort fix over advisory adversarial findings.
    // Only when the story is currently green (adversarial passed, nothing pending).
    const advCfg = this.state.adversarialReview ? this.state.nonBlockingFix : undefined;
    const advisoryOut = phaseOutputs["adversarial-review"] as { advisoryFindings?: Finding[] } | undefined;
    const advisoryFindings = advisoryOut?.advisoryFindings ?? [];
    if (
      advCfg &&
      this.state.rectification &&
      this.ctx.storyId &&
      shouldRunNonBlockingFix(advCfg, advisoryFindings.length)
    ) {
      await _storyOrchestratorDeps.runNonBlockingFix(
        {
          workdir: this.ctx.packageDir,
          storyId: this.ctx.storyId,
          advisoryFindings,
          cfg: advCfg,
          phaseOutputs,
          phaseCosts,
          runRectify: (maxAttempts) =>
            runRectification(this.ctx, this.state, phaseCosts, phaseOutputs, {
              initialFindings: advisoryFindings,
              strategies: this.state.nonBlockingFixStrategies ?? [],
              excludePhaseKinds: nonBlockingExcludePhases(),
              extraRevalidationKinds: nonBlockingExtraPhases(advCfg),
              maxAttempts,
              postValidate: this.state.nonBlockingFixPostValidate,
            }),
        },
        {
          measureSourceDiff: createMeasureSourceDiff({
            config: this.ctx.runtime.configLoader.current(),
            projectDir: this.ctx.runtime.projectDir,
            packageDir: this.ctx.packageDir,
          }),
        },
      );
    }

    // Aggregate success across every op that produced output, including fix-ops
    // dispatched during rectification (spec §2C / AC: "success === false when
    // any op returns { success: false }").
    //
    // Verifier-as-SSOT carve-out: when a verifier ran AND passed, the full-suite
    // gate's failure represents pre-existing/unrelated regressions (verifier's
    // judgment). Exempt the gate from aggregation so the story doesn't roll back
    // over failures it didn't cause. The gate output stays in `phaseOutputs` for
    // diagnostics; rectification (when configured) still consumes its findings.
    //
    // Staleness guard: the verifier judged the *pre-rectification* tree. If
    // rectification then introduced NEW gate failures (keys absent from the
    // verifier-time baseline), the verdict is stale for those — it can no longer
    // exempt the gate, else a review-fix that breaks a test is silently laundered
    // into a pass and leaks to the deferred regression sweep.
    const verifierName = this.state.verifier?.slot.op.name;
    // `gateName` and `preRectGateFailureKeys` captured above, before rectification.
    // SSOT requires an explicit pass — see `phaseExplicitlyPassed` for why we
    // don't use the defensive `phasePassed` here.
    const verifierExplicitlyPassed = verifierName !== undefined && phaseExplicitlyPassed(phaseOutputs[verifierName]);
    // Compares the FINAL gate against the verifier-time baseline, including keyless
    // (timeout / execution-failure) regressions the raw key-diff is blind to (audit #3).
    const gateRegressedDuringRect =
      gateName !== undefined &&
      gateRegressedAfterRectification(phaseOutputs[gateName], preRectGateFailureKeys, gateName, this.ctx.storyId);
    const verifierPassedSsot = verifierExplicitlyPassed && !gateRegressedDuringRect;
    if (verifierExplicitlyPassed && gateRegressedDuringRect) {
      logger?.warn(
        "story-orchestrator",
        "Gate regressed during rectification after verifier passed — verifier verdict is stale, failing story",
        { storyId: this.ctx.storyId, packageDir: this.ctx.packageDir },
      );
    } else if (
      verifierPassedSsot &&
      gateName !== undefined &&
      !phasePassed(gateName, phaseOutputs[gateName], this.ctx.storyId)
    ) {
      logger?.warn(
        "story-orchestrator",
        "Full-suite gate failed but verifier judged story OK — treating gate failures as unrelated regressions",
        { storyId: this.ctx.storyId, packageDir: this.ctx.packageDir },
      );
    }

    // Completeness guard (US-002): a configured review phase absent from
    // phaseOutputs never ran — the post-rectification resume loop can break at a
    // still-red full-suite-gate (canonical pos 4) before reaching the reviews
    // (pos 9-10). The verifier-SSOT carve-out must NOT launder such a story into
    // a pass: it cannot be certified without the semantic/adversarial judgment it
    // was configured to require. Forcing success=false routes it to escalation
    // (deriveTddFailureCategory → "review-incomplete") so a stronger tier can
    // green the gate and actually run the review; the story becomes terminal only
    // once escalation is exhausted.
    const requiredReviewPhaseNames = [
      this.state.semanticReview?.slot.op.name,
      this.state.adversarialReview?.slot.op.name,
    ].filter((name): name is string => name !== undefined);
    const missingRequiredReviewPhases = requiredReviewPhaseNames.filter((name) => !(name in phaseOutputs));
    if (missingRequiredReviewPhases.length > 0) {
      logger?.warn(
        "story-orchestrator",
        "Configured review phase(s) never ran — story cannot pass without review judgment, failing for escalation",
        { storyId: this.ctx.storyId, packageDir: this.ctx.packageDir, missingRequiredReviewPhases },
      );
    }

    const success =
      missingRequiredReviewPhases.length === 0 &&
      Object.entries(phaseOutputs).every(([name, output]) => {
        if (verifierPassedSsot && name === gateName) return true;
        return phasePassed(name, output, this.ctx.storyId);
      });
    const totalCostUsd = Object.values(phaseCosts).reduce((sum, cost) => sum + cost, 0);
    const durationMs = Date.now() - startedAt;

    // Final aggregate log — single end-of-run summary so anyone reading the JSONL
    // can see the orchestrator's verdict without correlating per-phase lines.
    const failedPhases = [
      ...Object.entries(phaseOutputs)
        .filter(([name, output]) => {
          if (verifierPassedSsot && name === gateName) return false;
          return !phasePassed(name, output, this.ctx.storyId);
        })
        .map(([name]) => name),
      ...missingRequiredReviewPhases.map((name) => `${name} (never ran)`),
    ];
    const summary: Record<string, unknown> = {
      storyId: this.ctx.storyId,
      success,
      totalCostUsd,
      durationMs,
      phaseCount: Object.keys(phaseOutputs).length,
      failedPhases: failedPhases.length > 0 ? failedPhases : undefined,
    };
    if (rectResult.rectificationExhausted) summary.rectificationExhausted = true;
    if (rectResult.unfixedFindings) summary.unfixedFindingsCount = rectResult.unfixedFindings.length;
    if (missingRequiredReviewPhases.length > 0) summary.missingRequiredReviewPhases = missingRequiredReviewPhases;
    if (success) {
      logger?.info("story-orchestrator", "Story orchestration complete", summary);
    } else {
      logger?.warn("story-orchestrator", "Story orchestration failed", summary);
    }

    return {
      success,
      phaseCosts,
      totalCostUsd,
      durationMs,
      phaseOutputs,
      ...rectResult,
      gateRegressedDuringRect,
      missingRequiredReviewPhases: missingRequiredReviewPhases.length > 0 ? missingRequiredReviewPhases : undefined,
    };
  }
}
