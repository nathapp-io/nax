import { NaxError } from "@/errors";
import { callOp, planRefineOp } from "@/operations";
import type { PlanRefineInput } from "@/operations";
import type { IPlanStrategy, PlanModeContext } from "./types";
import { writeOrRecoverPrd } from "./write-prd";

/** Error code raised by planRefineOp when the PRD drops a `[verbatim]` spec AC. */
const VERBATIM_DROP_CODE = "PLAN_REFINE_VERIFY_VERBATIM_AC_DROPPED";

export const _refinePlanDeps = {
  callOp,
  planRefineOp,
};

export class RefinePlanStrategy implements IPlanStrategy {
  readonly mode = "refine" as const;

  async execute(ctx: PlanModeContext): Promise<string> {
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
      // Hard gate: a PRD that dropped a [verbatim] spec AC must not be rescued
      // from disk — surface the failure instead of silently writing the drift.
      if (err instanceof NaxError && err.code === VERBATIM_DROP_CODE) throw err;
      return writeOrRecoverPrd(ctx, null, err);
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
