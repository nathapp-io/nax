import { renderManifestSection } from "../../debate";
import { NaxError } from "../../errors";
import { callOp, groundOp, planDraftOp } from "../../operations";
import type { PlanDraftInput } from "../../operations";
import { runPlanCritic } from "../critic";
import type { IPlanStrategy, PlanModeContext } from "./types";

export const _pipelinePlanDeps = {
  callOp,
  groundOp,
  planDraftOp,
  runPlanCritic,
};

export class PipelinePlanStrategy implements IPlanStrategy {
  readonly mode = "pipeline" as const;

  async execute(ctx: PlanModeContext): Promise<string> {
    if (ctx.fullConfig?.debate?.enabled === true) {
      ctx.deps.getLogger()?.warn("plan", "pipeline mode active; debate config ignored", {
        mode: "pipeline",
        debateEnabled: true,
      });
    }

    try {
      const callCtx = {
        runtime: ctx.runtime,
        packageView: ctx.runtime.packages.resolve(),
        packageDir: ctx.workdir,
        agentName: ctx.runtime.agentManager.getDefault(),
        storyId: ctx.options.feature,
        featureName: ctx.options.feature,
      } satisfies import("../../operations/types").CallContext;

      let manifest: import("../../debate/facts-manifest").FactsManifest;
      try {
        manifest = await _pipelinePlanDeps.callOp(callCtx, _pipelinePlanDeps.groundOp, {
          specContent: ctx.specContent,
          codebaseContext: ctx.codebaseContext,
          workdir: ctx.workdir,
        });
      } catch (err) {
        throw new NaxError("Plan pipeline: grounder failed", "PLAN_PIPELINE_GROUND_FAILED", {
          stage: "plan",
          cause: err,
        });
      }

      const draftCtx: PlanDraftInput = {
        manifestSection: renderManifestSection(manifest),
        manifest,
        specContent: ctx.specContent,
        codebaseContext: ctx.codebaseContext,
        feature: ctx.options.feature,
        branchName: ctx.branchName,
        citationThreshold: ctx.fullConfig.plan?.citationThreshold ?? 0.5,
        packages: ctx.relativePackages,
        packageDetails: ctx.packageDetails,
        projectProfile: ctx.fullConfig?.project,
      };
      const draft = await _pipelinePlanDeps.callOp(callCtx, _pipelinePlanDeps.planDraftOp, draftCtx);

      const verdict = await _pipelinePlanDeps.runPlanCritic({
        prd: draft.prd,
        manifest,
        workdir: ctx.workdir,
        runId: ctx.runtime.runId,
        storyId: ctx.options.feature,
        config: ctx.fullConfig,
        callCtx,
        draftCtx,
      });

      if (verdict.outcome !== "passed") {
        throw new NaxError(
          verdict.specDeltasPath
            ? `Plan pipeline failed; see ${verdict.specDeltasPath}`
            : "Plan pipeline failed with no spec-deltas path",
          "PLAN_CRITIC_BLOCKED",
          { stage: "plan", specDeltasPath: verdict.specDeltasPath },
        );
      }

      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify({ ...verdict.prd, project: ctx.projectName }, null, 2));
      return ctx.outputPath;
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
