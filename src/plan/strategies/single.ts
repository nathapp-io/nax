import { getSafeLogger } from "@/logger";
import { callOp, planInteractiveOp } from "@/operations";
import type { PlanInteractiveInput } from "@/operations";
import { validatePlanOutput } from "@/prd";
import { assertIsValidPrd } from "./assert";
import { persistPrd } from "./persist-prd";
import type { IPlanStrategy, PlanModeContext, PlanResult } from "./types";

export const _singlePlanDeps = {
  callOp,
  planInteractiveOp,
};

export class SinglePlanStrategy implements IPlanStrategy {
  readonly mode = "single" as const;

  async execute(ctx: PlanModeContext): Promise<PlanResult> {
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
      return { outputPath: await persistPrd(ctx, prd) };
    } catch (err) {
      if (ctx.deps.existsSync(ctx.outputPath)) {
        const rawContent = await ctx.deps.readFile(ctx.outputPath);
        const recoveredPrd = validatePlanOutput(rawContent, ctx.options.feature, ctx.branchName);
        // Same degraded-result contract as writeOrRecoverPrd — single hand-rolls
        // its own recovery rather than sharing that helper, which is exactly how
        // it escaped #1494's original scope table.
        const reason = err instanceof Error ? err.message : String(err);
        getSafeLogger()?.warn("plan", "PRD recovered from disk after a plan failure — result is degraded", {
          featureName: ctx.options.feature,
          outputPath: ctx.outputPath,
          error: reason,
        });
        return { outputPath: await persistPrd(ctx, recoveredPrd), degraded: { reason } };
      }
      throw err;
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
