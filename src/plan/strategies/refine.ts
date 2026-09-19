import { NaxError } from "@/errors";
import type { PlanRefineInput } from "@/operations";
import { callOp, planRefineOp } from "@/operations";
import type { IPlanStrategy, PlanModeContext, PlanResult } from "./types";
import { writeOrRecoverPrd } from "./write-prd";

export const _refinePlanDeps = {
  callOp,
  planRefineOp,
};

/**
 * `callOp` signals retry exhaustion by RETURNING a raw `TurnResult` envelope
 * rather than throwing (src/operations/call.ts — "last-resort envelope
 * passthrough"). Treating that as the success path drove `writeOrRecoverPrd`
 * into its `err === undefined` invariant instead of the disk recovery written
 * for exactly this case (#2124).
 *
 * Returning an error here rather than throwing keeps the envelope-extraction
 * path in `writeOrRecoverPrd` intact: a `TurnResult` whose `output` holds the
 * real PRD JSON is still recovered and persisted undegraded, and the error only
 * decides what happens after that fails. `SinglePlanStrategy` gets the same
 * contract from `assertIsValidPrd`, which throws.
 */
function exhaustionError(prd: unknown): NaxError | undefined {
  const looksLikePrd =
    prd !== null && typeof prd === "object" && Array.isArray((prd as { userStories?: unknown }).userStories);
  if (looksLikePrd) return undefined;

  return new NaxError(
    "[plan] plan-refine exhausted its retries and returned a non-PRD envelope",
    "PLAN_REFINE_EXHAUSTED",
    { stage: "plan" },
  );
}

export class RefinePlanStrategy implements IPlanStrategy {
  readonly mode = "refine" as const;

  async execute(ctx: PlanModeContext): Promise<PlanResult> {
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
          maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
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
          projectProfile: ctx.config.project,
          specGuard: ctx.config.plan.specGuard ?? false,
          workdir: ctx.workdir,
        } satisfies PlanRefineInput,
      );
      return writeOrRecoverPrd(ctx, prd, exhaustionError(prd));
    } catch (err) {
      return writeOrRecoverPrd(ctx, null, err);
    } finally {
      await ctx.runtime.close().catch(() => {});
    }
  }
}
