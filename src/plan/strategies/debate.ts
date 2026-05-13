import { callOp, planInteractiveOp } from "../../operations";
import type { PlanInteractiveInput } from "../../operations/plan";
import { NaxError } from "../../errors";
import { validatePlanOutput } from "../../prd/schema";
import type { PRD } from "../../prd/types";
import { PlanPromptBuilder } from "../../prompts";
import { buildPlanComposition } from "./debate-composition";
import type { IPlanStrategy, PlanModeContext } from "./types";
import { writeOrRecoverPrd } from "./write-prd";

export const _debatePlanDeps = {
  callOp,
  planInteractiveOp,
  PlanPromptBuilder,
  buildPlanComposition,
  writeOrRecoverPrd,
};

export class DebatePlanStrategy implements IPlanStrategy {
  readonly mode = "debate" as const;

  async execute(ctx: PlanModeContext): Promise<string> {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      ctx.specContent,
      ctx.codebaseContext,
      undefined,
      ctx.relativePackages,
      ctx.packageDetails,
      ctx.fullConfig?.project,
    );
    const planStage = ctx.config.debate?.stages?.plan;
    if (!planStage) {
      throw new NaxError("[plan] debate strategy requires config.debate.stages.plan", "PLAN_DEBATE_STAGE_CONFIG_MISSING", {
        stage: "plan",
      });
    }
    const stageConfig = buildPlanComposition(
      planStage as import("../../debate/types").DebateStageConfig & {
        evidenceMode?: "current" | "asymmetric";
      },
    );

    const callCtx = {
      runtime: ctx.runtime,
      packageView: ctx.runtime.packages.resolve(),
      packageDir: ctx.workdir,
      agentName: ctx.runtime.agentManager.getDefault(),
      storyId: ctx.options.feature,
      featureName: ctx.options.feature,
    } satisfies import("../../operations/types").CallContext;

    const runner = ctx.deps.createDebateRunner({
      ctx: callCtx,
      stage: "plan",
      stageConfig,
      config: ctx.fullConfig,
      workdir: ctx.workdir,
      featureName: ctx.options.feature,
      timeoutSeconds: ctx.timeoutSeconds,
      sessionManager: ctx.runtime.sessionManager,
    });

    try {
      const debateResult = await runner.runPlan(taskContext, outputFormat, {
        workdir: ctx.workdir,
        feature: ctx.options.feature,
        outputDir: ctx.outputDir,
        timeoutSeconds: ctx.timeoutSeconds,
        maxInteractionTurns: ctx.fullConfig?.agent?.maxInteractionTurns,
        specContent: ctx.specContent,
      });

      if (debateResult.outcome !== "failed" && debateResult.output) {
        const prd = validatePlanOutput(debateResult.output, ctx.options.feature, ctx.branchName);
        const withProject = { ...prd, project: ctx.projectName } satisfies PRD;
        return writeOrRecoverPrd(ctx, withProject);
      }

      const prd = await callOp(
        {
          ...callCtx,
          interactionBridge: ctx.interactionBridge,
          maxInteractionTurns: ctx.fullConfig?.agent?.maxInteractionTurns,
        },
        planInteractiveOp,
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
      const withProject = { ...(prd as PRD), project: ctx.projectName } satisfies PRD;
      return writeOrRecoverPrd(ctx, withProject);
    } catch (err) {
      return writeOrRecoverPrd(ctx, null, err);
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
