import { makeCoverageRetryStrategy, makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { WORKFLOW_REVIEW_DEFAULTS, workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { NaxError } from "@/errors";
import {
  buildBotTriageRetry,
  buildWorkflowBranchCoverageRetry,
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  reviewerCommandsSection,
} from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import { missingTriage, parsePrReviewReply } from "./bot-pr-review-reply";
import type { PrReviewVerdict } from "./bot-types";
import { reviewerCommandLines } from "./reviewer-command-lines";
import type { RunOperation } from "./types";
import { unreadFiles } from "./workflow-review-coverage";
import { REVIEWER_VERIFY_TOOLS } from "./workflow-story-review";

export interface BotPrReviewInput {
  readonly requiredFiles?: readonly string[];
  readonly repoRoot?: string;
  readonly range?: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly threadIds: readonly string[];
  readonly commentIds: readonly string[];
  readonly earlierIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  /**
   * US-003: coverage re-prompts this call may send. Absent reads as
   * `WORKFLOW_REVIEW_DEFAULTS.coverageRetries` (`workflow.review.coverageRetries`).
   */
  readonly coverageRetries?: number;
  readonly model?: ConfiguredModel;
}

type BotReviewOperation = RunOperation<BotPrReviewInput, PrReviewVerdict | null, WorkflowOpConfig>;

function coverageContext(input: BotPrReviewInput): { repoRoot: string; range: string } | undefined {
  if (!input.requiredFiles?.length) return;
  if (!input.repoRoot || !input.range)
    throw new NaxError("[bot-review] Coverage requires repoRoot and range", "BOT_REVIEW_COVERAGE_INVALID", {
      stage: "review",
    });
  return { repoRoot: input.repoRoot, range: input.range };
}

/** `CoverageRetryOpts.missing` receives whatever the op's parser returned, typed `unknown`. */
function isVerdict(parsed: unknown): parsed is PrReviewVerdict {
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

/**
 * The bot review's retry, in two layers (US-003, nax#2858).
 *
 * The inner strategy is the triage retry: every listed thread and comment id must be answered.
 * The outer one owns file coverage, on its own budget, so a reviewer that approved without reading
 * the changed files is asked again instead of spending the triage retry. Triage always comes first,
 * coverage never retries past an exhausted triage budget, and an incomplete verdict — triage or
 * coverage — is kept through `exhaustedFallback`, findings included (nax#2532).
 */
function reviewRetry(input: BotPrReviewInput, staticMode = false) {
  const coverage = coverageContext(input);
  const parse = (output: string) => parsePrReviewReply(output, input.threadIds, input.commentIds, input);
  const missingFiles = (parsed: unknown): readonly string[] =>
    coverage && isVerdict(parsed)
      ? unreadFiles(input.requiredFiles ?? [], parsed.inspectedFiles, coverage.repoRoot)
      : [];
  const triageRetry = makeParseRetryStrategy({
    parse,
    validate: (parsed) =>
      parsed != null &&
      missingTriage(parsed as PrReviewVerdict, input.threadIds, input.commentIds, input.earlierIds).length === 0,
    maxAttempts: 2,
    reviewerKind: "bot-pr-review",
    prompts: {
      invalid: (output) => {
        const verdict = parse(output);
        const missing = verdict ? missingTriage(verdict, input.threadIds, input.commentIds) : [];
        const earlierMissing = verdict ? missingTriage(verdict, [], [], input.earlierIds) : [];
        return missing.length > 0 || earlierMissing.length > 0
          ? buildBotTriageRetry(missing, earlierMissing)
          : buildWorkflowReviewJsonRetry();
      },
      truncated: buildWorkflowReviewJsonRetryCondensed,
    },
    exhaustedFallback: parse,
  });
  return makeCoverageRetryStrategy({
    inner: triageRetry,
    parse,
    missing: missingFiles,
    maxCoverageRetries: input.coverageRetries ?? WORKFLOW_REVIEW_DEFAULTS.coverageRetries,
    prompt: (files, progress) => buildWorkflowBranchCoverageRetry(coverage?.range ?? "", files, staticMode, progress),
    exhaustedFallback: parse,
    reviewerKind: "bot-pr-review",
  });
}

export const botPrReviewOp: BotReviewOperation = {
  kind: "run",
  name: "bot-pr-review",
  stage: "review",
  session: { role: "wf-branch-review", lifetime: "fresh" },
  config: workflowConfigSelector,
  tools: [...REVIEWER_VERIFY_TOOLS],
  model: (input) => input.model,
  timeoutMs: (input) => input.timeoutMs + STEP_TIMEOUT_MARGIN_MS,
  build: (input, ctx) => ({
    instructions: reviewerCommandsSection(reviewerCommandLines(ctx.config, ctx.packageView)),
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: input.prompt, overridable: false },
  }),
  parse: (output, input) => parsePrReviewReply(output, input.threadIds, input.commentIds, input),
  retry: (input) => reviewRetry(input),
};

/** Static review deliberately omits both command tools and command-running instructions. */
export const botPrStaticReviewOp: BotReviewOperation = {
  ...botPrReviewOp,
  name: "bot-pr-static-review",
  retry: (input) => reviewRetry(input, true),
  tools: ["Read", "Glob", "Grep"],
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: input.prompt, overridable: false },
  }),
};
