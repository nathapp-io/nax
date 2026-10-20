import { makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import {
  buildBotTriageRetry,
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  reviewerCommandsSection,
} from "@/prompts";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";
import { missingTriage, parsePrReviewReply } from "./bot-pr-review-reply";
import type { PrReviewVerdict } from "./bot-types";
import type { RunOperation } from "./types";
import { REVIEWER_VERIFY_TOOLS } from "./workflow-story-review";

export interface BotPrReviewInput {
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly threadIds: readonly string[];
  readonly commentIds: readonly string[];
  readonly model?: ConfiguredModel;
}

type BotReviewOperation = RunOperation<BotPrReviewInput, PrReviewVerdict | null, WorkflowOpConfig>;

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
  parse: (output, input) => parsePrReviewReply(output, input.threadIds, input.commentIds),
  retry: (input) => {
    const parse = (output: string) => parsePrReviewReply(output, input.threadIds, input.commentIds);
    return makeParseRetryStrategy({
      parse,
      // Ruled exception (nax#2532): completeness asks again, but never discards a usable partial verdict.
      validate: (parsed) =>
        parsed != null && missingTriage(parsed as PrReviewVerdict, input.threadIds, input.commentIds).length === 0,
      maxAttempts: 2,
      reviewerKind: "bot-pr-review",
      prompts: {
        invalid: (output) => {
          const verdict = parse(output);
          const missing = verdict ? missingTriage(verdict, input.threadIds, input.commentIds) : [];
          return missing.length > 0 ? buildBotTriageRetry(missing) : buildWorkflowReviewJsonRetry();
        },
        truncated: buildWorkflowReviewJsonRetryCondensed,
      },
      exhaustedFallback: parse,
    });
  },
};

/** Static review deliberately omits both command tools and command-running instructions. */
export const botPrStaticReviewOp: BotReviewOperation = {
  ...botPrReviewOp,
  name: "bot-pr-static-review",
  tools: ["Read", "Glob", "Grep"],
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: input.prompt, overridable: false },
  }),
};
