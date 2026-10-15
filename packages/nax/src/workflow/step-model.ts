/**
 * The model each workflow agent step will run on, for its start line (nax#2491 P6). Reads the same
 * op model functions dispatch uses (`previewOpModel`), so a fix round that steps up a tier names the
 * stepped-up model. Fail-open: an unresolvable model is simply not named.
 */
import {
  previewOpModel,
  workflowBranchFixOp,
  workflowBranchReviewOp,
  workflowImplementOp,
  workflowReReviewOp,
  workflowStoryReviewOp,
} from "@/operations";
import { branchReviewModel } from "./branch-review";
import type { FeatureContext } from "./feature-context";
import type { FeatureSteps } from "./feature-machine";
import { type ImplementTurn, implementerModelFor } from "./implement";
import type { StepModel } from "./run-log";
import type { StepContext } from "./step-context";
import type { StoryLoopSteps } from "./story-loop";

const NO_TIMEOUT = 0;

function storyStepModel(
  sc: StepContext,
  step: Parameters<NonNullable<StoryLoopSteps["modelFor"]>>[0],
  turn: ImplementTurn | undefined,
): StepModel | undefined {
  if (step === "implementer") {
    const model = turn ? implementerModelFor(sc, turn) : undefined;
    return previewOpModel(sc.callCtx, workflowImplementOp, {
      story: sc.story,
      prompt: "",
      reportPath: sc.reportPath,
      timeoutMs: NO_TIMEOUT,
      ...(model !== undefined ? { model } : {}),
    });
  }
  if (step === "story-review") {
    return previewOpModel(sc.callCtx, workflowStoryReviewOp, { prompt: "", timeoutMs: NO_TIMEOUT });
  }
  return previewOpModel(sc.callCtx, workflowReReviewOp, { prompt: "", openIds: [], timeoutMs: NO_TIMEOUT });
}

export function storyModelFor(sc: StepContext): NonNullable<StoryLoopSteps["modelFor"]> {
  return (step, turn) => storyStepModel(sc, step, turn);
}

export function featureModelFor(fc: FeatureContext): NonNullable<FeatureSteps["modelFor"]> {
  return (step) => {
    if (step === "branch-review") {
      // The preview only resolves the op's model, which reads no input field but `model`.
      return previewOpModel(fc.callCtx, workflowBranchReviewOp, {
        prompt: "",
        timeoutMs: NO_TIMEOUT,
        minorIds: [],
        requiredFiles: [],
        repoRoot: fc.projectDir,
        range: "",
      });
    }
    if (step === "branch-fix") {
      return previewOpModel(fc.callCtx, workflowBranchFixOp, {
        prompt: "",
        timeoutMs: NO_TIMEOUT,
        reportPath: fc.reportPath,
      });
    }
    const model = branchReviewModel(fc);
    return previewOpModel(fc.callCtx, workflowReReviewOp, {
      prompt: "",
      openIds: [],
      timeoutMs: NO_TIMEOUT,
      ...(model !== undefined ? { model } : {}),
    });
  };
}
