/** A5 workflow mode: fresh, read-only story review (spec §6 step 4). One parse retry, then null (review-skipped). */
import { makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import {
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  reviewerCommandsSection,
} from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { RunOperation } from "./types";
import { parseStoryReviewReply } from "./workflow-replies";
import type { StoryReviewVerdict } from "./workflow-types";

export interface WorkflowReviewInput {
  readonly prompt: string;
  readonly model?: ConfiguredModel;
  readonly timeoutMs: number;
}

export const REVIEWER_VERIFY_TOOLS = ["Read", "Glob", "Grep", "Git", "Bash"] as const;
/** @deprecated alias kept for existing imports; same value as REVIEWER_VERIFY_TOOLS. */
export const WORKFLOW_REVIEW_TOOLS = REVIEWER_VERIFY_TOOLS;

export const workflowStoryReviewOp: RunOperation<WorkflowReviewInput, StoryReviewVerdict | null, WorkflowOpConfig> = {
  kind: "run",
  name: "workflow-story-review",
  stage: "review",
  session: { role: "wf-story-review", lifetime: "fresh" },
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
  parse: (output) => parseStoryReviewReply(output),
  retry: makeParseRetryStrategy({
    parse: (output) => parseStoryReviewReply(output),
    validate: (parsed) => parsed !== null,
    reviewerKind: "workflow-story-review",
    maxAttempts: 2,
    prompts: { invalid: buildWorkflowReviewJsonRetry, truncated: buildWorkflowReviewJsonRetryCondensed },
    exhaustedFallback: () => null,
  }),
};
