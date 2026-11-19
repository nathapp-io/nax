/**
 * The blocking set a fix or readiness pass applies (US-003).
 *
 * A conversation-only review read no code, so its artifact carries no findings; the open ones live in an
 * earlier code review, written before the PR's newest scope ruling. The newer review's set therefore wins,
 * and only a review that states none falls back to `bot.blockingTriggers`.
 */
import { configuredBlockingTriggers, type FindingTrigger } from "@/workflow/blocking-findings";
import type { BotFixEnv } from "./fix-steps";

export function reviewBlockingTriggers(env: BotFixEnv): readonly FindingTrigger[] {
  return env.review.blockingTriggers ?? env.codeReview?.blockingTriggers ?? configuredBlockingTriggers(env.config);
}
