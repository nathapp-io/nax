/**
 * ENH-20: count review checks that degraded to a fail-open pass (LLM
 * dispatch failed, gate returned success:true, failOpen:true) so the run
 * summary can distinguish "reviewed green" from "not actually checked".
 * Extracted from post-run.ts to stay within the 600-line file limit.
 */

import { adversarialReviewOp, semanticReviewOp } from "../operations";
import type { PipelineContext } from "../pipeline/types";

/** Sets `ctx.reviewsFailedOpen` (only when nonzero) from the story's review phase outputs. */
export function applyReviewsFailedOpen(ctx: PipelineContext, phaseOutputs: Record<string, unknown>): void {
  const count = [phaseOutputs[semanticReviewOp.name], phaseOutputs[adversarialReviewOp.name]].filter(
    (output) => (output as { failOpen?: boolean } | undefined)?.failOpen === true,
  ).length;
  if (count) ctx.reviewsFailedOpen = count;
}
