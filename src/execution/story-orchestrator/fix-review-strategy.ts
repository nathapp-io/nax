/**
 * US-005 — scoped fix review around the blocking cycle's `autofix-test-writer`
 * dispatch.
 *
 * A fix dispatch can silently contradict the story: the test-writer edits a test
 * until it passes, and the edit drops the very assertion the AC demanded. The
 * blocking cycle re-runs the seeded reviewers afterwards, but the seeded
 * reviewers re-read the whole story, so a contradiction between the fix's own
 * delta and an AC has no cheap, targeted check.
 *
 * This module supplies that check as a *wrapper* around a `FixStrategy`: it
 * records the findings handed to `buildInput`, snapshots the working tree in
 * `beforeDispatch` (before the fix edits anything), and after the dispatch runs
 * the scoped fix review over the delta. Only an AC-anchored contradiction — a
 * `contradiction` verdict carrying an `acIndex` — becomes a `Finding` for the
 * cycle to act on; every other non-pass warns and is dropped, per nax#1359
 * (scope violations and description-only contradictions are not defects).
 */

import type { Finding, FixStrategy } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import type { UserStory } from "@/prd";
import { runFixReview } from "@/review/fix-review/run";
import { snapshotWorkingTree } from "@/review/fix-review/tree-snapshot";
import type { FixReviewVerdict } from "@/review/fix-review/types";
import type { ReviewConfig } from "@/review/types";

/** The warning the wrapper emits for every non-pass it does not feed back. */
const NON_PASS_WARNING = "fix review non-pass not fed back";

/** A strategy wrapper that runs the scoped fix review after each dispatch. */
export interface FixReviewWrapper {
  /** Returns a copy of `strategy` that runs the scoped fix review after each dispatch. */
  wrap<F extends Finding, I, O, C>(strategy: FixStrategy<F, I, O, C>): FixStrategy<F, I, O, C>;
  /** Findings produced by fix reviews since the last call, then cleared. */
  drainFindings(): Finding[];
}

/** An AC-anchored contradiction: the only verdict that may block (nax#1359 ruling). */
export type AnchoredContradiction = Extract<FixReviewVerdict, { cause: "contradiction" }> & {
  readonly acIndex: number;
};

/**
 * Map an AC-anchored contradiction onto the cycle's finding wire format.
 *
 * The finding reuses `source: "semantic-review"` so it lands in the existing
 * semantic-review lane the autofix strategies read (see
 * `findingsToFailedChecks` in `src/operations/_finding-to-check.ts`); the
 * `category: "fix-review"` distinguishes it from a seeded semantic-review
 * finding at audit time.
 */
export function toFixReviewFinding(verdict: AnchoredContradiction): Finding {
  const finding: Finding = {
    source: "semantic-review",
    severity: "error",
    category: "fix-review",
    fixTarget: "test",
    message: verdict.reason,
    rule: `fix-review:AC-${verdict.acIndex}`,
  };
  if (verdict.file !== undefined) {
    return { ...finding, file: verdict.file };
  }
  return finding;
}

/** Build the wrapper that reviews each dispatch of the strategy it wraps. */
export function createFixReviewWrapper(args: {
  ctx: CallContext;
  story: UserStory;
  config: ReviewConfig;
}): FixReviewWrapper {
  const { ctx, story, config } = args;
  const logger = getSafeLogger();
  const queue: Finding[] = [];

  return {
    wrap<F extends Finding, I, O, C>(strategy: FixStrategy<F, I, O, C>): FixStrategy<F, I, O, C> {
      // Mutable per-dispatch state — populated by buildInput/beforeDispatch, consumed by extractApplied.
      let pendingFindings: F[] = [];
      let preFixTree: string | undefined;

      return {
        ...strategy,
        buildInput: (findings, priorIterations, cycleCtx) => {
          // Record the findings the strategy was handed so extractApplied can hand
          // them to the review. The dispatch's own coordinates are the truth here —
          // a dispatch fed one finding and reaching for a different list later
          // would be a silent mismatch with what the agent saw.
          pendingFindings = [...findings];
          return strategy.buildInput(findings, priorIterations, cycleCtx);
        },
        beforeDispatch: async (_cycleCtx) => {
          // Snapshot the working tree before the fix edits anything — the review
          // diffs the fix's delta against this tree. If the snapshot fails, log a
          // warning and skip the review for this dispatch: a review without a
          // pre-fix tree has no ground truth, so it would either no-op or lie.
          try {
            preFixTree = await snapshotWorkingTree(ctx.packageDir);
          } catch (err) {
            preFixTree = undefined;
            logger?.warn("fix-review", "snapshot failed — review skipped for this dispatch", {
              storyId: story.id,
              packageDir: ctx.packageDir,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        extractApplied: async (output, input) => {
          const extracted = await (strategy.extractApplied?.(output, input) ?? {});
          // Only run the review if the snapshot succeeded — without a pre-fix tree
          // the diff has no anchor, so the review is meaningless. The dispatch's
          // own `extractApplied` still runs so the cycle's accounting is unchanged.
          if (preFixTree === undefined) {
            return extracted;
          }
          try {
            const verdict = await runFixReview(ctx, {
              workdir: ctx.packageDir,
              story,
              preFixTree,
              findings: pendingFindings,
              config,
            });
            // Only an AC-anchored contradiction feeds back. Everything else warns
            // and is dropped, per nax#1359.
            if (verdict.kind === "fail" && verdict.cause === "contradiction" && verdict.acIndex !== undefined) {
              queue.push(toFixReviewFinding(verdict as AnchoredContradiction));
            } else if (verdict.kind !== "pass") {
              logger?.warn("fix-review", NON_PASS_WARNING, {
                storyId: story.id,
                kind: verdict.kind,
                cause: verdict.kind === "fail" ? verdict.cause : undefined,
                reason: verdict.reason,
              });
            }
          } catch (err) {
            // A throw from the review path is itself a non-pass — log and drop, the
            // dispatch's own outcome is preserved above.
            logger?.warn("fix-review", NON_PASS_WARNING, {
              storyId: story.id,
              kind: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return extracted;
        },
      };
    },
    drainFindings(): Finding[] {
      const drained = [...queue];
      queue.length = 0;
      return drained;
    },
  };
}
