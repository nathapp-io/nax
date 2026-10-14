/** The whole-branch review (spec §7 step 2) and its scoped re-review (step 4). Never throw except on abort. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ConfiguredModel } from "@/config";
import { getLogger } from "@/logger";
import { workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import {
  type BranchReviewPromptInput,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
} from "@/prompts";
import type { FeatureContext } from "./feature-context";
import { writeReviewPackage } from "./git";
import { _workflowDeps } from "./step-context";
import { type ReviewOutcome, underReviewLimit } from "./story-review";
import type { BranchReviewVerdict, ReReviewVerdict, WorkflowFinding } from "./types";

/** US-006 (nax#2527): `repoGates` is the repo-gate summary the branch reviewer is told about. */
export type BranchReviewFacts = Pick<
  BranchReviewPromptInput,
  "stories" | "minors" | "parked" | "cannotVerify" | "gateFindings" | "repoGates"
>;

/** Feature artifacts are best effort: a write failure is logged and the step goes on. */
export async function writeFeatureArtifact(fc: FeatureContext, name: string, value: unknown): Promise<void> {
  try {
    await Bun.write(join(fc.runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  } catch (err) {
    getLogger().warn("workflow", `Could not write ${name}, continuing`, { storyId: "_run", error: errorMessage(err) });
  }
}

/** The branch reviewer's model (spec §4): workflow.models.branchReview, then finish.reviewers.quality. */
export function branchReviewModel(fc: FeatureContext): ConfiguredModel | undefined {
  return fc.workflow.models.branchReview ?? fc.config.finish?.reviewers?.quality ?? undefined;
}

export async function runBranchReview(
  fc: FeatureContext,
  input: { seed: string; specPath?: string; preflightPath?: string; facts: BranchReviewFacts },
): Promise<ReviewOutcome<BranchReviewVerdict>> {
  const packagePath = join(fc.runDir, "package-branch.diff");
  const prompt = buildWorkflowBranchReviewPrompt({
    ...(input.specPath ? { specPath: input.specPath } : {}),
    prdPath: fc.prdPath,
    ...(input.preflightPath ? { preflightPath: input.preflightPath } : {}),
    packagePath,
    ...input.facts,
  });
  const outcome = await underReviewLimit(
    fc,
    () => writeReviewPackage(fc.projectDir, input.seed, packagePath),
    (signal) =>
      _workflowDeps.callOp({ ...fc.callCtx, ...(signal ? { signal } : {}) }, workflowBranchReviewOp, {
        prompt,
        timeoutMs: fc.workflow.timeouts.reviewMs,
        minorIds: input.facts.minors.map((m) => m.id),
      }),
  );
  return outcome;
}

export async function runBranchReReview(
  fc: FeatureContext,
  input: { specPath?: string; findings: readonly WorkflowFinding[]; fixBase: string },
): Promise<ReviewOutcome<ReReviewVerdict>> {
  const packagePath = join(fc.runDir, "package-branch-fix.diff");
  const prompt = buildWorkflowBranchReReviewPrompt({
    ...(input.specPath ? { specPath: input.specPath } : {}),
    reportPath: fc.reportPath,
    packagePath,
    findings: input.findings,
  });
  const model = branchReviewModel(fc);
  const outcome = await underReviewLimit(
    fc,
    () => writeReviewPackage(fc.projectDir, input.fixBase, packagePath),
    (signal) =>
      _workflowDeps.callOp({ ...fc.callCtx, ...(signal ? { signal } : {}) }, workflowReReviewOp, {
        prompt,
        openIds: input.findings.map((f) => f.id),
        timeoutMs: fc.workflow.timeouts.reviewMs,
        ...(model !== undefined ? { model } : {}),
      }),
  );
  return outcome;
}
