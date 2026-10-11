/**
 * A4: one review round, both lenses in parallel (spec §4.5). `allSettled`, so
 * one lens timing out or throwing never cancels the other; either failure
 * reads as a missing verdict for that lens.
 */
import { getSafeLogger } from "@/logger";
import { MISSING_REVIEW } from "./review-json";
import type { FinishReviewOutput, ReviewLens } from "./types";

export interface ReviewRoundResult {
  spec: FinishReviewOutput;
  quality: FinishReviewOutput;
  missing: ReviewLens[];
}

function settle(lens: ReviewLens, r: PromiseSettledResult<FinishReviewOutput>): FinishReviewOutput {
  if (r.status === "fulfilled") return r.value;
  getSafeLogger()?.warn("finish", "Finish review lens failed", { storyId: "_run", lens, error: String(r.reason) });
  return MISSING_REVIEW;
}

export async function runReviewRound(run: {
  spec: () => Promise<FinishReviewOutput>;
  quality: () => Promise<FinishReviewOutput>;
}): Promise<ReviewRoundResult> {
  const [s, q] = await Promise.allSettled([Promise.resolve().then(run.spec), Promise.resolve().then(run.quality)]);
  const spec = settle("spec", s);
  const quality = settle("quality", q);
  const missing: ReviewLens[] = [];
  if (spec.missing) missing.push("spec");
  if (quality.missing) missing.push("quality");
  return { spec, quality, missing };
}
