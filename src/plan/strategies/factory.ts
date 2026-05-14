import { NaxError } from "@/errors";
import { DebatePlanStrategy } from "./debate";
import { PipelinePlanStrategy } from "./pipeline";
import { RefinePlanStrategy } from "./refine";
import { SinglePlanStrategy } from "./single";
import type { IPlanStrategy } from "./types";

export function createPlanStrategy(mode: IPlanStrategy["mode"]): IPlanStrategy {
  switch (mode) {
    case "single":
      return new SinglePlanStrategy();
    case "pipeline":
      return new PipelinePlanStrategy();
    case "debate":
      return new DebatePlanStrategy();
    case "refine":
      return new RefinePlanStrategy();
    default:
      throw new NaxError(`[plan] Unknown plan mode: ${mode}`, "PLAN_MODE_UNKNOWN", {
        stage: "plan",
        mode,
      });
  }
}
