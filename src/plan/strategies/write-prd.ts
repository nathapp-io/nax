import { NaxError } from "@/errors";
import { validatePlanOutput } from "@/prd";
import type { PRD } from "@/prd/types";
import type { PlanModeContext } from "./types";

export async function writeOrRecoverPrd(ctx: PlanModeContext, prd: PRD | null, err?: unknown): Promise<string> {
  if (prd !== null) {
    await ctx.deps.writeFile(ctx.outputPath, JSON.stringify({ ...prd, project: ctx.projectName }, null, 2));
    return ctx.outputPath;
  }

  if (err === undefined) {
    throw new NaxError("[plan] writeOrRecoverPrd requires an error when prd is null", "PLAN_WRITE_PRD_MISSING_ERR", {
      stage: "plan",
    });
  }

  try {
    const rawContent = await ctx.deps.readFile(ctx.outputPath);
    const recoveredPrd = validatePlanOutput(rawContent, ctx.options.feature, ctx.branchName);
    await ctx.deps.writeFile(ctx.outputPath, JSON.stringify({ ...recoveredPrd, project: ctx.projectName }, null, 2));
    return ctx.outputPath;
  } catch {
    throw err;
  }
}
