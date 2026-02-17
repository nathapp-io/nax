/**
 * Pipeline Runner
 *
 * Executes a sequence of pipeline stages, handling stage results and
 * controlling the flow (continue/skip/fail/escalate/pause).
 */

import chalk from "chalk";
import type { PipelineContext, PipelineStage, StageResult } from "./types";
import type { PipelineEventEmitter } from "./events";

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
 * **IMPORTANT - Context Mutation Contract:**
 * This function mutates the input context in-place. Stages modify the context
 * object directly (e.g., `ctx.constitution = result`, `ctx.routing = routing`).
 * The returned `context` in PipelineRunResult is the same object reference,
 * not a clone. If you need immutability, clone the context before calling
 * runPipeline.
 *
 * @param stages - Array of pipeline stages to execute
 * @param context - Initial pipeline context (WILL BE MUTATED IN-PLACE)
 * @param eventEmitter - Optional event emitter for TUI integration
 * @returns Pipeline execution result with mutated context
 *
 * @example
 * ```ts
 * const stages = [routingStage, contextStage, executionStage];
 * const ctx = createInitialContext(); // { config, prd, story, ... }
 *
 * const result = await runPipeline(stages, ctx);
 *
 * if (result.success) {
 *   console.log("Pipeline completed successfully");
 *   // ctx and result.context are the same object
 *   console.log(ctx.agentResult === result.context.agentResult); // true
 * } else {
 *   console.log(`Pipeline stopped: ${result.finalAction} - ${result.reason}`);
 * }
 * ```
 */
export async function runPipeline(
  stages: PipelineStage[],
  context: PipelineContext,
  eventEmitter?: PipelineEventEmitter,
): Promise<PipelineRunResult> {
  for (const stage of stages) {
    // Skip disabled stages
    if (!stage.enabled(context)) {
      console.log(chalk.dim(`   → Stage "${stage.name}" skipped (disabled)`));
      continue;
    }

    // Emit stage:enter event
    eventEmitter?.emit("stage:enter", stage.name, context.story);

    // Execute the stage
    let result: StageResult;
    try {
      result = await stage.execute(context);
    } catch (error) {
      // Stage execution failed with an exception
      const failResult: StageResult = {
        action: "fail",
        reason: `Stage "${stage.name}" threw error: ${error instanceof Error ? error.message : String(error)}`,
      };

      // Emit stage:exit event
      eventEmitter?.emit("stage:exit", stage.name, failResult);

      return {
        success: false,
        finalAction: "fail",
        reason: failResult.reason,
        stoppedAtStage: stage.name,
        context,
      };
    }

    // Emit stage:exit event
    eventEmitter?.emit("stage:exit", stage.name, result);

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
