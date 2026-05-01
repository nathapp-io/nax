import type { TurnResult } from "../agents/types";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import { getSafeLogger } from "../logger";
import { ReviewPromptBuilder } from "../prompts";
import type { PriorFailure } from "../prompts";
import { looksLikeTruncatedJson } from "../review/truncation";
import type { SemanticReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBody, LlmReviewFinding, LlmReviewOutput, RunOperation } from "./types";
import { parseLlmReviewShape } from "./types";

export type { PriorFailure, SemanticReviewConfig, SemanticStory };

export interface SemanticReviewInput {
  story: SemanticStory;
  semanticConfig: SemanticReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  priorFailures?: PriorFailure[];
  excludePatterns?: string[];
  /** Pre-built, role-filtered context prefix to prepend to the review prompt. */
  featureCtxBlock?: string;
  /** Severity threshold from review config — drives the JSON-retry condensation prompt. */
  blockingThreshold?: "error" | "warning" | "info";
}

export interface SemanticReviewOutput extends LlmReviewOutput {
  /**
   * True when the raw output could not be parsed but contained `"passed": false` —
   * the agent clearly intended a failure but the response was truncated/malformed.
   * Callers should treat this as a hard failure rather than fail-open.
   */
  looksLikeFail?: boolean;
}

const FAIL_OPEN: SemanticReviewOutput = { passed: true, findings: [], failOpen: true };

/**
 * Same-session JSON-parse retry. Sends the initial prompt; if the response is
 * unparseable or truncated, sends a retry prompt in the same handle so the
 * agent has full conversation history. Single retry; further failures fall
 * through to the parse() FAIL_OPEN path.
 */
const semanticReviewHopBody: HopBody<SemanticReviewInput> = async (initialPrompt, ctx) => {
  const first = await ctx.send(initialPrompt);
  const isTruncated = looksLikeTruncatedJson(first.output);
  const parsed = tryParseLLMJson<Record<string, unknown>>(first.output);
  if (!isTruncated && parsed && parseLlmReviewShape(parsed)) return first;

  const retryPrompt = isTruncated
    ? ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: ctx.input.blockingThreshold })
    : ReviewPromptBuilder.jsonRetry();
  if (isTruncated) {
    getSafeLogger()?.warn("semantic", "JSON parse retry — original response truncated", {
      storyId: ctx.input.story.id,
      originalByteSize: first.output.length,
      blockingThreshold: ctx.input.blockingThreshold ?? "error",
    });
  }
  const retry: TurnResult = await ctx.send(retryPrompt);
  return {
    ...retry,
    estimatedCostUsd: (first.estimatedCostUsd ?? 0) + (retry.estimatedCostUsd ?? 0),
  };
};

export const semanticReviewOp: RunOperation<SemanticReviewInput, SemanticReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "semantic-review",
  stage: "review",
  session: { role: "reviewer-semantic", lifetime: "fresh" },
  config: reviewConfigSelector,
  // Issue #725 — per-call tier from user-configured SemanticReviewConfig.model.
  // Without this resolver callOp would fall through to its "balanced" default and
  // silently ignore the user's review.semantic.model setting.
  model: (input) => input.semanticConfig.model,
  timeoutMs: (input) => input.semanticConfig.timeoutMs,
  hopBody: semanticReviewHopBody,
  build(input, _ctx) {
    const base = new ReviewPromptBuilder().buildSemanticReviewPrompt(input.story, input.semanticConfig, {
      mode: input.mode,
      diff: input.diff,
      storyGitRef: input.storyGitRef,
      stat: input.stat,
      priorFailures: input.priorFailures,
      excludePatterns: input.excludePatterns,
    });
    const content = input.featureCtxBlock ? `${input.featureCtxBlock}${base}` : base;
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    const parsed = parseLlmReviewShape(raw);
    if (parsed) return parsed;
    if (/"passed"\s*:\s*false/.test(output)) return { passed: false, findings: [], looksLikeFail: true };
    return FAIL_OPEN;
  },
};
