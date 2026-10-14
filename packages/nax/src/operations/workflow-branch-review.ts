/** A5 workflow mode: the one whole-branch review (spec §7 step 2). Fresh, read tools plus sandboxed Bash; one parse retry, then null. */
import { makeParseRetryStrategy } from "@/agents/retry";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import {
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  reviewerCommandsSection,
} from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { RunOperation } from "./types";
import { parseBranchReviewReply } from "./workflow-replies";
import { WORKFLOW_REVIEW_TOOLS, type WorkflowReviewInput } from "./workflow-story-review";
import type { BranchReviewVerdict } from "./workflow-types";

export interface WorkflowBranchReviewInput extends WorkflowReviewInput {
  /** The deferred minors the reviewer must triage, in prompt order. */
  readonly minorIds: readonly string[];
}

export const workflowBranchReviewOp: RunOperation<
  WorkflowBranchReviewInput,
  BranchReviewVerdict | null,
  WorkflowOpConfig
> = {
  kind: "run",
  name: "workflow-branch-review",
  stage: "review",
  session: { role: "wf-branch-review", lifetime: "fresh" },
  config: workflowConfigSelector,
  tools: [...WORKFLOW_REVIEW_TOOLS],
  model: (input, ctx) =>
    input.model ?? ctx.config.workflow?.models?.branchReview ?? ctx.config.finish?.reviewers?.quality ?? undefined,
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build(input) {
    return {
      instructions: reviewerCommandsSection(),
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  parse: (output, input) => parseBranchReviewReply(output, input.minorIds),
  retry: (input) =>
    makeParseRetryStrategy({
      parse: (output) => parseBranchReviewReply(output, input.minorIds),
      validate: (parsed) => parsed !== null,
      reviewerKind: "workflow-branch-review",
      maxAttempts: 2,
      prompts: { invalid: buildWorkflowReviewJsonRetry, truncated: buildWorkflowReviewJsonRetryCondensed },
      exhaustedFallback: () => null,
    }),
};
