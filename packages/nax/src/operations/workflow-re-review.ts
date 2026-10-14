/** A5 workflow mode: fresh re-review scoped to one fix diff (spec §6 step 5). One parse retry, then null. */
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
import { parseReReviewReply } from "./workflow-replies";
import { WORKFLOW_REVIEW_TOOLS, type WorkflowReviewInput } from "./workflow-story-review";
import type { ReReviewVerdict } from "./workflow-types";

export interface WorkflowReReviewInput extends WorkflowReviewInput {
  readonly openIds: readonly string[];
}

export const workflowReReviewOp: RunOperation<WorkflowReReviewInput, ReReviewVerdict | null, WorkflowOpConfig> = {
  kind: "run",
  name: "workflow-re-review",
  stage: "review",
  session: { role: "wf-rereview", lifetime: "fresh" },
  config: workflowConfigSelector,
  tools: [...WORKFLOW_REVIEW_TOOLS],
  model: (input, ctx) => input.model ?? ctx.config.workflow?.models?.storyReview ?? ctx.config.review?.semantic?.model,
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build(input) {
    return {
      instructions: reviewerCommandsSection(),
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.prompt, overridable: false },
    };
  },
  parse: (output, input) => parseReReviewReply(output, input.openIds),
  retry: (input) =>
    makeParseRetryStrategy({
      parse: (output) => parseReReviewReply(output, input.openIds),
      validate: (parsed) => parsed !== null,
      reviewerKind: "workflow-re-review",
      maxAttempts: 2,
      prompts: { invalid: buildWorkflowReviewJsonRetry, truncated: buildWorkflowReviewJsonRetryCondensed },
      exhaustedFallback: () => null,
    }),
};
