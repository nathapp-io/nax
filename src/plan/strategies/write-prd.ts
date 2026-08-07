import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { validatePlanOutput } from "@/prd";
import type { PRD } from "@/prd/types";
import { persistPrd } from "./persist-prd";
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
      return persistPrd(ctx, prd);
    }

    const normalizedPrd = tryExtractPrd(prd);
    if (normalizedPrd !== null) {
      return persistPrd(ctx, normalizedPrd);
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
    // Recovery is deliberate — `nax plan` produces a usable PRD rather than
    // failing — but it is a degraded result, so say so. Silence here is what
    // made #1494 take hours to attribute: exit 0, no console line, no JSONL record.
    getSafeLogger()?.warn("plan", "PRD recovered from disk after a plan failure — result is degraded", {
      featureName: ctx.options.feature,
      outputPath: ctx.outputPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return persistPrd(ctx, recoveredPrd);
  } catch {
    throw err;
  }
}
