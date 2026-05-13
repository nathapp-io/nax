import { NaxError } from "@/errors";
import type { PRD } from "@/prd/types";

export function assertIsValidPrd(prd: unknown): asserts prd is PRD {
  if (typeof prd !== "object" || prd === null || Array.isArray(prd)) {
    throw new NaxError("plan: callOp returned a non-PRD value", "PLAN_INVALID_RESULT", { stage: "plan" });
  }
  const candidate = prd as Record<string, unknown>;
  if (!Array.isArray(candidate.userStories) || candidate.userStories.length === 0) {
    throw new NaxError(
      "plan: callOp returned an envelope-shaped object (no userStories) — likely retry exhaustion (#993)",
      "PLAN_ENVELOPE_LEAK",
      { stage: "plan", keys: Object.keys(candidate).join(",") },
    );
  }
}
