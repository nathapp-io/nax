import type { NaxConfig } from "../../config";
import { NaxError } from "../../errors";
import type { PlanCommandOptions, PlanDeps, PlanModeContext } from "./types";

export async function buildPlanModeContext(
  workdir: string,
  fullConfig: NaxConfig,
  options: PlanCommandOptions,
  deps: PlanDeps,
): Promise<PlanModeContext> {
  void workdir;
  void fullConfig;
  void options;
  void deps;
  throw new NaxError("buildPlanModeContext is not implemented yet", "PLAN_BUILD_CONTEXT_UNIMPLEMENTED", {
    stage: "plan",
  });
}
