import { callOp, planInteractiveOp } from "../../operations";
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

  async execute(_ctx: PlanModeContext): Promise<string> {
    return "";
  }
}
