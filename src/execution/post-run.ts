/**
 * Post-Run Inspection
 *
 * Pure/deterministic analysis of plan.run() results:
 * - Verdict extraction (AgentResult, self-verification)
 * - TDD failure categorization
 * - pauseReason detection
 * - Decision routing (escalate / pause / rollback / continue)
 *
 * All injectable side-effects (rollback, merge-conflict check, failAndClose,
 * auto-commit) are exposed via _postRunDeps for test isolation.
 */

import type { AgentResult } from "../agents/types";
import type { Finding } from "../findings/types";
import { checkMergeConflict, isTriggerEnabled } from "../interaction/triggers";
import { getLogger } from "../logger";
import { fullSuiteGateOp, implementerOp, testWriterOp, verifierOp, verifyScopedOp } from "../operations";
import { routeTddFailure } from "../pipeline/stages/execution-helpers";
import type { PipelineContext, StageResult } from "../pipeline/types";
import { parseSelfVerificationMarker } from "../quality";
// Leaf import (not the `review` barrel) — the barrel pulls formatter.ts which
// triggers a circular ESM init crash at construction time (see BUG v0.71.0).
import { isBlockingSeverity } from "../review/severity";
import { appendScratchEntry } from "../session/scratch-writer";
import { rollbackToRef } from "../tdd/rollback";
import { errorMessage } from "../utils/errors";
import { autoCommitIfDirty, detectMergeConflict } from "../utils/git";
import { failAndClose } from "./session-manager-runtime";
import type { StoryOrchestratorResult } from "./story-orchestrator";
import { deriveTddFailureCategory } from "./tdd-failure-category";
import type { FailureCategory } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TddMode {
  readonly isLite: boolean;
  readonly rollbackEnabled: boolean;
}

export interface InspectionOptions {
  capturedTokenUsage?: import("../agents/cost").TokenUsage;
  capturedResponse: string;
  capturedCostUsd: number;
  /** Null when this is not a TDD strategy; otherwise carries TDD-specific opts. */
  tddMode: TddMode | null;
  initialRef: string | null;
}

