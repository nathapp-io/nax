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
import { checkMergeConflict, checkStoryAmbiguity, isTriggerEnabled } from "../interaction/triggers";
import { getLogger } from "../logger";
import { fullSuiteGateOp, greenfieldGateOp, implementerOp, testWriterOp, verifierOp } from "../operations";
import { isAmbiguousOutput } from "../pipeline/stages/execution-helpers";
import type { PipelineContext, StageResult } from "../pipeline/types";
import { parseSelfVerificationMarker } from "../quality";
import { appendScratchEntry } from "../session/scratch-writer";
import { rollbackToRef } from "../tdd/session-runner";
import type { FailureCategory } from "../tdd/types";
import { errorMessage } from "../utils/errors";
import { autoCommitIfDirty, detectMergeConflict } from "../utils/git";
import { failAndClose } from "./session-manager-runtime";
import type { StoryOrchestratorResult } from "./story-orchestrator";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InspectionOptions {
  capturedTokenUsage?: import("../agents/cost").TokenUsage;
  capturedResponse: string;
  capturedCostUsd: number;
  isTdd: boolean;
  isLiteMode: boolean;
  initialRef: string | null;
  shouldRollbackOnFailure: boolean;
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
  isAmbiguousOutput,
  checkStoryAmbiguity,
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

/** Derive TDD failure category from phase outputs after plan.run(). */
export function deriveTddFailureCategory(phaseOutputs: Record<string, unknown>): FailureCategory | undefined {
  // Test-writer failure → session-failure
  const testWriterOutput = phaseOutputs[testWriterOp.name] as { success?: boolean } | undefined;
  if (testWriterOutput?.success === false) {
    return "session-failure";
  }

  // Greenfield gate: when success=false + pauseReason="greenfield-no-tests", the pause
  // handler in extractPauseReason fires first. deriveTddFailureCategory also checks it so
  // the failureCategory is set correctly for non-pause paths (e.g. tests that bypass pause).
  const greenfieldOutput = phaseOutputs[greenfieldGateOp.name] as
    | { success?: boolean; pauseReason?: string }
    | undefined;
  if (greenfieldOutput?.success === false && greenfieldOutput?.pauseReason === "greenfield-no-tests") {
    return "greenfield-no-tests";
  }

  // Verifier failure → derive from verifier output
  const verifierOutput = phaseOutputs[verifierOp.name] as { success?: boolean; failureCategory?: string } | undefined;
  if (verifierOutput?.success === false) {
    if (verifierOutput.failureCategory) {
      return verifierOutput.failureCategory as FailureCategory;
    }
    return "tests-failing";
  }

  // Implementer failure → session-failure
  const implOutput = phaseOutputs[implementerOp.name] as { success?: boolean } | undefined;
  if (implOutput?.success === false) {
    return "session-failure";
  }

  return undefined;
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
  const { capturedTokenUsage, capturedResponse, capturedCostUsd, isTdd } = opts;

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
  ctx.agentSwapCount = 0;

  // Propagate full-suite gate result so verify stage can skip redundant run (BUG-054)
  const fullSuiteGateOutput = planResult.phaseOutputs[fullSuiteGateOp.name] as { passed?: boolean } | undefined;
  if (fullSuiteGateOutput?.passed) {
    ctx.fullSuiteGatePassed = true;
  }

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

  const pauseReason = extractPauseReason(planResult.phaseOutputs);
  const failureCategory = isTdd && !planResult.success ? deriveTddFailureCategory(planResult.phaseOutputs) : undefined;
  const needsHumanReview = failureCategory === "session-failure";
  const combinedOutput = (agentResult.output ?? "") + ((agentResult as { stderr?: string }).stderr ?? "");

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
  const { isTdd, isLiteMode } = opts;
  const { agentResult, selfVerificationFailed, pauseReason, failureCategory, needsHumanReview, combinedOutput } =
    inspection;

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

  // TDD failure → rollback + route
  if (isTdd && !planResult.success) {
    ctx.tddFailureCategory = failureCategory;

    if (opts.shouldRollbackOnFailure && opts.initialRef) {
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

    // Import routeTddFailure here to avoid circular dep via execution-helpers
    const { routeTddFailure } = await import("../pipeline/stages/execution-helpers");
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
      if (ctx.sessionManager && ctx.sessionId) {
        await _postRunDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
      }
      return { action: "fail", reason: "Merge conflict detected" };
    }
  }

  if (!planResult.success) {
    logger.error("execution", "Agent session failed", {
      storyId: ctx.story.id,
      exitCode: agentResult.exitCode,
      rateLimited: agentResult.rateLimited,
    });
    if (agentResult.rateLimited) {
      logger.warn("execution", "Rate limited — will retry", { storyId: ctx.story.id });
    }
    if (ctx.sessionManager && ctx.sessionId) {
      await _postRunDeps.failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
    }
    return { action: "escalate" };
  }

  // Story-ambiguity trigger
  if (
    agentResult.success &&
    _postRunDeps.isAmbiguousOutput(combinedOutput) &&
    ctx.interaction &&
    isTriggerEnabled("story-ambiguity", ctx.config)
  ) {
    const shouldContinue = await _postRunDeps.checkStoryAmbiguity(
      { featureName: ctx.prd.feature, storyId: ctx.story.id, reason: "Agent output suggests ambiguity" },
      ctx.config,
      ctx.interaction,
    );
    if (!shouldContinue) {
      logger.warn("execution", "Story ambiguity detected — escalating story", { storyId: ctx.story.id });
      return { action: "escalate", reason: "Story ambiguity detected — needs clarification" };
    }
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
