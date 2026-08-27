/**
 * Injectable dispatch seam for `runPlan` — lets tests stub the debater call
 * without `spyOn(callModule, "callOp")`.
 *
 * Monomorphic on purpose, mirroring `_hybridDeps` in runner-hybrid.ts: all three
 * paths in runner-plan.ts dispatch exactly one op (`planDebaterOp`), so the
 * inferred generic `<I, O, C>` signature over-stated the seam and no stub could
 * satisfy it without a cast (#1514 callop-seam).
 *
 * Lives in its own module so runner-plan.ts stays under the 400-line cap that
 * `session-helpers.test.ts` (AC1) enforces for src/debate/.
 */

import { callOp } from "../operations/call";
import type { DebatePlanInput, DebatePlanOutput, planDebaterOp } from "../operations/debate-plan";
import type { CallContext } from "../operations/types";

export const _planDeps: {
  callOp: (ctx: CallContext, op: typeof planDebaterOp, input: DebatePlanInput) => Promise<DebatePlanOutput>;
} = {
  callOp,
};
