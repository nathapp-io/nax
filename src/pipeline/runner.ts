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
}

/** Maximum number of retries per stage to prevent infinite loops. */
export const MAX_STAGE_RETRIES = 5;

/**
 * Run a pipeline of stages against a context.
 *
 * Supports a `retry` action that jumps back to a named stage (used by
 * rectify/autofix stages). Retry count per target stage is tracked;
 * exceeding MAX_STAGE_RETRIES converts to a `fail`.
 *
 * **Context Mutation:** This function mutates the input context in-place.
 */
export async function runPipeline(
  stages: PipelineStage[],
  context: PipelineContext,
  eventEmitter?: PipelineEventEmitter,
): Promise<PipelineRunResult> {
  const logger = getLogger();
  const retryCountMap = new Map<string, number>();
  let i = 0;

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
      eventEmitter?.emit("stage:exit", stage.name, failResult);
      return { success: false, finalAction: "fail", reason: failResult.reason, stoppedAtStage: stage.name, context };
    }

    eventEmitter?.emit("stage:exit", stage.name, result);

    switch (result.action) {
      case "continue":
        i++;
        continue;

      case "skip":
        return { success: false, finalAction: "skip", reason: result.reason, stoppedAtStage: stage.name, context };

      case "decomposed":
        return {
          success: false,
          finalAction: "decomposed",
          reason: result.reason,
          subStoryCount: result.subStoryCount,
          stoppedAtStage: stage.name,
          context,
        };

      case "fail":
        return { success: false, finalAction: "fail", reason: result.reason, stoppedAtStage: stage.name, context };

      case "escalate":
        return {
          success: false,
          finalAction: "escalate",
          reason: result.reason ?? "Stage requested escalation to higher tier",
          stoppedAtStage: stage.name,
          context,
        };

      case "pause":
        return { success: false, finalAction: "pause", reason: result.reason, stoppedAtStage: stage.name, context };

      case "retry": {
        const retries = (retryCountMap.get(result.fromStage) ?? 0) + 1;
        if (retries > MAX_STAGE_RETRIES) {
          logger.warn("pipeline", `Stage retry limit reached for "${result.fromStage}" (max ${MAX_STAGE_RETRIES})`);
          return {
            success: false,
            finalAction: "fail",
            reason: `Stage "${stage.name}" exceeded max retries (${MAX_STAGE_RETRIES}) for "${result.fromStage}"`,
            stoppedAtStage: stage.name,
            context,
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

  return { success: true, finalAction: "complete", context };
}
