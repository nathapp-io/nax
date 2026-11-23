/**
 * The range one bot review runs over, and the findings an earlier review of the reviewed head left open.
 *
 * `reviewRange` narrows a review to `<reviewedHead>..HEAD`; that is only safe because a carry record holds
 * what the skipped part reported. So the two decisions are made together here (B3): when a record exists
 * for the reviewed head but none of it is usable, the review widens back to the merge base and re-reads the
 * very changes the record would have spoken for. A widened review carries nothing — it is its own newer
 * word on those findings.
 *
 * A head that no bot review ever recorded — the one the workflow publish wrote — carries nothing and does
 * not widen: there is no missing record for it, and widening every first review after a publish would give
 * back the range this feature narrows.
 */

import type { OwnComment, PrRef } from "@/forge";
import { getLogger } from "@/logger";
import type { ItemIndex } from "../workflow/item-threads";
import { type CarriedFinding, earlierCarriedFindings, type LoadCarry } from "./carried-findings";
import type { PrCheckout } from "./checkout";
import type { PatchEquivalent } from "./review-rebase";
import { type BotReviewScope, type ReviewRange, reviewRange, reviewScopeOf } from "./review-rulings";

export interface ReviewCarryInput {
  readonly outputDir: string;
  readonly ref: PrRef;
  /** The bot's own comments on the PR, where the durable carry record lives. */
  readonly own: readonly OwnComment[];
  readonly index?: ItemIndex | undefined;
  /** `input.full`: review everything since the merge base, whatever the index says. */
  readonly full: boolean;
  readonly checkout: PrCheckout;
  readonly head: string;
  readonly load: LoadCarry;
  readonly isAncestor: (dir: string, ancestor: string, head: string) => Promise<boolean>;
  /** US-003: absent never recognises a rebase, which is what a caller without git access wants. */
  readonly patchEquivalent?: PatchEquivalent;
}

export interface ReviewCarry {
  readonly range: ReviewRange;
  readonly scope: BotReviewScope;
  readonly carried: readonly CarriedFinding[];
}

function scopeOf(range: ReviewRange, mergeBase: string): BotReviewScope {
  return reviewScopeOf({ ...range, mergeBase });
}

export async function reviewCarry(input: ReviewCarryInput): Promise<ReviewCarry> {
  const full: ReviewRange = { rangeBase: input.checkout.mergeBase };
  const range = input.full
    ? full
    : await reviewRange(
        { index: input.index, checkout: input.checkout, head: input.head },
        input.isAncestor,
        input.patchEquivalent,
      );
  const scope = scopeOf(range, input.checkout.mergeBase);
  const carry = await earlierCarriedFindings({
    outputDir: input.outputDir,
    ref: input.ref,
    index: input.index,
    scope,
    rangeBase: range.rangeBase,
    own: input.own,
    load: input.load,
    ...(range.rebasedFrom === undefined ? {} : { rebasedFrom: range.rebasedFrom }),
  });
  if (!carry.widen) return { range, scope, carried: carry.findings };
  getLogger().warn("bot", "Carried findings incomplete or unreadable; reviewing the full range", {
    pr: input.ref.number,
  });
  return { range: full, scope: scopeOf(full, input.checkout.mergeBase), carried: [] };
}
