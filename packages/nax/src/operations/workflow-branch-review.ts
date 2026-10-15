/** A5 workflow mode: the one whole-branch review (spec §7 step 2). Fresh, read tools plus sandboxed Bash; one parse retry, then null. */
import { makeParseRetryStrategy } from "@/agents/retry";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import {
  buildWorkflowBranchCoverageRetry,
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  reviewerCommandsSection,
} from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { RunOperation } from "./types";
import { parseBranchReviewReply } from "./workflow-replies";
import { isCompleteBranchVerdict, unreadFiles } from "./workflow-review-coverage";
import { WORKFLOW_REVIEW_TOOLS, type WorkflowReviewInput } from "./workflow-story-review";
import type { BranchReviewVerdict } from "./workflow-types";

export interface WorkflowBranchReviewInput extends WorkflowReviewInput {
  /** The deferred minors the reviewer must triage, in prompt order. */
  readonly minorIds: readonly string[];
  /** The changed files the reviewer must inspect (US-002): the package minus tests and non-source files. */
  readonly requiredFiles: readonly string[];
  /** `<seed>..HEAD`: the range the branch fix and this package's reading note are phrased in. */
  readonly range: string;
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
  retry: (input) => {
    /**
     * The reply to re-prompt with once the strategy decided to retry. A reply the op's own parser
     * accepted but that misses changed files gets the coverage prompt, naming each one; anything
     * else — an unparseable reply, or a complete verdict that failed some other way — keeps the
     * plain JSON retry (US-003, nax#2532).
     */
    const invalid = (lastOutput: string): string => {
      const verdict = parseBranchReviewReply(lastOutput, input.minorIds);
      const missing = verdict ? unreadFiles(input.requiredFiles, verdict.inspectedFiles) : [];
      return missing.length > 0
        ? buildWorkflowBranchCoverageRetry(input.range, missing)
        : buildWorkflowReviewJsonRetry();
    };
    return makeParseRetryStrategy({
      parse: (output) => parseBranchReviewReply(output, input.minorIds),
      // Deliberate, ruled exception (nax#2532, .nax/rules/retry-strategy.md): coverage is part of
      // the retry's validation but NOT of `op.parse`, which stays the lenient shape check. Coverage
      // decides only whether to ask again; an incomplete verdict is kept, findings included.
      validate: (parsed) =>
        parsed !== null && isCompleteBranchVerdict(parsed as BranchReviewVerdict, input.requiredFiles),
      reviewerKind: "workflow-branch-review",
      maxAttempts: 2,
      prompts: { invalid, truncated: buildWorkflowReviewJsonRetryCondensed },
      // The strategy-level mirror of `op.parse`: whatever the last reply was, the verdict callOp
      // reads is the one parsed from it — a parseable but incomplete verdict is kept, not dropped.
      exhaustedFallback: (lastOutput) => parseBranchReviewReply(lastOutput, input.minorIds),
    });
  },
};
