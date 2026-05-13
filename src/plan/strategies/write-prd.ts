import { NaxError } from "../../errors";
import type { PRD } from "../../prd/types";
import type { PlanModeContext } from "./types";

export async function writeOrRecoverPrd(ctx: PlanModeContext, prd: PRD | null, err?: unknown): Promise<string> {
  if (prd !== null) {
    await ctx.deps.writeFile(ctx.outputPath, JSON.stringify(prd, null, 2));
    return ctx.outputPath;
  }

  if (err === undefined) {
    throw new NaxError("[plan] writeOrRecoverPrd requires an error when prd is null", "PLAN_WRITE_PRD_MISSING_ERR", {
      stage: "plan",
    });
  }

  try {
    await ctx.deps.readFile(ctx.outputPath);
    return ctx.outputPath;
  } catch {
    throw err;
  }
}
