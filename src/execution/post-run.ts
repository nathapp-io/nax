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
import { checkMergeConflict } from "../interaction/triggers";
import { getLogger } from "../logger";
import { fullSuiteGateOp, implementerOp } from "../operations";
import type { PipelineContext, StageResult } from "../pipeline/types";
import { parseSelfVerificationMarker } from "../quality";
// Leaf import, not the barrel — the barrel pulls formatter.ts, causing a circular ESM init crash (BUG v0.71.0).
import { rollbackToRef } from "../tdd/rollback";
import { autoCommitIfDirty, detectMergeConflict } from "../utils/git";
import { writePostRunScratchEntries } from "./lifecycle/post-run-scratch-entries";
import type { DecideFrame } from "./post-run-decide-action";
import {
  autoCommitIfNeeded,
  escalateFailedSession,
  failOnMergeConflict,
  hasRectificationExhaustion,
  isTddFailure,
  pauseForReason,
  persistRollForward,
  routeRectificationExhaustion,
  routeTddFailureBranch,
  selfVerificationEscalation,
} from "./post-run-decide-action";
import { applyReviewsFailedOpen } from "./post-run-review-summary";
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
  /** Untracked-paths snapshot taken alongside initialRef (BUG-07 rollback baseline). */
  untrackedBefore: string[] | null;
}

export interface PostRunInspectionResult {
  readonly agentResult: AgentResult;
  readonly selfVerificationFailed: boolean;
  readonly pauseReason?: string;
  readonly failureCategory?: FailureCategory;
  readonly needsHumanReview: boolean;
  readonly providerUnavailable: boolean;
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

  const lastFailure = ctx.runtime.lastAdapterFailure.get(ctx.story.id);
  /**
   * A session failure the provider caused, not one a human must look at.
   * nax#1892: `needsHumanReview` fired on the category alone, so a rate limit
   * parked the story at attempt 1 while an identically-caused story on a
   * different test strategy escalated and passed.
   */
  const providerUnavailable =
    lastFailure?.outcome === "fail-rate-limit" ||
    lastFailure?.outcome === "fail-quota" ||
    lastFailure?.outcome === "fail-service-down";

  const agentResult: AgentResult = {
    success: implementerOutput?.success ?? false,
    estimatedCostUsd: capturedCostUsd || planResult.phaseCosts[implementerOp.name] || 0,
    rateLimited: lastFailure?.outcome === "fail-rate-limit",
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
  // Snapshot failing test files from the (post-rectification) gate findings so deferred-regression blame can
  // attribute a regression to the introducing story (three-session + deferred). See findResponsibleStoryByTransition.
  const gateFailingFiles = [
    ...new Set((fullSuiteGateOutput?.findings ?? []).map((f) => f.file).filter((f): f is string => !!f)),
  ];
  if (gateFailingFiles.length > 0) ctx.fullSuiteGateFailingFiles = gateFailingFiles;

  applyReviewsFailedOpen(ctx, planResult.phaseOutputs); // ENH-20
  // Self-verification from implementer output
  ctx.selfVerification = parseSelfVerificationMarker(agentResult.output ?? "", ctx.workdir);
  const selfVerificationFailed = ctx.selfVerification.lint === "fail" || ctx.selfVerification.typecheck === "fail";

  // US-002 — write the self-verification + per-role tdd-session scratch entries.
  // Extracted to `./lifecycle/post-run-scratch-entries` to keep this file
  // within the 600-line gate. Same try/catch-everything posture: scratch-write
  // failures never fail the story.
  await writePostRunScratchEntries(ctx, planResult, opts);

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

  const needsHumanReview = failureCategory === "session-failure" && !providerUnavailable;
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

  // #1084 AC9 also set `verifyPassed` and `semanticReviewResult` here, both through a
  // cast onto undeclared keys. Neither was ever read — the AC pinned the write and no AC
  // pinned a reader, so they were removed rather than declared (nax#1707 follow-up).
  // Verify outcome reaches routing via tdd-failure-category.ts and review outcome via the
  // findings pipeline; nothing needed the cached copies.
  // BUG-067 / #679: rectifyAttempt > 0 disqualifies firstPassSuccess in collectStoryMetrics.
  // This wrote an undeclared `rectificationIterationCount` nothing read, leaving the declared
  // field with no writer and the disqualification dead (nax#1707 follow-up).
  const rectOut = planResult.phaseOutputs.rectification as { iterationCount?: number } | undefined;
  ctx.rectifyAttempt = rectOut?.iterationCount ?? 0;

  return {
    agentResult,
    selfVerificationFailed,
    pauseReason,
    failureCategory,
    needsHumanReview,
    providerUnavailable,
    combinedOutput,
  };
}

/**
 * Route execution based on the inspection result.
 * Handles escalation, pause, TDD rollback, merge conflict, and auto-commit.
 *
 * This is the decision-table SEQUENCER (complexity drain B1): each branch's
 * predicate is named and its handler lives in `./post-run-decide-action`.
 * Branch order is behaviour — it matches the pre-extraction monolith exactly.
 */
export async function decideStageAction(
  ctx: PipelineContext,
  planResult: StoryOrchestratorResult,
  inspection: PostRunInspectionResult,
  opts: InspectionOptions,
): Promise<StageResult> {
  const logger = getLogger();
  const isTdd = opts.tddMode !== null;
  const { failureCategory } = inspection;

  if (isTdd && !planResult.success) {
    ctx.tddFailureCategory = failureCategory;
  }

  const frame: DecideFrame = { ctx, planResult, inspection, opts, deps: _postRunDeps };

  // Rectification exhausted → three exits, or fall through to TDD rollback routing
  if (hasRectificationExhaustion(planResult)) {
    const exhausted = await routeRectificationExhaustion(frame);
    if (exhausted) return exhausted;
  }

  // Self-verification failure → escalate
  if (inspection.selfVerificationFailed) return selfVerificationEscalation(frame);

  // pauseReason → pause (with optional notify)
  if (inspection.pauseReason) return pauseForReason(frame, inspection.pauseReason);

  // TDD failure → isolation rollback (only) + route
  if (isTddFailure(opts, planResult)) return routeTddFailureBranch(frame);

  // Merge-conflict trigger
  const conflict = await failOnMergeConflict(frame);
  if (conflict) return conflict;

  if (!planResult.success) return escalateFailedSession(frame);

  // Non-TDD success → auto-commit
  await autoCommitIfNeeded(frame);

  // US-002 — sequential story completion persists the next story's roll-forward baseline.
  await persistRollForward(frame);

  logger.info("execution", "Agent session complete", {
    storyId: ctx.story.id,
    cost: inspection.agentResult.estimatedCostUsd,
  });
  return { action: "continue" };
}
