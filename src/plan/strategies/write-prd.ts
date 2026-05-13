import { NaxError } from "../../errors";
import type { PRD } from "../../prd/types";
import type { PlanModeContext } from "./types";

export async function writeOrRecoverPrd(ctx: PlanModeContext, prd: PRD | null, err?: unknown): Promise<string> {
  void ctx;
  void prd;
  void err;
  throw new NaxError("writeOrRecoverPrd is not implemented yet", "PLAN_WRITE_PRD_UNIMPLEMENTED", {
    stage: "plan",
  });
}
