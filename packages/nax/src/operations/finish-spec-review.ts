/**
 * A4: branch-level spec review (spec §4.2). Read-only; JSON reply; one parse
 * retry, then a missing verdict (`MISSING_REVIEW`) — never a throw, never a pass.
 */
import { makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { finishConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import { MISSING_REVIEW, parseFinishReviewReply } from "@/finish/review-json";
import type { FinishReviewOutput } from "@/finish/types";
import {
  buildFinishReviewJsonRetry,
  buildFinishReviewJsonRetryCondensed,
  buildFinishSpecReviewPrompt,
} from "@/prompts";
import type { RunOperation } from "./types";

export interface FinishSpecReviewInput {
  base: string;
  specPath: string;
  prdPath: string;
  changedFiles: string[];
  decisions?: string;
  model?: ConfiguredModel;
  timeoutMs?: number;
}

export const finishSpecReviewOp: RunOperation<FinishSpecReviewInput, FinishReviewOutput, FinishConfig> = {
  kind: "run",
  name: "finish-spec-review",
  stage: "review",
  config: finishConfigSelector,
  session: { role: "finish-review-spec", lifetime: "fresh" },
  // Read-only, plus Git: the prompt tells the reviewer to read `git diff base...HEAD`,
  // and DEFAULT_CODING_TOOLS has no Git (same list as adversarial-review.ts).
  tools: ["Read", "Glob", "Grep", "Git"],
  model: (input) => input.model,
  timeoutMs: (input, ctx) => input.timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input) {
    const content = buildFinishSpecReviewPrompt(input);
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output) {
    return parseFinishReviewReply(output, "spec") ?? MISSING_REVIEW;
  },
  retry: makeParseRetryStrategy({
    parse: (output) => parseFinishReviewReply(output, "spec"),
    validate: (parsed) => parsed !== null,
    reviewerKind: "finish-spec-review",
    maxAttempts: 2,
    prompts: { invalid: buildFinishReviewJsonRetry, truncated: buildFinishReviewJsonRetryCondensed },
    exhaustedFallback: () => MISSING_REVIEW,
  }),
};
