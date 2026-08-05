import { renderManifestSection } from "@/debate";
import type { FactsManifest } from "@/debate/facts-manifest";
import { NaxError } from "@/errors";
import { applyPlanFidelity, callOp, groundOp, planDraftOp } from "@/operations";
import type { CallContext, PlanDraftInput } from "@/operations";
import { runPlanCritic } from "../critic";
import { finalizePrdRouting } from "./finalize-routing";
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
    if (ctx.config.debate?.enabled === true) {
      ctx.deps.getLogger()?.warn("plan", "pipeline mode active; debate config ignored", {
        storyId: ctx.options.feature,
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
      } satisfies CallContext;

      let manifest: FactsManifest;
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
        citationThreshold: ctx.config.plan.citationThreshold,
        packages: ctx.relativePackages,
        packageDetails: ctx.packageDetails,
        projectProfile: ctx.config.project,
      };
      const draft = await _pipelinePlanDeps.callOp(callCtx, _pipelinePlanDeps.planDraftOp, draftCtx);

      const verdict = await _pipelinePlanDeps.runPlanCritic({
        prd: draft.prd,
        manifest,
        workdir: ctx.workdir,
        runId: ctx.runtime.runId,
        storyId: ctx.options.feature,
        config: ctx.runtime.configLoader.current(),
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

      // The critic can drop feature-level exclusions the draft carried; this path
      // has no op verify, so restore them here for parity with single/refine.
      const scoped = applyPlanFidelity(verdict.prd, ctx.specContent, ctx.options.feature);
      const prdToWrite = finalizePrdRouting(
        { ...scoped, project: ctx.projectName },
        ctx.config.routing?.agents,
        ctx.profileName,
      );
      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(prdToWrite, null, 2));
      return ctx.outputPath;
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
