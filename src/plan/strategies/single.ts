import { callOp, planInteractiveOp } from "@/operations";
import type { PlanInteractiveInput } from "@/operations";
import { validatePlanOutput } from "@/prd";
import { assertIsValidPrd } from "./assert";
import { finalizePrdRouting } from "./finalize-routing";
import type { IPlanStrategy, PlanModeContext } from "./types";

export const _singlePlanDeps = {
  callOp,
  planInteractiveOp,
};

export class SinglePlanStrategy implements IPlanStrategy {
  readonly mode = "single" as const;

  async execute(ctx: PlanModeContext): Promise<string> {
    try {
      const prd = await _singlePlanDeps.callOp(
        {
          runtime: ctx.runtime,
          packageView: ctx.runtime.packages.resolve(),
          packageDir: ctx.workdir,
          agentName: ctx.runtime.agentManager.getDefault(),
          storyId: ctx.options.feature,
          featureName: ctx.options.feature,
          interactionBridge: ctx.interactionBridge,
          maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
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
          projectProfile: ctx.config.project,
        } satisfies PlanInteractiveInput,
      );
      assertIsValidPrd(prd);
      const finalized = finalizePrdRouting(
        { ...prd, project: ctx.projectName },
        ctx.config.routing?.agents,
        ctx.profileName,
      );
      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(finalized, null, 2));
      return ctx.outputPath;
    } catch (err) {
      if (ctx.deps.existsSync(ctx.outputPath)) {
        const rawContent = await ctx.deps.readFile(ctx.outputPath);
        const recoveredPrd = validatePlanOutput(rawContent, ctx.options.feature, ctx.branchName);
        const finalizedRecovered = finalizePrdRouting(
          { ...recoveredPrd, project: ctx.projectName },
          ctx.config.routing?.agents,
          ctx.profileName,
        );
        await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(finalizedRecovered, null, 2));
        return ctx.outputPath;
      }
      throw err;
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
