import { NaxError } from "../../errors";
import type { PRD } from "../../prd/types";

export function assertIsValidPrd(prd: unknown): asserts prd is PRD {
  void prd;
  throw new NaxError("assertIsValidPrd is not implemented yet", "PLAN_ASSERT_PRD_UNIMPLEMENTED", {
    stage: "plan",
  });
}
