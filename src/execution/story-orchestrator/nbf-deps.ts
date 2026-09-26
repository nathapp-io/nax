/**
 * US-004 — dependency builder for the non-blocking fix (NBF) keep gate.
 *
 * `ExecutionPlan.run` used to build NBF's override object inline; this module
 * owns it instead so the scoped fix review (ADR-033) can be wired in beside
 * `measureSourceDiff` without growing an already-600-line file.
 *
 * The builder always supplies `measureSourceDiff` (built exactly as the prior
 * inline `createMeasureSourceDiff(...)` call did). It supplies the scoped fix
 * review's `reviewFix` only when `ctx.story` is defined, because `runFixReview`
 * requires a `UserStory` and a `ReviewConfig`. The `reviewFix`-absent branch
 * exists purely for callers that construct a `CallContext` without a story
 * (ad-hoc/CLI dispatch); the production execution stage always populates
 * `ctx.story` (src/pipeline/stages/execution.ts).
 */
import type { Finding } from "@/findings";
import type { CallContext } from "@/operations";
import { runFixReview } from "@/review/fix-review/run";
import type { NonBlockingFixDeps } from "../non-blocking-fix";
import { createMeasureSourceDiff } from "../non-blocking-fix";
import { emitReviewDecision } from "./review-decision";

/**
 * Injectable seam for the review runner the NBF keep gate dispatches. Mirrors
 * `_nonBlockingFixDeps` / `_storyOrchestratorDeps` so a test can observe the
 * wiring without `mock.module()`. Production uses the real `runFixReview`.
 */
export const _nbfDeps = { runFixReview };

export function buildNbfDeps(args: { ctx: CallContext; findings: readonly Finding[] }): Partial<NonBlockingFixDeps> {
  const { ctx, findings } = args;
  const deps: Partial<NonBlockingFixDeps> = {
    measureSourceDiff: createMeasureSourceDiff({
      config: ctx.runtime.configLoader.current(),
      projectDir: ctx.runtime.projectDir,
      packageDir: ctx.packageDir,
    }),
  };
  if (ctx.story) {
    const story = ctx.story;
    // `ctx.config.review` is the per-story effective `ReviewConfig`. Falls back to
    // `packageView.config.review` when no per-story override is in scope (CLI /
    // ad-hoc dispatch) — mirrors `runFixReview`'s `ctx.config ?? ctx.packageView.config`
    // pattern for its `TestPatternConfig`.
    const reviewConfig = ctx.config?.review ?? ctx.packageView.config.review;
    deps.reviewFix = (preFixRef) =>
      _nbfDeps.runFixReview(
        ctx,
        {
          workdir: ctx.packageDir,
          story,
          preFixTree: preFixRef,
          findings,
          config: reviewConfig,
        },
        { emitReviewDecision: (c, op, output) => emitReviewDecision(c, op, output) },
      );
  }
  return deps;
}
