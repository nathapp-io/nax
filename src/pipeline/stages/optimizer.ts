/**
 * Optimizer Stage
 *
 * Optimizes the assembled prompt to reduce token usage while preserving
 * semantic meaning. Runs between prompt assembly and agent execution.
 *
 * Resolution order for optimizer selection:
 * 1. Plugin-provided optimizer (if plugins loaded)
 * 2. Built-in strategy from config (rule-based, noop)
 * 3. Fallback to NoopOptimizer
 *
 * @returns
 * - `continue`: Optimization complete (or skipped if disabled)
 *
 * @example
 * ```ts
 * // With rule-based optimizer enabled
 * await optimizerStage.execute(ctx);
 * // ctx.prompt: optimized, whitespace stripped, criteria compacted
 * // Logs: "optimizer: rule-based: 15% savings"
 *
 * // With optimizer disabled
 * await optimizerStage.execute(ctx);
 * // ctx.prompt: unchanged (passthrough)
 * // Logs: "optimizer: noop: 0% savings"
 * ```
 */

import { getLogger } from "../../logger/index.js";
import { resolveOptimizer } from "../../optimizer/index.js";
import type { PipelineContext, PipelineStage, StageResult } from "../types.js";

export const optimizerStage: PipelineStage = {
  name: "optimizer",
  enabled: (_ctx) => {
    // Always enabled - NoopOptimizer is used when optimization is disabled
    return true;
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // Ensure prompt exists
    if (!ctx.prompt) {
      logger.warn("optimizer", "No prompt to optimize, skipping");
      return { action: "continue" };
    }

    // Resolve optimizer (checks plugins first, then config)
    const optimizer = resolveOptimizer(ctx.config, ctx.plugins);

    // Optimize the prompt
    const result = await optimizer.optimize({
      prompt: ctx.prompt,
      stories: ctx.stories,
      contextMarkdown: ctx.contextMarkdown,
      config: ctx.config,
    });

    // Update context with optimized prompt
    ctx.prompt = result.prompt;

    // Log optimization results
    const savingsPercent = Math.round(result.savings * 100);
    logger.info("optimizer", `${optimizer.name}: ${savingsPercent}% savings`, {
      originalTokens: result.originalTokens,
      optimizedTokens: result.optimizedTokens,
      tokensSaved: result.originalTokens - result.optimizedTokens,
      appliedRules: result.appliedRules,
    });

    return { action: "continue" };
  },
};
