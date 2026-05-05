import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Iteration } from "../findings";
import { ReviewPromptBuilder } from "../prompts";
import { validateLLMShape } from "../review/semantic-helpers";
import type { SemanticReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import { makeReviewRetryHopBody } from "./_review-retry";
import type { RunOperation } from "./types";

export type { SemanticReviewConfig, SemanticStory };

export interface SemanticReviewInput {
  story: SemanticStory;
  semanticConfig: SemanticReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  priorSemanticIterations?: Iteration[];
  excludePatterns?: string[];
  /** Pre-built, role-filtered context prefix to prepend to the review prompt. */
  featureCtxBlock?: string;
  /** Severity threshold from review config — drives the JSON-retry condensation prompt. */
  blockingThreshold?: "error" | "warning" | "info";
}

export interface SemanticReviewOutput {
  passed: boolean;
  findings: unknown[];
  failOpen?: boolean;
  /**
   * True when the raw output could not be parsed but contained `"passed": false` —
   * the agent clearly intended a failure but the response was truncated/malformed.
   * Callers should treat this as a hard failure rather than fail-open.
   */
  looksLikeFail?: boolean;
}

const FAIL_OPEN: SemanticReviewOutput = { passed: true, findings: [], failOpen: true };

const semanticReviewHopBody = makeReviewRetryHopBody<SemanticReviewInput>(
  (parsed) => validateLLMShape(parsed) !== null,
  "semantic",
);

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
      priorSemanticIterations: input.priorSemanticIterations,
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
    const parsed = validateLLMShape(raw);
    if (parsed) return { passed: parsed.passed, findings: parsed.findings };
    if (/"passed"\s*:\s*false/.test(output)) return { passed: false, findings: [], looksLikeFail: true };
    return FAIL_OPEN;
  },
};