export interface PostRunInspectionResult {
  readonly agentResult: AgentResult;
  readonly selfVerificationFailed: boolean;
  readonly pauseReason?: string;
  readonly failureCategory?: FailureCategory;
  readonly needsHumanReview: boolean;
  readonly combinedOutput: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies
// ─────────────────────────────────────────────────────────────────────────────

export const _postRunDeps = {
  detectMergeConflict,
  checkMergeConflict,
  failAndClose,
  rollbackToRef,
  autoCommitIfDirty,
};

function shouldRollbackTddFailure(tddMode: TddMode | null, failureCategory: FailureCategory | undefined): boolean {
  return tddMode?.rollbackEnabled === true && failureCategory === "isolation-violation";
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the first pauseReason from any phase output. */
export function extractPauseReason(phaseOutputs: Record<string, unknown>): string | undefined {
  for (const output of Object.values(phaseOutputs)) {
    if (output !== null && typeof output === "object") {
      const record = output as Record<string, unknown>;
      if (typeof record.pauseReason === "string" && record.pauseReason) {
        return record.pauseReason;
      }
    }
  }
  return undefined;
}

export { deriveTddFailureCategory };

/**
 * Wrapper-level session teardown on failure.
 *
 * Complements rollback (spec §3 wrapper side-effect): when the wrapper decides
 * to fail or escalate a story, any legacy ctx.sessionId tied to upstream
 * resources must be closed. Per-phase sessions opened inside the plan are
 * closed by their own SessionKeeper.finally — this is for the wrapper-owned
 * session handle only.
 *
 * Consolidated into one site (was two — see US-005 review H2) so the
 * sessionManager reach is contained.
 */
async function cleanupSessionOnFailure(ctx: PipelineContext): Promise<void> {
  if (!ctx.sessionManager || !ctx.sessionId) return;
  await _postRunDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspection phases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply deterministic post-run inspection: build AgentResult, set ctx fields,
 * write scratch, extract pauseReason and failureCategory.
 *
 * Does NOT make routing decisions — call decideStageAction for that.
 */
export async function applyPostRunInspection(
  ctx: PipelineContext,
  planResult: StoryOrchestratorResult,
  opts: InspectionOptions,
): Promise<PostRunInspectionResult> {
  const logger = getLogger();
  const { capturedTokenUsage, capturedResponse, capturedCostUsd } = opts;
  const isTdd = opts.tddMode !== null;

  // Extract implementer output → ctx.agentResult
  const implementerOutput = planResult.phaseOutputs[implementerOp.name] as
    | { success: boolean; filesChanged?: string[]; estimatedCostUsd?: number; durationMs?: number }
    | undefined;

  const agentResult: AgentResult = {
    success: implementerOutput?.success ?? false,
    estimatedCostUsd: capturedCostUsd || planResult.phaseCosts[implementerOp.name] || 0,
    rateLimited: false,
    output: capturedResponse,
    exitCode: implementerOutput?.success ? 0 : 1,
    durationMs: implementerOutput?.durationMs ?? planResult.durationMs,
    ...(capturedTokenUsage ? { tokenUsage: capturedTokenUsage } : {}),
  };
  ctx.agentResult = agentResult;

  // Propagate full-suite gate result so verify stage can skip redundant run (BUG-054)
  const fullSuiteGateOutput = planResult.phaseOutputs[fullSuiteGateOp.name] as
    | { passed?: boolean; findings?: readonly Finding[] }
    | undefined;
  if (fullSuiteGateOutput?.passed) {
    ctx.fullSuiteGatePassed = true;
  }
  // Snapshot failing test files from the (post-rectification) gate findings so
  // deferred-regression blame can attribute a regression to the introducing
  // story (three-session + deferred). See findResponsibleStoryByTransition.
  const gateFailingFiles = [
    ...new Set((fullSuiteGateOutput?.findings ?? []).map((f) => f.file).filter((f): f is string => !!f)),
  ];
  if (gateFailingFiles.length > 0) ctx.fullSuiteGateFailingFiles = gateFailingFiles;

  // Self-verification from implementer output
  ctx.selfVerification = parseSelfVerificationMarker(agentResult.output ?? "", ctx.workdir);
  const selfVerificationFailed = ctx.selfVerification.lint === "fail" || ctx.selfVerification.typecheck === "fail";

  // Write self-verification scratch entry
  if (ctx.config.context?.v2?.enabled && ctx.sessionScratchDir) {
    try {
      await appendScratchEntry(ctx.sessionScratchDir, {
        kind: "self-verification",
        timestamp: new Date().toISOString(),
        storyId: ctx.story.id,
        stage: "execution",
        role: "implementer",
        selfVerification: ctx.selfVerification,
        writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
      });
    } catch (scratchErr) {
      logger.warn("execution", "Failed to write self-verification scratch entry — continuing", {
        storyId: ctx.story.id,
        error: errorMessage(scratchErr),
      });
    }
  }

  // Write per-role tdd-session scratch entries for test-writer and verifier.
  // The implementer's self-verification entry was written above; these restore
  // the per-role context coverage that the three-session strategy previously provided.
  if (isTdd && ctx.config.context?.v2?.enabled && ctx.sessionScratchDir) {
    const writtenByAgent =
      (ctx.routing as { agent?: string } | undefined)?.agent ?? ctx.agentManager?.getDefault() ?? "claude";
    const writerOut = planResult.phaseOutputs[testWriterOp.name] as
      | { success?: boolean; filesChanged?: string[]; output?: string }
      | undefined;
    if (writerOut) {
      try {
        await appendScratchEntry(ctx.sessionScratchDir, {
          kind: "tdd-session",
          timestamp: new Date().toISOString(),
          storyId: ctx.story.id,
          stage: "execution",
          role: "test-writer",
          success: writerOut.success === true,
          filesChanged: writerOut.filesChanged ?? [],
          outputTail: (writerOut.output ?? "").slice(-500),
          writtenByAgent,
        });
      } catch (err) {
        logger.warn("execution", "Failed to write test-writer scratch entry", {
          storyId: ctx.story.id,
          error: errorMessage(err),
        });
      }
    }

    const verifierOut = planResult.phaseOutputs[verifierOp.name] as
      | { success?: boolean; filesChanged?: string[]; output?: string }
      | undefined;
    if (verifierOut) {
      try {
        await appendScratchEntry(ctx.sessionScratchDir, {
          kind: "tdd-session",
          timestamp: new Date().toISOString(),
          storyId: ctx.story.id,
          stage: "execution",
          role: "verifier",
          success: verifierOut.success === true,
          filesChanged: verifierOut.filesChanged ?? [],
          outputTail: (verifierOut.output ?? "").slice(-500),
          writtenByAgent,
        });
      } catch (err) {
        logger.warn("execution", "Failed to write verifier scratch entry", {
          storyId: ctx.story.id,
          error: errorMessage(err),
        });
      }
    }
  }

  const pauseReason = extractPauseReason(planResult.phaseOutputs);
  // Non-TDD stories get no failureCategory and rely on the generic escalate path
  // below (`!planResult.success` → escalate). A non-TDD missing-review failure
  // (`missingRequiredReviewPhases`) therefore still escalates and re-runs the
  // review, but on exhaustion resolves to `fail` rather than the `review-incomplete`
  // `pause` the TDD path uses — the core bug (skipped review) is fixed for both.
  const failureCategory =
    isTdd && !planResult.success
      ? deriveTddFailureCategory(
          planResult.phaseOutputs,
          planResult.unfixedFindings,
          planResult.gateRegressedDuringRect,
          planResult.missingRequiredReviewPhases,
        )
      : undefined;

  // Diagnostic: if a TDD plan failed but no category was derived, the routing path
  // falls back to the generic "requires review" pause. Surface the per-phase
  // success/passed signals so we can attribute the failure post-mortem instead of
  // staring at a silent log line.
  if (isTdd && !planResult.success && !failureCategory) {
    const phaseSignals: Record<string, Record<string, boolean>> = {};
    for (const [name, output] of Object.entries(planResult.phaseOutputs)) {
      if (output && typeof output === "object") {
        const r = output as Record<string, unknown>;
        const signal: Record<string, boolean> = {};
        if (typeof r.success === "boolean") signal.success = r.success;
        if (typeof r.passed === "boolean") signal.passed = r.passed;
        // Omit keys when neither boolean is present so the log distinguishes
        // "phase emitted no clear signal" (entry value `{}`) from a real
        // success/fail boolean.
        phaseSignals[name] = signal;
      }
    }
    logger.warn("execution", "TDD plan failed but no failure category derived — defaulting to pause", {
      storyId: ctx.story.id,
      phaseSignals,
    });
  }

  // Aggregate isolation from TDD phase outputs (SPEC §3 line 211).
  const tddIsolations: Record<string, import("./types").IsolationCheck> = {};
  for (const opName of ["test-writer", "implementer", "verifier"] as const) {
    const phaseOut = planResult.phaseOutputs[opName] as { isolation?: import("./types").IsolationCheck } | undefined;
    if (phaseOut?.isolation) {
      tddIsolations[opName] = phaseOut.isolation;
    }
  }
  if (Object.keys(tddIsolations).length > 0) {
    (ctx as { tddIsolations?: typeof tddIsolations }).tddIsolations = tddIsolations;
  }

  const needsHumanReview = failureCategory === "session-failure";
  const combinedOutput = (agentResult.output ?? "") + ((agentResult as { stderr?: string }).stderr ?? "");

  // Primary success-path cleanup: verifierOp.parse (strict) + verifierOp.verify handle
  // the normal flow without calling recover, so cleanupVerdict is never invoked inside
  // verify.ts on the happy path. verifierOp.recover (disk-fallback after retry exhaustion)
  // does call cleanupVerdict in its finally block — but this call here is the primary
  // cleanup for the success path and also covers the case where the verifier never ran
  // at all (short-circuit before verify). Best-effort — failures ignored.
  if (isTdd) {
    const { cleanupVerdict } = await import("../tdd/verdict");
    await cleanupVerdict(ctx.workdir).catch(() => undefined);
  }

  // D3: derive ctx fields from phase outputs for downstream routing and diagnostics.
  const verifierPhaseOut = planResult.phaseOutputs[verifierOp.name] as
    | { success?: boolean; passed?: boolean }
    | undefined;
  const verifyScopedPhaseOut = planResult.phaseOutputs[verifyScopedOp.name] as
    | { success?: boolean; passed?: boolean }
    | undefined;
  const verifySource = verifierPhaseOut ?? verifyScopedPhaseOut;
  (ctx as unknown as Record<string, unknown>).verifyPassed =
    verifySource !== undefined ? verifySource.passed === true || verifySource.success === true : undefined;

  const semReviewOut = planResult.phaseOutputs["semantic-review"] as
    | { passed?: boolean; findings?: unknown[] }
    | undefined;
  (ctx as unknown as Record<string, unknown>).semanticReviewResult = semReviewOut
    ? { passed: semReviewOut.passed, findings: semReviewOut.findings ?? [] }
    : undefined;

  const rectOut = planResult.phaseOutputs.rectification as { iterationCount?: number } | undefined;
  (ctx as unknown as Record<string, unknown>).rectificationIterationCount = rectOut?.iterationCount ?? 0;

  return { agentResult, selfVerificationFailed, pauseReason, failureCategory, needsHumanReview, combinedOutput };
}

/**
 * Route execution based on the inspection result.
 * Handles escalation, pause, TDD rollback, merge conflict, and auto-commit.
 */
export async function decideStageAction(
  ctx: PipelineContext,
  planResult: StoryOrchestratorResult,
  inspection: PostRunInspectionResult,
  opts: InspectionOptions,
): Promise<StageResult> {
  const logger = getLogger();
  const isTdd = opts.tddMode !== null;
  const isLiteMode = opts.tddMode?.isLite ?? false;
  const shouldRollback = shouldRollbackTddFailure(opts.tddMode, inspection.failureCategory);
  const { agentResult, selfVerificationFailed, pauseReason, failureCategory, needsHumanReview, combinedOutput } =
    inspection;

  if (isTdd && !planResult.success) {
    ctx.tddFailureCategory = failureCategory;
  }

  // Mechanical-only failure: if rectification exhausted but all unfixed findings are from
  // mechanical sources (lint/typecheck), and any configured LLM reviews ran and passed
  // (the resume block in the orchestrator runs reviews even when mechanical findings are
  // unfixed — see story-orchestrator.ts mechanicalOnlyExhausted), proceed rather than
  // escalating. Reviews absent from phaseOutputs means they were not configured (OK).
  if (planResult.rectificationExhausted && planResult.unfixedFindings && planResult.unfixedFindings.length > 0) {
    // Advisory-only escape: if NONE of the remaining unfixed findings meet the
    // run's blocking threshold, the story is functionally green — do not fail it
    // on sub-blocking leftovers. This covers findings that no fix strategy can
    // claim (e.g. `source:"autofix"` declaration diagnostics) which would
    // otherwise force a `no-strategy` cycle exit into a hard story failure even
    // though every gate (tests/lint/typecheck/semantic/adversarial) passed.
    // Missing severity is treated as "error" (blocking) so a real defect is
    // never silently swallowed. Mirrors the severity-based blocking/advisory
    // partition used by the review layer (isBlockingSeverity).
    const blockingThreshold = ctx.config?.review?.blockingThreshold ?? "error";
    const blockingUnfixed = planResult.unfixedFindings.filter((f) =>
      isBlockingSeverity((f as { severity?: string }).severity ?? "error", blockingThreshold),
    );
    if (blockingUnfixed.length === 0) {
      logger.warn(
        "execution",
        "Rectification exhausted but all unfixed findings are advisory (below blocking threshold) — proceeding",
        {
          storyId: ctx.story.id,
          blockingThreshold,
          unfixedCount: planResult.unfixedFindings.length,
          unfixedSources: [...new Set(planResult.unfixedFindings.map((f) => (f as { source?: string }).source))],
        },
      );
      return { action: "continue" };
    }

    const sources = new Set(planResult.unfixedFindings.map((f) => (f as { source?: string }).source));
    const allMechanical = [...sources].every((s) => s === "lint" || s === "typecheck");
    if (allMechanical) {
      logger.warn("execution", "Mechanical-only failure unfixable — proceeding (style-only errors remain)", {
        storyId: ctx.story.id,
      });
      return { action: "continue" };
    }

    if (!(isTdd && shouldRollback)) {
      const findingSources = [...sources].filter((source): source is string => typeof source === "string");
      logger.error("execution", "Rectification exhausted with unfixed findings", {
        storyId: ctx.story.id,
        findingsCount: planResult.unfixedFindings.length,
        findingSources,
        ...(planResult.unresolvedDetail ? { unresolvedDetail: planResult.unresolvedDetail } : {}),
      });
      await cleanupSessionOnFailure(ctx);
      const exhaustedReason = planResult.unresolvedDetail
        ? `Rectification exhausted: ${planResult.unresolvedDetail}`
        : "Rectification exhausted with unfixed findings";
      return { action: "escalate", reason: exhaustedReason };
    }
  }

  // Self-verification failure → escalate
  if (selfVerificationFailed) {
    logger.warn("execution", "Self-verification reported explicit failure", {
      storyId: ctx.story.id,
      lint: ctx.selfVerification?.lint,
      typecheck: ctx.selfVerification?.typecheck,
    });
    return { action: "escalate", reason: "Self-verification reported lint/typecheck failure" };
  }

  // pauseReason → pause (with optional notify)
  if (pauseReason) {
    logger.warn("execution", "Plan run produced pauseReason", { storyId: ctx.story.id, pauseReason });
    if (ctx.interaction) {
      try {
        await ctx.interaction.send({
          id: `pause-${ctx.story.id}-${Date.now()}`,
          type: "notify",
          featureName: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? "unknown") : "unknown",
          storyId: ctx.story.id,
          stage: "execution",
          summary: `Execution paused: ${ctx.story.id}`,
          detail: `Story: ${ctx.story.title}\nReason: ${pauseReason}`,
          fallback: "continue",
          createdAt: Date.now(),
        });
      } catch (notifyErr) {
        logger.warn("execution", "Failed to send pause notification", {
          storyId: ctx.story.id,
          error: String(notifyErr),
        });
      }
    }
    return { action: "pause", reason: pauseReason };
  }

  // TDD failure → isolation rollback (only) + route
  if (isTdd && !planResult.success) {
    if (shouldRollback && opts.initialRef) {
      try {
        await _postRunDeps.rollbackToRef(ctx.workdir, opts.initialRef);
        logger.info("execution", "Rolled back git changes due to TDD failure", {
          storyId: ctx.story.id,
          failureCategory,
        });
      } catch (rollbackErr) {
        logger.error("execution", "Failed to rollback git changes after TDD failure", {
          storyId: ctx.story.id,
          error: errorMessage(rollbackErr),
        });
      }
    }

    if (needsHumanReview) {
      logger.warn("execution", "Human review needed", { storyId: ctx.story.id, failureCategory });
      if (ctx.interaction) {
        try {
          await ctx.interaction.send({
            id: `human-review-${ctx.story.id}-${Date.now()}`,
            type: "notify",
            featureName: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? "unknown") : "unknown",
            storyId: ctx.story.id,
            stage: "execution",
            summary: `Human review needed: ${ctx.story.id}`,
            detail: `Story: ${ctx.story.title}\nReason: Human review needed\nCategory: ${failureCategory ?? "unknown"}`,
            fallback: "continue",
            createdAt: Date.now(),
          });
        } catch (notifyErr) {
          logger.warn("execution", "Failed to send human review notification", {
            storyId: ctx.story.id,
            error: String(notifyErr),
          });
        }
      }
      return { action: "pause", reason: `Human review needed: ${failureCategory ?? "unknown"}` };
    }

    return routeTddFailure(failureCategory, isLiteMode, ctx);
  }

  // Merge-conflict trigger
  if (
    _postRunDeps.detectMergeConflict(combinedOutput) &&
    ctx.interaction &&
    isTriggerEnabled("merge-conflict", ctx.config)
  ) {
    const shouldProceed = await _postRunDeps.checkMergeConflict(
      { featureName: ctx.prd.feature, storyId: ctx.story.id },
      ctx.config,
      ctx.interaction,
    );
    if (!shouldProceed) {
      logger.error("execution", "Merge conflict detected — aborting story", { storyId: ctx.story.id });
      await cleanupSessionOnFailure(ctx);
      return { action: "fail", reason: "Merge conflict detected" };
    }
  }

  if (!planResult.success) {
    const failedPhases: Record<string, { passed?: boolean; success?: boolean; findingsCount?: number }> = {};
    for (const [name, output] of Object.entries(planResult.phaseOutputs)) {
      if (!output || typeof output !== "object") continue;
      const r = output as Record<string, unknown>;
      const passed = typeof r.passed === "boolean" ? r.passed : undefined;
      const success = typeof r.success === "boolean" ? r.success : undefined;
      const explicitFail = passed === false || success === false;
      if (!explicitFail) continue;
      const findings = Array.isArray(r.findings) ? r.findings.length : undefined;
      failedPhases[name] = { passed, success, findingsCount: findings };
    }
    const stderrTail = ((agentResult as { stderr?: string }).stderr ?? "").slice(-500);
    const outputTail = (agentResult.output ?? "").slice(-500);
    logger.error("execution", "Agent session failed", {
      storyId: ctx.story.id,
      exitCode: agentResult.exitCode,
      rateLimited: agentResult.rateLimited,
      failureCategory: failureCategory ?? "unknown",
      failedPhases: Object.keys(failedPhases).length > 0 ? failedPhases : undefined,
      stderrTail: stderrTail || undefined,
      outputTail: outputTail || undefined,
    });
    if (agentResult.rateLimited) {
      logger.warn("execution", "Rate limited — will retry", { storyId: ctx.story.id });
    }
    await cleanupSessionOnFailure(ctx);
    const failedPhaseNames = Object.keys(failedPhases);
    const reasonParts: string[] = [];
    reasonParts.push(`agent session failed (exit ${agentResult.exitCode ?? "?"})`);
    if (failureCategory) reasonParts.push(`category=${failureCategory}`);
    if (agentResult.rateLimited) reasonParts.push("rate-limited");
    if (failedPhaseNames.length > 0) reasonParts.push(`phases=${failedPhaseNames.join(",")}`);
    return { action: "escalate", reason: reasonParts.join("; ") };
  }

  // Non-TDD success → auto-commit
  if (!isTdd) {
    await _postRunDeps.autoCommitIfDirty(ctx.workdir, "execution", "single-session", ctx.story.id);
  }

  logger.info("execution", "Agent session complete", {
    storyId: ctx.story.id,
    cost: agentResult.estimatedCostUsd,
  });
  return { action: "continue" };
}
