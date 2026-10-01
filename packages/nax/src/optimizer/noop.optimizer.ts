import type { IPromptOptimizer, PromptOptimizerInput, PromptOptimizerResult } from "./types.js";
import { estimateTokens } from "./types.js";

/**
 * Passthrough optimizer that returns the prompt unchanged.
 *
 * Used as the default when optimization is disabled or
 * when the configured strategy is unrecognized.
 */
export class NoopOptimizer implements IPromptOptimizer {
  public readonly name = "noop";

  async optimize(input: PromptOptimizerInput): Promise<PromptOptimizerResult> {
    const tokens = estimateTokens(input.prompt);

    return {
      prompt: input.prompt,
      originalTokens: tokens,
      optimizedTokens: tokens,
      savings: 0,
      appliedRules: [],
    };
  }
}
