/**
 * Whether a posted bot review may advance the workflow index's reviewed head (spec bot-reviewed-head US-002).
 *
 * The advance is what narrows the next review, so it is only safe once this review left the PR in a state
 * the next one can build on: every write landed, nothing was left unread, the PR carries an index this
 * review read, and the review actually read code. Two records hold it back beyond that (B1, B2): the
 * coverage record, because the next default review of an advanced head is conversation-only and could
 * never replace a stale one, and the carried-findings record, because the next review would skip the only
 * changes that could re-raise a finding this one could not re-report.
 *
 * The outcome is logged and never returned: a held or failed advance must not change what the review
 * reports, and the next review then falls back to the wider range.
 */

import type { ForgeDeps, PrRef } from "@/forge";
import { getLogger } from "@/logger";
import type { ItemIndex } from "../workflow/item-threads";
import type { PostReviewOutcome } from "./post";
import type { BotReviewScope } from "./review-rulings";
import type { advanceReviewedHead } from "./reviewed-head";

export interface AdvanceAfterReviewInput {
  readonly posted: PostReviewOutcome | undefined;
  readonly unreadFiles?: readonly string[] | undefined;
  /** The index this review read at preparation; absent means there is nothing to advance. */
  readonly reviewedIndex?: ItemIndex | undefined;
  readonly scope: BotReviewScope | undefined;
  readonly ref: PrRef;
  readonly login: string;
  /** The head the review covered. */
  readonly head: string;
  /** The merge base it diffed against: exactly what the next review's ancestry check compares. */
  readonly mergeBase: string;
  readonly deps: ForgeDeps;
  readonly cwd: string;
  readonly advance: typeof advanceReviewedHead;
}

/** The record that did not land, or undefined when the review is complete enough to advance. */
function heldBy(posted: PostReviewOutcome): string | undefined {
  if (posted.coverageRecordFailed === true) return "coverage record";
  if (posted.carriedRecordFailed === true) return "carried findings record";
  return undefined;
}

function mayAdvance(input: AdvanceAfterReviewInput): input is AdvanceAfterReviewInput & {
  readonly posted: PostReviewOutcome;
} {
  if (input.posted === undefined || input.posted.failed > 0) return false;
  if ((input.unreadFiles?.length ?? 0) > 0) return false;
  if (input.reviewedIndex === undefined) return false;
  return input.scope !== "conversation-only";
}

export async function advanceAfterReview(input: AdvanceAfterReviewInput): Promise<void> {
  if (!mayAdvance(input)) return;
  const held = heldBy(input.posted);
  if (held !== undefined) {
    getLogger().warn("bot", `Reviewed head held: ${held} did not land`, { pr: input.ref.number });
    return;
  }
  const outcome = await input.advance({
    ref: input.ref,
    login: input.login,
    expectedHead: input.reviewedIndex?.reviewedHead,
    head: input.head,
    base: input.mergeBase,
    deps: input.deps,
    cwd: input.cwd,
  });
  getLogger().info("bot", "Reviewed head advance", { pr: input.ref.number, outcome: outcome.kind });
}
