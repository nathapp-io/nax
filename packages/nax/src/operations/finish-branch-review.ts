/**
 * A4: branch-level quality review (spec §4.3). Read-only; JSON reply; one parse
 * retry, then a missing verdict (`MISSING_REVIEW`) — never a throw, never a pass.
 */
import { makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { finishConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import type { A3Hint } from "@/finish/a3-hints";
import { MISSING_REVIEW, parseFinishReviewReply } from "@/finish/review-json";
import type { FinishReviewOutput } from "@/finish/types";
import {
  buildFinishBranchReviewPrompt,
  buildFinishReviewJsonRetry,
  buildFinishReviewJsonRetryCondensed,
  reviewerCommandsSection,
} from "@/prompts";
import type { RunOperation } from "./types";

export interface FinishBranchReviewInput {
  base: string;
  stories: { id: string; title: string }[];
  changedFiles: string[];
  hints: A3Hint[];
  decisions?: string;
  model?: ConfiguredModel;
  timeoutMs?: number;
}

export const finishBranchReviewOp: RunOperation<FinishBranchReviewInput, FinishReviewOutput, FinishConfig> = {
  kind: "run",
  name: "finish-branch-review",
  stage: "review",
  config: finishConfigSelector,
  session: { role: "finish-review-quality", lifetime: "fresh" },
  // Read-only, plus Git: the prompt tells the reviewer to read `git diff base...HEAD`,
  // and DEFAULT_CODING_TOOLS has no Git (same list as adversarial-review.ts).
  tools: ["Read", "Glob", "Grep", "Git", "Bash"],
  model: (input) => input.model,
  timeoutMs: (input, ctx) => input.timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input) {
    const content = buildFinishBranchReviewPrompt(input);
    return {
      instructions: reviewerCommandsSection(),
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output) {
    return parseFinishReviewReply(output, "quality") ?? MISSING_REVIEW;
  },
  retry: makeParseRetryStrategy({
    parse: (output) => parseFinishReviewReply(output, "quality"),
    validate: (parsed) => parsed !== null,
    reviewerKind: "finish-branch-review",
    maxAttempts: 2,
    prompts: { invalid: buildFinishReviewJsonRetry, truncated: buildFinishReviewJsonRetryCondensed },
    exhaustedFallback: () => MISSING_REVIEW,
  }),
};
