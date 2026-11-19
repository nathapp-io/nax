/**
 * US-001: the shared finding-trigger vocabulary — what a review finding needs in order to occur.
 *
 * A nested barrel (`@/workflow/blocking-findings`), not an export of the `@/workflow` barrel: that
 * barrel imports `@/operations` and `@/config`, so routing through it would close an import cycle
 * from `operations/bot-pr-review-reply.ts` and `config/schemas-bot.ts`.
 *
 * This module has no runtime imports at all, so nothing here can join a cycle.
 */
export const FINDING_TRIGGERS = ["normal", "own-concurrency", "adversarial", "manual"] as const;

export type FindingTrigger = (typeof FINDING_TRIGGERS)[number];

/** Missing or unknown reads as "normal", so an unclassified finding still blocks. */
export function parseFindingTrigger(value: unknown): FindingTrigger {
  return FINDING_TRIGGERS.find((trigger) => trigger === value) ?? "normal";
}
