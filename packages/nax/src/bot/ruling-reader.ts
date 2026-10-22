import { botRulingReadOp } from "@/operations";
import type { PrStepContext } from "../workflow/branch-step-context";
import { _workflowDeps } from "../workflow/step-context";
import { botModel } from "./models";
import type { RecordRulingsInput } from "./rulings";

export function rulingModelReader(ctx: PrStepContext, config = ctx.config): RecordRulingsInput["readModel"] {
  return (input) =>
    _workflowDeps.callOp(ctx.callCtx, botRulingReadOp, { ...input, model: botModel(config, "rulings") });
}
