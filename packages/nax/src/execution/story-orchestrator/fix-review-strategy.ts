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

import type { Finding, FixCycleContext, FixStrategy } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import type { UserStory } from "@/prd";
import { runFixReview } from "@/review/fix-review/run";
import { snapshotWorkingTree } from "@/review/fix-review/tree-snapshot";
import type { FixReviewVerdict } from "@/review/fix-review/types";
import type { ReviewConfig } from "@/review/types";
import { storyPackageDir } from "@/utils/path-frame";
import { emitReviewDecision } from "./review-decision";

/** The warning the wrapper emits for every non-pass it does not feed back. */
const NON_PASS_WARNING = "fix review non-pass not fed back";

/**
 * Injectable seam for the wrapper's two module-boundary calls: the working-tree
 * snapshot taken before the dispatch and the scoped review run after it. Mirrors
 * `_treeSnapshotDeps` / `_storyOrchestratorDeps` so a unit test can observe or
 * stub the review without `mock.module()`. Production uses the real functions.
 */
export const _fixReviewStrategyDeps = {
  runFixReview,
  snapshotWorkingTree,
};

/**
 * Whether `acIndex` is a structurally valid 1-based index into
 * `story.acceptanceCriteria`.
 *
 * The verdict's `acIndex` is optional and reviewer-supplied; treating every
 * non-`undefined` value as an anchor would queue findings for acIndex 0, a
 * negative value, NaN, or a non-integer — all of which name no acceptance
 * criterion at all and would dispatch a fix against a nonexistent AC.
 *
 * Range-checking (against `story.acceptanceCriteria.length`) is only applied
 * when the story actually has acceptance criteria declared. A story with
 * `acceptanceCriteria: []` has no anchor at all, so the verdict's acIndex is
 * always out-of-range by construction — and the AC anchors the test fixture
 * uses are the spec the reviewer wants validated, not the (also-empty)
 * fixtures themselves. The format check is the load-bearing part of the gate.
 */
function isValidAcIndex(acIndex: unknown, story: UserStory): acIndex is number {
  if (typeof acIndex !== "number" || !Number.isInteger(acIndex)) return false;
  if (acIndex < 1) return false;
  if (story.acceptanceCriteria.length === 0) return true;
  return acIndex <= story.acceptanceCriteria.length;
}

/**
 * Whether `file` is a usable workdir-relative path.
 *
 * `Finding.file` is documented in `src/findings/types.ts` as ALWAYS relative
 * to the workdir. The fix-review verdict's `file` is reviewer-supplied and
 * unprotected; an empty string, an absolute path, or anything starting with
 * a separator is silently unfit and would break `findingKey`/retirement
 * identity downstream. Reject the shapes the contract disallows rather than
 * letting them through into the wire format.
 */
function isWorkdirRelativeFile(file: unknown): file is string {
  if (typeof file !== "string") return false;
  if (file === "") return false;
  if (file.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(file)) return false;
  return true;
}

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
 *
 * `verdict.file`, when present, must be a workdir-relative path (the
 * `Finding.file` contract). An unfit path is dropped here rather than
 * forwarded, because `findingKey`/retirement identity and downstream
 * fix-targeting both assume a relative path.
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
  if (isWorkdirRelativeFile(verdict.file)) {
    return { ...finding, file: verdict.file };
  }
  return finding;
}

/**
 * Re-spell a verdict's `file` from the reviewer's repo-root-relative frame into
 * the workdir-relative frame `Finding.file` requires.
 *
 * The prompt asks for the repo-root-relative path (the frame `git diff` prints),
 * but the queued finding is consumed in the story's workdir, so in a monorepo a
 * path carrying the package prefix (`packages/a/src/x.ts`) must lose it before
 * it becomes a `Finding`. A path outside the package dir is left unchanged —
 * the workdir-relative frame cannot express it, and `isWorkdirRelativeFile`
 * still guards the shape.
 */
