/**
 * The PR's effective blocking policy for one review (US-003): the set that decides which new findings get an
 * inline thread and which agreed findings will hold readiness, where that set came from, and the writer scope
 * rulings the review ignored.
 *
 * `review-run.ts` keeps only the call: the policy is read once, from the comments triage already fetched and
 * the writer set it already resolved, so a review never asks the forge a permission question twice.
 */
import type { PrComment } from "@/forge";
import { configuredBlockingTriggers, effectiveBlockingTriggers } from "@/workflow/blocking-findings";
import type { PostReviewInput } from "./post";

/** Only `bot.blockingTriggers` is read; taking the shared reader's own parameter keeps the two in step. */
export type BlockingPolicyConfig = Parameters<typeof configuredBlockingTriggers>[0];

export interface ReviewConvergenceInput {
  readonly comments: readonly PrComment[];
  readonly writers: ReadonlySet<string>;
  readonly config: BlockingPolicyConfig;
}

export type ReviewConvergence = Required<
  Pick<PostReviewInput, "blockingTriggers" | "blockingSource" | "ignoredScopeRulings">
>;

export function reviewConvergence(input: ReviewConvergenceInput): ReviewConvergence {
  const effective = effectiveBlockingTriggers({
    comments: input.comments,
    writers: input.writers,
    configured: configuredBlockingTriggers(input.config),
  });
  return {
    blockingTriggers: effective.triggers,
    blockingSource: effective.source,
    ignoredScopeRulings: effective.invalid,
  };
}
