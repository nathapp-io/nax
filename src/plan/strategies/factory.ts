import { NaxError } from "@/errors";
import { RefinePlanStrategy } from "./refine";
import { SinglePlanStrategy } from "./single";
import type { IPlanStrategy } from "./types";

export function createPlanStrategy(mode: IPlanStrategy["mode"]): IPlanStrategy {
  switch (mode) {
    case "single":
      return new SinglePlanStrategy();
    case "refine":
      return new RefinePlanStrategy();
    default:
      throw new NaxError(`[plan] Unknown plan mode: ${mode}`, "PLAN_MODE_UNKNOWN", {
        stage: "plan",
        mode,
      });
  }
}