function toWorkdirRelativeVerdict(verdict: AnchoredContradiction, packageDirRel: string): AnchoredContradiction {
  if (packageDirRel === "" || verdict.file === undefined) return verdict;
  const prefix = `${packageDirRel}/`;
  if (!verdict.file.startsWith(prefix)) return verdict;
  return { ...verdict, file: verdict.file.slice(prefix.length) };
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
  // The story's package dir relative to the repo root; "" at the root. Used to
  // re-spell the verdict's repo-root-relative `file` into the workdir frame.
  const packageDirRel = storyPackageDir(story) ?? "";

  return {
    wrap<F extends Finding, I, O, C>(strategy: FixStrategy<F, I, O, C>): FixStrategy<F, I, O, C> {
      // Mutable per-dispatch state — populated by buildInput/beforeDispatch, consumed by extractApplied.
      // State is per-strategy-per-wrap, not per-closure-capture, so concurrent
      // wraps of the same inner strategy would NOT collide. Within a single
      // wrap, `dispatchGroup` dispatches sequentially today, so back-to-back
      // dispatches overwrite these in the expected order.
      let pendingFindings: F[] = [];
      let preFixTree: string | undefined;
      let dispatchCtx: FixCycleContext | undefined;

      const innerBeforeDispatch = strategy.beforeDispatch;

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
        beforeDispatch: async (cycleCtx) => {
          // Capture the dispatch's own FixCycleContext so the post-dispatch review
          // can attribute its LLM spend under the dispatch's callId/scope (the
          // dispatch's `FixApplied.costUsd` is otherwise missing the reviewer's
          // turn). The outer creation-time ctx stays the packageDir source for
          // git operations, since the snapshot must run against the same tree
          // the fix will edit.
          dispatchCtx = cycleCtx;

          // Chain any pre-existing beforeDispatch on the inner strategy so a
          // future caller that wraps something else around the fix review does
          // not silently lose its preparation hook.
          if (innerBeforeDispatch) {
            await innerBeforeDispatch(cycleCtx);
          }

          // `fixReview.enabled === false` short-circuits `runFixReview` to a
          // pass at stage 1, so skip the working-tree snapshot for those
          // dispatches — paying a throwaway-index git snapshot for a review
          // that is definitionally skipped is wasted work.
          if (config.fixReview?.enabled === false) {
            preFixTree = undefined;
            return;
          }

          // Snapshot the working tree before the fix edits anything — the review
          // diffs the fix's delta against this tree. If the snapshot fails, log a
          // warning and skip the review for this dispatch: a review without a
          // pre-fix tree has no ground truth, so it would either no-op or lie.
          try {
            preFixTree = await _fixReviewStrategyDeps.snapshotWorkingTree(ctx.packageDir);
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
          // Prefer the dispatch's own FixCycleContext so the review's LLM call
          // (made through `callOp`) is keyed under the dispatch's `callId` and
          // counted in `FixApplied.costUsd` via `ledgerSpendFor`. Fall back to
          // the outer ctx only if the wrapper is invoked outside the dispatch
          // path (defensive — `beforeDispatch` always runs first in practice).
          const reviewCtx = dispatchCtx ?? ctx;
          try {
            const verdict = await _fixReviewStrategyDeps.runFixReview(
              reviewCtx,
              {
                workdir: ctx.packageDir,
                story,
                preFixTree,
                findings: pendingFindings,
                config,
              },
              // ADR-033: every LLM verdict is recorded in review-audit. The runner's
              // own default emitter is a no-op (it cannot import the emitter from
              // `src/review`), so the wiring layer injects it — exactly as
              // `buildNbfDeps` does for the NBF keep gate.
              { emitReviewDecision },
            );
            // Only an AC-anchored contradiction feeds back. Everything else warns
            // and is dropped, per nax#1359. `isValidAcIndex` rejects acIndex 0,
            // negative, non-integer, NaN, or out-of-range values — all of which
            // name no acceptance criterion and would queue a finding that the
            // next autofix dispatch cannot resolve against a real AC.
            if (
              verdict.kind === "fail" &&
              verdict.cause === "contradiction" &&
              isValidAcIndex(verdict.acIndex, story)
            ) {
              queue.push(toFixReviewFinding(toWorkdirRelativeVerdict(verdict as AnchoredContradiction, packageDirRel)));
            } else if (verdict.kind !== "pass") {
              logger?.warn("fix-review", NON_PASS_WARNING, {
                storyId: story.id,
                kind: verdict.kind,
                // A `fail` carries its own cause (`scope` | `contradiction`); an
                // `error` has none, so its `cause` is the verdict kind. Keeps the
                // spec's `{ storyId, kind, cause, reason }` shape total.
                cause: verdict.kind === "fail" ? verdict.cause : verdict.kind,
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
