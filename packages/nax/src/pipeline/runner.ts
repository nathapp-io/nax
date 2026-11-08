/**
 * Pipeline Runner
 *
 * Executes a sequence of pipeline stages, handling stage results and
 * controlling the flow (continue/skip/fail/escalate/pause).
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
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

/** Live-phase reporting is observational: a failing callback is logged and must not end the run. */
function reportStagePhase(context: PipelineContext, stageName: string): void {
  try {
    context.reportPhase?.(stageName);
  } catch (error) {
    getLogger().warn("pipeline", `reportPhase failed for stage "${stageName}"`, {
      storyId: context.story.id,
      error: errorMessage(error),
    });
  }
}

/**
 * Run a pipeline of stages against a context.
 *
 * **Context Mutation:** This function mutates the input context in-place.
 */
export async function runPipeline(
  stages: PipelineStage[],
  context: PipelineContext,
  eventEmitter?: PipelineEventEmitter,
): Promise<PipelineRunResult> {
  const logger = getLogger();
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

    reportStagePhase(context, stage.name);
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

      default: {
        const _exhaustive: never = result;
        throw new NaxError(`Unknown stage action: ${JSON.stringify(_exhaustive)}`, "UNKNOWN_STAGE_ACTION", {
          stage: "pipeline",
        });
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
