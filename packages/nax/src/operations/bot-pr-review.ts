import { makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
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

function reviewRetry(input: BotPrReviewInput, staticMode = false) {
  const coverage = coverageContext(input);
  const parse = (output: string) => parsePrReviewReply(output, input.threadIds, input.commentIds, input);
  const missingFiles = (verdict: PrReviewVerdict) =>
    coverage ? unreadFiles(input.requiredFiles ?? [], verdict.inspectedFiles, coverage.repoRoot) : [];
  return makeParseRetryStrategy({
    parse,
    // Ruled exception (nax#2532): triage and file coverage ask again, but never discard a usable partial verdict.
    validate: (parsed) =>
      parsed != null &&
      missingTriage(parsed as PrReviewVerdict, input.threadIds, input.commentIds, input.earlierIds).length === 0 &&
      missingFiles(parsed as PrReviewVerdict).length === 0,
    maxAttempts: 2,
    reviewerKind: "bot-pr-review",
    prompts: {
      invalid: (output) => {
        const verdict = parse(output);
        const missing = verdict ? missingTriage(verdict, input.threadIds, input.commentIds) : [];
        const earlierMissing = verdict ? missingTriage(verdict, [], [], input.earlierIds) : [];
        if (missing.length > 0 || earlierMissing.length > 0) return buildBotTriageRetry(missing, earlierMissing);
        const files = verdict ? missingFiles(verdict) : [];
        return files.length > 0
          ? buildWorkflowBranchCoverageRetry(coverage?.range ?? "", files, staticMode)
          : buildWorkflowReviewJsonRetry();
      },
      truncated: buildWorkflowReviewJsonRetryCondensed,
    },
    exhaustedFallback: parse,
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
  build: (input) => ({
    instructions: reviewerCommandsSection(),
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
