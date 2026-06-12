import type { DebateStageConfig } from "@/debate/types";
import { NaxError } from "@/errors";
import { callOp, planInteractiveOp, warnOnDroppedVerbatimAcs } from "@/operations";
import type { CallContext, PlanInteractiveInput } from "@/operations";
import { validatePlanOutput } from "@/prd";
import type { PRD } from "@/prd/types";
import { PlanPromptBuilder } from "@/prompts";
import { assertIsValidPrd } from "./assert";
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
    const agentRouting = ctx.config.routing?.agents;
    const profiles = agentRouting?.enabled === true ? (agentRouting.profiles ?? []) : [];
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      ctx.specContent,
      ctx.codebaseContext,
      undefined,
      ctx.relativePackages,
      ctx.packageDetails,
      ctx.config.project,
      undefined,
      profiles,
    );
    const planStage = ctx.config.debate?.stages?.plan;
    if (!planStage) {
      throw new NaxError(
        "[plan] debate strategy requires config.debate.stages.plan",
        "PLAN_DEBATE_STAGE_CONFIG_MISSING",
        {
          stage: "plan",
        },
      );
    }
    const stageConfig = _debatePlanDeps.buildPlanComposition(
      planStage as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" },
    );

    const callCtx = {
      runtime: ctx.runtime,
      packageView: ctx.runtime.packages.resolve(),
      packageDir: ctx.workdir,
      agentName: ctx.runtime.agentManager.getDefault(),
      storyId: ctx.options.feature,
      featureName: ctx.options.feature,
    } satisfies CallContext;

    const runner = ctx.deps.createDebateRunner({
      ctx: callCtx,
      stage: "plan",
      stageConfig,
      config: ctx.runtime.configLoader.current(),
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
        maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
        specContent: ctx.specContent,
      });

      if (debateResult.outcome !== "failed" && debateResult.output) {
        const prd = validatePlanOutput(debateResult.output, ctx.options.feature, ctx.branchName);
        // Debate synthesis merges debater candidates and can paraphrase or drop a
        // [verbatim] spec AC. The fallback planInteractiveOp path below already warns
        // via its verify hook; the synthesis path has no op verify, so warn here for
        // parity with refine/single. Warn-and-continue — spec-review --prd is the gate.
        warnOnDroppedVerbatimAcs(prd, ctx.specContent, ctx.options.feature);
        const withProject = { ...prd, project: ctx.projectName } satisfies PRD;
        return _debatePlanDeps.writeOrRecoverPrd(ctx, withProject);
      }

      const prd = await callOp(
        {
          ...callCtx,
          interactionBridge: ctx.interactionBridge,
          maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
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
          projectProfile: ctx.config.project,
        } satisfies PlanInteractiveInput,
      );
      assertIsValidPrd(prd);
      const withProject = { ...prd, project: ctx.projectName } satisfies PRD;
      return _debatePlanDeps.writeOrRecoverPrd(ctx, withProject);
    } catch (err) {
      return _debatePlanDeps.writeOrRecoverPrd(ctx, null, err);
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
