/** Scoped re-review (spec §6 step 5): only FIX_BASE..HEAD, verdict per open finding, rereview-<R>.json. */
import { join } from "node:path";
import { workflowReReviewOp } from "@/operations";
import { buildWorkflowReReviewPrompt } from "@/prompts";
import { writeReviewPackage } from "./git";
import { _workflowDeps, type StepContext } from "./step-context";
import { type ReviewOutcome, underReviewLimit, writeVerdictSafe } from "./story-review";
import type { ReReviewVerdict, WorkflowFinding } from "./types";

export async function runReReview(
  sc: StepContext,
  round: number,
  findings: readonly WorkflowFinding[],
  fixBase: string,
): Promise<ReviewOutcome<ReReviewVerdict>> {
  const packagePath = join(sc.storyDir, `package-${round}.diff`);
  const prompt = buildWorkflowReReviewPrompt({
    briefPath: sc.briefPath,
    reportPath: sc.reportPath,
    packagePath,
    findings,
  });
  const outcome = await underReviewLimit(
    sc,
    () => writeReviewPackage(sc.projectDir, fixBase, packagePath),
    (signal) =>
      _workflowDeps.callOp({ ...sc.callCtx, ...(signal ? { signal } : {}) }, workflowReReviewOp, {
        prompt,
        openIds: findings.map((f) => f.id),
        timeoutMs: sc.workflow.timeouts.reviewMs,
      }),
  );
  if (outcome.ran) await writeVerdictSafe(sc, `rereview-${round}.json`, outcome.verdict);
  return outcome;
}
