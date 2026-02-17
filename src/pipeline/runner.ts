/**
 * Pipeline Runner
 *
 * Executes a sequence of pipeline stages, handling stage results and
 * controlling the flow (continue/skip/fail/escalate/pause).
 */

import type { PipelineContext, PipelineStage, StageResult } from "./types";

/**
 * Pipeline execution result.
 */
export interface PipelineRunResult {
  /** Whether the pipeline completed successfully (reached the end) */
  success: boolean;
  /** Final action taken (e.g., "skip", "fail", "escalate", "pause", "complete") */
  finalAction: "complete" | "skip" | "fail" | "escalate" | "pause";
  /** Reason for non-complete outcomes */
  reason?: string;
  /** Stage where the pipeline stopped (if not completed) */
  stoppedAtStage?: string;
  /** Updated context after pipeline execution */
  context: PipelineContext;
}

/**
 * Run a pipeline of stages against a context.
 *
 * Iterates through each enabled stage, executing them in sequence.
 * Stops early if a stage returns skip/fail/escalate/pause.
 *
 * @param stages - Array of pipeline stages to execute
 * @param context - Initial pipeline context
 * @returns Pipeline execution result
 *
 * @example
 * ```ts
 * const stages = [routingStage, contextStage, executionStage];
 * const result = await runPipeline(stages, initialContext);
 *
 * if (result.success) {
 *   console.log("Pipeline completed successfully");
 * } else {
 *   console.log(`Pipeline stopped: ${result.finalAction} - ${result.reason}`);
 * }
 * ```
 */
export async function runPipeline(
  stages: PipelineStage[],
  context: PipelineContext,
): Promise<PipelineRunResult> {
  for (const stage of stages) {
    // Skip disabled stages
    if (!stage.enabled(context)) {
      continue;
    }

    // Execute the stage
    let result: StageResult;
    try {
      result = await stage.execute(context);
    } catch (error) {
      // Stage execution failed with an exception
      return {
        success: false,
        finalAction: "fail",
        reason: `Stage "${stage.name}" threw error: ${error instanceof Error ? error.message : String(error)}`,
        stoppedAtStage: stage.name,
        context,
      };
    }

    // Handle stage result
    switch (result.action) {
      case "continue":
        // Proceed to next stage
        continue;

      case "skip":
        return {
          success: false,
          finalAction: "skip",
          reason: result.reason,
          stoppedAtStage: stage.name,
          context,
        };

      case "fail":
        return {
          success: false,
          finalAction: "fail",
          reason: result.reason,
          stoppedAtStage: stage.name,
          context,
        };

      case "escalate":
        return {
          success: false,
          finalAction: "escalate",
          reason: "Stage requested escalation to higher tier",
          stoppedAtStage: stage.name,
          context,
        };

      case "pause":
        return {
          success: false,
          finalAction: "pause",
          reason: result.reason,
          stoppedAtStage: stage.name,
          context,
        };

      default:
        // Exhaustiveness check
        const _exhaustive: never = result;
        throw new Error(`Unknown stage action: ${JSON.stringify(_exhaustive)}`);
    }
  }

  // All stages completed successfully
  return {
    success: true,
    finalAction: "complete",
    context,
  };
}
