/**
 * A correctly-shaped `PromptOptimizerResult` for plugin fixtures.
 *
 * The optimizer stubs in `test/integration/plugins/loader.test.ts` predate an
 * interface change: they returned `{ optimizedPrompt, estimatedTokens,
 * tokensSaved, appliedStrategies }` and read `input.estimatedTokens`, a field
 * `PromptOptimizerInput` has never had. That is 22 typecheck errors across 11
 * byte-identical stubs (#1514 §5.2) — one missing factory, copy-pasted.
 *
 * Unlike `makeDebateRunner`, this needs no cast: `PromptOptimizerResult` is a
 * plain interface, so the factory satisfies it structurally.
 */
import { estimateTokens, type PromptOptimizerResult } from "@/optimizer/types";

/**
 * Defaults describe a no-op optimizer: the prompt is returned unchanged, so
 * `originalTokens === optimizedTokens` and `savings` is 0. Pass `prompt` to
 * echo the input; override the token fields when a test asserts on savings.
 *
 * ```ts
 * optimizer: {
 *   name: "test",
 *   async optimize(input) {
 *     return makeOptimizerResult({ prompt: input.prompt });
 *   },
 * },
 * ```
 */
export function makeOptimizerResult(overrides: Partial<PromptOptimizerResult> = {}): PromptOptimizerResult {
  const prompt = overrides.prompt ?? "";
  const tokens = estimateTokens(prompt);
  return {
    prompt,
    originalTokens: tokens,
    optimizedTokens: tokens,
    savings: 0,
    appliedRules: [],
    ...overrides,
  };
}
