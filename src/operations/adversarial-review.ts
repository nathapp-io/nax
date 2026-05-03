import type { TurnResult } from "../agents/types";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Iteration } from "../findings";
import { getSafeLogger } from "../logger";
import { AdversarialReviewPromptBuilder, ReviewPromptBuilder } from "../prompts";
import type { TestInventory } from "../prompts";
import { validateAdversarialShape } from "../review/adversarial-helpers";
import { looksLikeTruncatedJson } from "../review/truncation";
import type { AdversarialReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBody, RunOperation } from "./types";

export type { AdversarialReviewConfig, SemanticStory, TestInventory };

export interface AdversarialReviewInput {
  story: SemanticStory;
  adversarialConfig: AdversarialReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  testInventory?: TestInventory;
  testGlobs?: readonly string[];
  excludePatterns?: string[];
  refExcludePatterns?: readonly string[];
  /** Pre-built, role-filtered context prefix to prepend to the review prompt. */
  featureCtxBlock?: string;
  /** Prior adversarial review iterations to carry forward into this round (ADR-022 phase 5). */
  priorAdversarialIterations?: Iteration[];
  /** Severity threshold from review config — drives the JSON-retry condensation prompt. */
  blockingThreshold?: "error" | "warning" | "info";
}

export interface AdversarialReviewOutput {
  passed: boolean;
  findings: unknown[];
  failOpen?: boolean;
  /**
   * True when the raw output could not be parsed but contained `"passed": false`.
   * Callers should treat this as a hard failure rather than fail-open.
   */
  looksLikeFail?: boolean;
}

const FAIL_OPEN: AdversarialReviewOutput = { passed: true, findings: [], failOpen: true };

/** Same-session JSON-parse retry. See semantic-review.ts for rationale. */
const adversarialReviewHopBody: HopBody<AdversarialReviewInput> = async (initialPrompt, ctx) => {
  const first = await ctx.send(initialPrompt);
  const isTruncated = looksLikeTruncatedJson(first.output);
  const parsed = tryParseLLMJson<Record<string, unknown>>(first.output);
  if (!isTruncated && parsed && validateAdversarialShape(parsed)) return first;

  const retryPrompt = isTruncated
    ? ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: ctx.input.blockingThreshold })
    : ReviewPromptBuilder.jsonRetry();
  if (isTruncated) {
    getSafeLogger()?.warn("adversarial", "JSON parse retry — original response truncated", {
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

export const adversarialReviewOp: RunOperation<AdversarialReviewInput, AdversarialReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "adversarial-review",
  stage: "review",
  session: { role: "reviewer-adversarial", lifetime: "fresh" },
  config: reviewConfigSelector,
  // Issue #725 — per-call tier from user-configured AdversarialReviewConfig.model.
  model: (input) => input.adversarialConfig.model,
  timeoutMs: (input) => input.adversarialConfig.timeoutMs,
  hopBody: adversarialReviewHopBody,
  build(input, _ctx) {
    const base = new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(
      input.story,
      input.adversarialConfig,
      {
        mode: input.mode,
        diff: input.diff,
        storyGitRef: input.storyGitRef,
        stat: input.stat,
        testInventory: input.testInventory,
        excludePatterns: input.excludePatterns,
        testGlobs: input.testGlobs,
        refExcludePatterns: input.refExcludePatterns,
        priorAdversarialIterations: input.priorAdversarialIterations,
      },
    );
    const content = input.featureCtxBlock ? `${input.featureCtxBlock}${base}` : base;
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    const parsed = validateAdversarialShape(raw);
    if (parsed) return { passed: parsed.passed, findings: parsed.findings };
    if (/"passed"\s*:\s*false/.test(output)) return { passed: false, findings: [], looksLikeFail: true };
    return FAIL_OPEN;
  },
};
