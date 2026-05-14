import { callOp, planRefineOp } from "@/operations";
import type { PlanRefineInput } from "@/operations";
import type { IPlanStrategy, PlanModeContext } from "./types";
import { writeOrRecoverPrd } from "./write-prd";

export const _refinePlanDeps = {
  callOp,
  planRefineOp,
};

export class RefinePlanStrategy implements IPlanStrategy {
  readonly mode = "refine" as const;

  async execute(ctx: PlanModeContext): Promise<string> {
    // planCommand() closes the shared runtime in its finally block.
    try {
      const prd = await _refinePlanDeps.callOp(
        {
          runtime: ctx.runtime,
          packageView: ctx.runtime.packages.resolve(),
          packageDir: ctx.workdir,
          agentName: ctx.runtime.agentManager.getDefault(),
          storyId: ctx.options.feature,
          featureName: ctx.options.feature,
          interactionBridge: ctx.interactionBridge,
          maxInteractionTurns: ctx.fullConfig.agent?.maxInteractionTurns,
        },
        _refinePlanDeps.planRefineOp,
        {
          specContent: ctx.specContent,
          codebaseContext: ctx.codebaseContext,
          featureName: ctx.options.feature,
          branchName: ctx.branchName,
          outputPath: ctx.outputPath,
          packages: ctx.relativePackages,
          packageDetails: ctx.packageDetails,
          projectProfile: ctx.fullConfig.project,
        } satisfies PlanRefineInput,
      );
      return writeOrRecoverPrd(ctx, prd);
    } catch (err) {
      return writeOrRecoverPrd(ctx, null, err);
    }
  }
}
