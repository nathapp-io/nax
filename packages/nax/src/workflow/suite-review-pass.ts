import type { GateRunResult } from "./types";

/** Start both tasks before awaiting either, and observe both rejections immediately. */
export async function runSuiteReviewPass(
  suite: () => Promise<GateRunResult>,
  review: (settled: () => void) => Promise<void>,
  now: () => number,
): Promise<{ suite: GateRunResult; overlap: number }> {
  const start = now();
  let suiteEnd = start;
  let reviewEnd = start;
  const suiteTask = Promise.resolve()
    .then(suite)
    .finally(() => {
      suiteEnd = now();
    });
  let marked = false;
  const markReview = () => {
    if (!marked) {
      marked = true;
      reviewEnd = now();
    }
  };
  const reviewTask = Promise.resolve()
    .then(() => review(markReview))
    .finally(markReview);
  const [suiteResult, reviewResult] = await Promise.allSettled([suiteTask, reviewTask]);
  if (suiteResult.status === "rejected") throw suiteResult.reason;
  if (reviewResult.status === "rejected") throw reviewResult.reason;
  return { suite: suiteResult.value, overlap: Math.max(0, Math.min(suiteEnd, reviewEnd) - start) };
}
