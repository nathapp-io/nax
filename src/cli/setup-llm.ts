import { callOp } from "../operations";
import type { SetupPlan } from "../operations/setup-generate";
import { setupGenerateOp } from "../operations/setup-generate";
import type { CallContext } from "../operations/types";
import type { RepoAnalysis } from "./setup-types";

export const generateSetupPlan = (ctx: CallContext, analysis: RepoAnalysis): Promise<SetupPlan> =>
  callOp(ctx, setupGenerateOp, analysis);
