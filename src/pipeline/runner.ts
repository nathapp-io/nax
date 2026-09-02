/**
 * Pipeline Runner
 *
 * Executes a sequence of pipeline stages, handling stage results and
 * controlling the flow (continue/skip/fail/escalate/pause/retry).
 */

import { getLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import type { PipelineEventEmitter } from "./events";
import type { PipelineContext, PipelineStage, StageResult } from "./types";

/**
 * Pipeline execution result.
 */
export interface PipelineRunResult {
  /** Whether the pipeline completed successfully (reached the end) */
  success: boolean;
  /** Final action taken */
  finalAction: "complete" | "skip" | "decomposed" | "fail" | "escalate" | "pause";
  /** Reason for non-complete outcomes */
  reason?: string;
  /** Number of sub-stories created (only set when finalAction === "decomposed") */
  subStoryCount?: number;
  /** Stage where the pipeline stopped (if not completed) */
  stoppedAtStage?: string;
  /** Updated context after pipeline execution */
  context: PipelineContext;
  /**
   * Sum of cost reported by secondary agent calls within pipeline stages
   * (e.g. rectification loops, semantic review, acceptance diagnosis).
   * Distinct from context.agentResult.estimatedCostUsd which holds the main execution cost.
   */
  stageCost?: number;
}

/** Maximum number of retries per stage to prevent infinite loops. */
export const MAX_STAGE_RETRIES = 5;

/**
 * Maximum number of times a fixer stage (rectify/autofix) may reset the retry
 * counter for a target stage via `resetRetryCount: true`. Capped at 1 so that
 * a divergence between the fixer's internal verify and the outer pipeline verify
 * cannot produce an infinite reset loop.
 */
export const MAX_STAGE_RESETS = 1;

/**
 * Run a pipeline of stages against a context.
 *
 * Supports a `retry` action that jumps back to a named stage (used by
 * rectify/autofix stages). Retry count per target stage is tracked;
 * exceeding MAX_STAGE_RETRIES converts to a `fail`.
 *
 * **Context Mutation:** This function mutates the input context in-place.
 */
/**
 * Did the pipeline stop because something went wrong?
 *
 * `PipelineRunResult.success` is false for **skip, pause, escalate and fail**
 * alike — it means "did not reach the end", not "failed". Several of those are
 * healthy: `acceptanceSetupStage` skips deliberately when the acceptance tests
 * already pass. Callers deciding a log level must ask this, not `!success`,
 * or they raise an alarm on a routine outcome.
 */
export function isPipelineFailure(result: PipelineRunResult): boolean {
  return result.finalAction === "fail" || result.finalAction === "escalate";
}

/**
 * Report how a pipeline ended, at a level that matches what actually happened.
 *
 * Exists because callers that discard a `PipelineRunResult` lose the only
 * record of a failed stage — the pre-run acceptance pipeline did exactly that,
 * so a failed acceptance setup left no trace and the run continued as though
 * the gate had been installed.
 */
export function logPipelineOutcome(result: PipelineRunResult, label: string, storyId?: string): void {
  if (result.success) return;
  const data = {
    storyId,
    stoppedAtStage: result.stoppedAtStage,
    finalAction: result.finalAction,
    reason: result.reason,
  };
  if (isPipelineFailure(result)) {
    getLogger().error("execution", `${label} failed — continuing without it`, data);
    return;
  }
  getLogger().info("execution", `${label} did not complete`, data);
}

export async function runPipeline(
  stages: PipelineStage[],
  context: PipelineContext,
  eventEmitter?: PipelineEventEmitter,
): Promise<PipelineRunResult> {
  const logger = getLogger();
  const retryCountMap = new Map<string, number>();
  // Tracks how many times each stage's counter has been reset via resetRetryCount.
  // Capped at MAX_STAGE_RESETS to prevent infinite loops when the fixer's internal
  // verify diverges from the outer pipeline verify (e.g. different timeout/command).
  const retryResetCountMap = new Map<string, number>();
  let i = 0;
  let stageCostAccum = 0;

  while (i < stages.length) {
    const stage = stages[i];

    // Skip disabled stages
    if (!stage.enabled(context)) {
      const reason = stage.skipReason?.(context) ?? "disabled";
      logger.debug("pipeline", `Stage "${stage.name}" skipped (${reason})`);
      i++;
      continue;
    }

    eventEmitter?.emit("stage:enter", stage.name, context.story);

    let result: StageResult;
    try {
      result = await stage.execute(context);
    } catch (error) {
      const failResult: StageResult = {
        action: "fail",
        reason: `Stage "${stage.name}" threw error: ${errorMessage(error)}`,
      };
      // A throw is logged here, not just returned. Callers may discard the
      // result — the pre-run acceptance pipeline did — and an unlogged throw
      // then leaves no trace of why the stage stopped.
      logger.error("pipeline", "Stage threw error", {
        storyId: context.story?.id,
        stage: stage.name,
        error: errorMessage(error),
      });
      eventEmitter?.emit("stage:exit", stage.name, failResult);
      return {
        success: false,
        finalAction: "fail",
        reason: failResult.reason,
        stoppedAtStage: stage.name,
        context,
        stageCost: stageCostAccum > 0 ? stageCostAccum : undefined,
      };
    }

    if (result.cost) stageCostAccum += result.cost;
    eventEmitter?.emit("stage:exit", stage.name, result);

    switch (result.action) {
      case "continue":
        i++;
        continue;

      case "skip":
        return {
          success: false,
          finalAction: "skip",
          reason: result.reason,
          stoppedAtStage: stage.name,
          context,
          stageCost: stageCostAccum > 0 ? stageCostAccum : undefined,
        };

      case "fail":
        return {
          success: false,
          finalAction: "fail",
          reason: result.reason,
          stoppedAtStage: stage.name,
          context,
          stageCost: stageCostAccum > 0 ? stageCostAccum : undefined,
        };

      case "escalate":
        return {
          success: false,
          finalAction: "escalate",
          reason: result.reason ?? "Stage requested escalation to higher tier",
          stoppedAtStage: stage.name,
          context,
          stageCost: stageCostAccum > 0 ? stageCostAccum : undefined,
        };

      case "pause":
        return {
          success: false,
          finalAction: "pause",
          reason: result.reason,
          stoppedAtStage: stage.name,
          context,
          stageCost: stageCostAccum > 0 ? stageCostAccum : undefined,
        };

      case "retry": {
        if (result.resetRetryCount) {
          const resets = (retryResetCountMap.get(result.fromStage) ?? 0) + 1;
          if (resets <= MAX_STAGE_RESETS) {
            retryResetCountMap.set(result.fromStage, resets);
            retryCountMap.delete(result.fromStage);
          }
          // If reset cap is exceeded, fall through — counter continues incrementing
          // normally and the stage will escalate once MAX_STAGE_RETRIES is reached.
        }
        const retries = (retryCountMap.get(result.fromStage) ?? 0) + 1;
        if (retries > MAX_STAGE_RETRIES) {
          logger.warn("pipeline", `Stage retry limit reached for "${result.fromStage}" (max ${MAX_STAGE_RETRIES})`);
          return {
            success: false,
            finalAction: "escalate",
            reason: `Stage "${stage.name}" exceeded max retries (${MAX_STAGE_RETRIES}) for "${result.fromStage}"`,
            stoppedAtStage: stage.name,
            context,
            stageCost: stageCostAccum > 0 ? stageCostAccum : undefined,
          };
        }
        retryCountMap.set(result.fromStage, retries);
        const targetIndex = stages.findIndex((s) => s.name === result.fromStage);
        if (targetIndex === -1) {
          logger.warn("pipeline", `Retry target stage "${result.fromStage}" not found — escalating`);
          return {
            success: false,
            finalAction: "escalate",
            reason: `Retry target stage "${result.fromStage}" not found`,
            stoppedAtStage: stage.name,
            context,
            stageCost: stageCostAccum > 0 ? stageCostAccum : undefined,
          };
        }
        logger.debug("pipeline", `Retrying from stage "${result.fromStage}" (attempt ${retries}/${MAX_STAGE_RETRIES})`);
        i = targetIndex;
        continue;
      }

      default: {
        const _exhaustive: never = result;
        throw new Error(`Unknown stage action: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return {
    success: true,
    finalAction: "complete",
    context,
    stageCost: stageCostAccum > 0 ? stageCostAccum : undefined,
  };
}
