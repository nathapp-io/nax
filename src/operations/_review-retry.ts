import type { TurnResult } from "../agents/types";
import { getSafeLogger } from "../logger";
import { ReviewPromptBuilder } from "../prompts";
import { looksLikeTruncatedJson } from "../review/truncation";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBody, HopBodyContext } from "./types";

interface RetryInput {
  story: { id: string };
  blockingThreshold?: "error" | "warning" | "info";
}

/**
 * Same-session JSON-parse retry, parser-first.
 *
 * Trust the parser as the oracle: if `tryParseLLMJson` + `validate` both succeed,
 * return the original response regardless of length. Length is a hint used only
 * to choose between retry-prompt variants when parsing actually failed.
 *
 * Replaces the previous "length-veto" logic that retried valid responses purely
 * because their length was near MAX_AGENT_OUTPUT_CHARS, which then triggered a
 * condensed-retry schema that stripped `verifiedBy` and silently downgraded
 * `error` findings to `unverifiable`.
 */
export function makeReviewRetryHopBody<I extends RetryInput>(
  validate: (parsed: unknown) => boolean,
  reviewerKind: "semantic" | "adversarial",
): HopBody<I> {
  return async (initialPrompt: string, ctx: HopBodyContext<I>): Promise<TurnResult> => {
    const first = await ctx.send(initialPrompt);
    const parsed = tryParseLLMJson<Record<string, unknown>>(first.output);

    // Parser is the oracle. If it accepts and the shape validates, return.
    if (parsed && validate(parsed)) return first;

    // Genuine retry needed. Use length only to pick the prompt variant.
    const isTruncated = !parsed && looksLikeTruncatedJson(first.output);
    const retryPrompt = isTruncated
      ? ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: ctx.input.blockingThreshold })
      : ReviewPromptBuilder.jsonRetry();

    if (isTruncated) {
      getSafeLogger()?.warn(reviewerKind, "JSON parse retry — likely truncated", {
        storyId: ctx.input.story.id,
        originalByteSize: first.output.length,
        blockingThreshold: ctx.input.blockingThreshold ?? "error",
      });
    } else {
      getSafeLogger()?.warn(reviewerKind, "JSON parse retry — invalid shape", {
        storyId: ctx.input.story.id,
        originalByteSize: first.output.length,
      });
    }

    const retry: TurnResult = await ctx.send(retryPrompt);
    return {
      ...retry,
      estimatedCostUsd: (first.estimatedCostUsd ?? 0) + (retry.estimatedCostUsd ?? 0),
    };
  };
}
