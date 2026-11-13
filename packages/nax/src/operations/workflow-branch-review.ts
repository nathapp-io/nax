/** A5 workflow mode: the one whole-branch review (spec §7 step 2). Fresh, read tools plus sandboxed Bash; one shape retry plus an independent coverage budget. */
import { basename } from "node:path";
import { makeCoverageRetryStrategy, makeParseRetryStrategy } from "@/agents/retry";
import { WORKFLOW_REVIEW_DEFAULTS, workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import {
  buildWorkflowBranchCoverageRetry,
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  reviewerCommandsSection,
} from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import type { DiffPart } from "@/workflow/branch-diff-parts";
import type { RunOperation } from "./types";
import { parseBranchReviewReply } from "./workflow-replies";
import { unreadFiles } from "./workflow-review-coverage";
import { WORKFLOW_REVIEW_TOOLS, type WorkflowReviewInput } from "./workflow-story-review";
import type { BranchReviewVerdict } from "./workflow-types";

export interface WorkflowBranchReviewInput extends WorkflowReviewInput {
  readonly repoRoot: string;
  /** The deferred minors the reviewer must triage, in prompt order. */
  readonly minorIds: readonly string[];
  /** The changed files the reviewer must inspect (US-002): the package minus tests and non-source files. */
  readonly requiredFiles: readonly string[];
  readonly diffParts?: readonly DiffPart[];
  /** `<seed>..HEAD`: the range the branch fix and this package's reading note are phrased in. */
  readonly range: string;
  /**
   * US-002: coverage re-prompts this call may send. Absent reads as
   * `WORKFLOW_REVIEW_DEFAULTS.coverageRetries` (`workflow.review.coverageRetries`).
   */
  readonly coverageRetries?: number;
}

/**
 * `CoverageRetryOpts.missing` receives whatever the op's parser returned, typed `unknown`. The branch
 * op's parser only ever yields a verdict or null, so a non-null object is a verdict.
 */
function isVerdict(parsed: unknown): parsed is BranchReviewVerdict {
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

function partNamesByFile(parts: readonly DiffPart[]): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const part of parts) {
    for (const file of part.files) {
      const names = result.get(file) ?? [];
      names.push(basename(part.path));
      result.set(file, names);
    }
  }
  return result;
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
    const parse = (output: string) => parseBranchReviewReply(output, input.minorIds);
    const partsOf = input.diffParts?.length ? partNamesByFile(input.diffParts) : undefined;
    /**
     * The report returned a parseable verdict that does not cover every changed file: the required
     * files its `inspectedFiles` leaves out. A reply that did not parse has no coverage to speak of,
     * and `op.parse` already rejected it, so it contributes nothing.
     */
    const missing = (parsed: unknown): readonly string[] =>
      isVerdict(parsed) ? unreadFiles(input.requiredFiles, parsed.inspectedFiles ?? [], input.repoRoot) : [];
    /**
     * The JSON-shape retry, and nothing else. Deliberate, ruled exception (nax#2532,
     * .nax/rules/retry-strategy.md): coverage is not part of `op.parse` — which stays the lenient
     * shape check — and, since nax#2858, not part of this `validate` either. Coverage has its own
     * budget below, so a reviewer that answered "I did not read them" gets asked again instead of
     * spending the one shape retry.
     */
    const shapeRetry = makeParseRetryStrategy({
      parse,
      validate: (parsed) => parsed !== null,
      reviewerKind: "workflow-branch-review",
      maxAttempts: 2,
      prompts: { invalid: buildWorkflowReviewJsonRetry, truncated: buildWorkflowReviewJsonRetryCondensed },
      // The strategy-level mirror of `op.parse`: whatever the last reply was, the verdict callOp
      // reads is the one parsed from it — a parseable but incomplete verdict is kept, not dropped.
      exhaustedFallback: parse,
    });
    /**
     * Coverage, on its own budget (US-002, nax#2858). It decides only whether to ask again: an
     * incomplete verdict is kept through `exhaustedFallback`, findings included.
     */
    return makeCoverageRetryStrategy({
      inner: shapeRetry,
      parse,
      missing,
      maxCoverageRetries: input.coverageRetries ?? WORKFLOW_REVIEW_DEFAULTS.coverageRetries,
      prompt: (files, progress) => buildWorkflowBranchCoverageRetry(input.range, files, false, progress, partsOf),
      exhaustedFallback: parse,
      reviewerKind: "workflow-branch-review",
    });
  },
};
