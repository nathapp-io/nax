import { NaxError } from "@/errors";
import { validatePlanOutput } from "@/prd";
import type { PRD } from "@/prd/types";
import { finalizePrdRouting } from "./finalize-routing";
import type { PlanModeContext } from "./types";

export async function writeOrRecoverPrd(ctx: PlanModeContext, prd: PRD | null, err?: unknown): Promise<string> {
  const tryExtractPrd = (value: unknown): PRD | null => {
    if (value === null || typeof value !== "object") return null;

    try {
      return validatePlanOutput(JSON.stringify(value), ctx.options.feature, ctx.branchName);
    } catch {
      // Continue — some failure paths pass through a raw TurnResult envelope whose
      // `output` field contains the real PRD JSON string. Recover that instead of
      // persisting the envelope as if it were a PRD.
    }

    const maybeOutput = (value as { output?: unknown }).output;
    if (typeof maybeOutput !== "string") return null;
    try {
      return validatePlanOutput(maybeOutput, ctx.options.feature, ctx.branchName);
    } catch {
      return null;
    }
  };

  if (prd !== null) {
    if (Array.isArray((prd as { userStories?: unknown }).userStories)) {
      const finalized = finalizePrdRouting(
        { ...prd, project: ctx.projectName },
        ctx.config.routing?.agents,
        ctx.profileName,
      );
      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(finalized, null, 2));
      return ctx.outputPath;
    }

    const normalizedPrd = tryExtractPrd(prd);
    if (normalizedPrd !== null) {
      const finalized = finalizePrdRouting(
        { ...normalizedPrd, project: ctx.projectName },
        ctx.config.routing?.agents,
        ctx.profileName,
      );
      await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(finalized, null, 2));
      return ctx.outputPath;
    }
  }

  if (err === undefined) {
    throw new NaxError("[plan] writeOrRecoverPrd requires an error when prd is null", "PLAN_WRITE_PRD_MISSING_ERR", {
      stage: "plan",
    });
  }

  try {
    const rawContent = await ctx.deps.readFile(ctx.outputPath);
    let recoveredPrd: PRD | null = null;
    if (rawContent !== null) {
      try {
        recoveredPrd = tryExtractPrd(JSON.parse(rawContent));
      } catch {
        recoveredPrd = null;
      }
    }
    recoveredPrd = recoveredPrd ?? validatePlanOutput(rawContent, ctx.options.feature, ctx.branchName);
    const finalized = finalizePrdRouting(
      { ...recoveredPrd, project: ctx.projectName },
      ctx.config.routing?.agents,
      ctx.profileName,
    );
    await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(finalized, null, 2));
    return ctx.outputPath;
  } catch {
    throw err;
  }
}
