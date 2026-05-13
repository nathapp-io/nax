import { callOp, planInteractiveOp } from "../../operations";
import type { PlanInteractiveInput } from "../../operations/plan";
import type { IPlanStrategy, PlanModeContext } from "./types";

export const _singlePlanDeps = {
  callOp,
  planInteractiveOp,
};

export class SinglePlanStrategy implements IPlanStrategy {
  readonly mode = "single" as const;

  async execute(ctx: PlanModeContext): Promise<string> {
    try {
      await _singlePlanDeps.callOp(
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
        _singlePlanDeps.planInteractiveOp,
        {
          specContent: ctx.specContent,
          codebaseContext: ctx.codebaseContext,
          featureName: ctx.options.feature,
          branchName: ctx.branchName,
          outputPath: ctx.outputPath,
          packages: ctx.relativePackages,
          packageDetails: ctx.packageDetails,
          projectProfile: ctx.fullConfig.project,
        } satisfies PlanInteractiveInput,
      );
      return ctx.outputPath;
    } catch (err) {
      if (ctx.deps.existsSync(ctx.outputPath)) {
        return ctx.outputPath;
      }
      throw err;
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
