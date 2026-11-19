/**
 * The blocking set a fix or readiness pass applies (US-003), and whether agreed work is worth a fix
 * session at all (US-007).
 *
 * A conversation-only review read no code, so its artifact carries no findings; the open ones live in an
 * earlier code review, written before the PR's newest scope ruling. The newer review's set therefore wins,
 * and only a review that states none falls back to `bot.blockingTriggers`.
 */
import { configuredBlockingTriggers, type FindingTrigger, isBlockingFinding } from "@/workflow/blocking-findings";
import type { BotFixEnv } from "./fix-steps";

export function reviewBlockingTriggers(env: BotFixEnv): readonly FindingTrigger[] {
  return env.review.blockingTriggers ?? env.codeReview?.blockingTriggers ?? configuredBlockingTriggers(env.config);
}

/**
 * US-007: whether any agreed item justifies a fix session. A thread or comment must be answered whatever
 * it says; a finding is worth a push only when it can hold readiness, so a non-blocking one is a follow-up
 * the summary names instead (#2979: a minor posted only in the summary reversed a human's decision).
 */
export function hasPushWorthyItem(env: BotFixEnv): boolean {
  const blocking = reviewBlockingTriggers(env);
  return env.review.agreed.some((item) => item.kind !== "finding" || isBlockingFinding(item, blocking));
}
