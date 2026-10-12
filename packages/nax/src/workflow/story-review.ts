/** Story review (spec §6 step 4): fresh session, BASE..HEAD package, review.json. Never throws except on abort. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { workflowStoryReviewOp } from "@/operations";
import { buildWorkflowStoryReviewPrompt } from "@/prompts";
import { stepSignal } from "@/utils/step-signal";
import { writeReviewPackage } from "./git";
import type { StepContext } from "./step-context";
import { _workflowDeps } from "./step-context";
import type { StoryReviewVerdict } from "./types";

export type ReviewOutcome<V> =
  | { readonly ran: true; readonly verdict: V }
  | { readonly ran: false; readonly why: string };

/**
 * Builds the review package, then runs one review op under the review step limit; shared with re-review.ts.
 * A package failure is a skipped review, not a thrown error (abort still propagates).
 */
export async function underReviewLimit<V>(
  sc: StepContext,
  writePackage: () => Promise<void>,
  run: (signal: AbortSignal | undefined) => Promise<V | null>,
): Promise<ReviewOutcome<V>> {
  try {
    await writePackage();
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { ran: false, why: `review package failed: ${errorMessage(err)}` };
  }
  const { signal, limit } = stepSignal(sc.runSignal, sc.workflow.timeouts.reviewMs);
  const stoppedHere = (): boolean => limit?.aborted === true && sc.runSignal?.aborted !== true;
  try {
    const verdict = await run(signal);
    if (stoppedHere()) return { ran: false, why: "timeout" };
    return verdict === null ? { ran: false, why: "unparseable reply" } : { ran: true, verdict };
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { ran: false, why: stoppedHere() ? "timeout" : errorMessage(err) };
  }
}

export async function runStoryReview(
  sc: StepContext,
  concerns: readonly string[],
): Promise<ReviewOutcome<StoryReviewVerdict>> {
  const packagePath = join(sc.storyDir, "package-0.diff");
  const prompt = buildWorkflowStoryReviewPrompt({
    briefPath: sc.briefPath,
    reportPath: sc.reportPath,
    packagePath,
    concerns,
  });
  const outcome = await underReviewLimit(
    sc,
    () => writeReviewPackage(sc.projectDir, sc.base, packagePath),
    (signal) =>
      _workflowDeps.callOp({ ...sc.callCtx, ...(signal ? { signal } : {}) }, workflowStoryReviewOp, {
        prompt,
        timeoutMs: sc.workflow.timeouts.reviewMs,
      }),
  );
  if (outcome.ran) await Bun.write(join(sc.storyDir, "review.json"), `${JSON.stringify(outcome.verdict, null, 2)}\n`);
  return outcome;
}
