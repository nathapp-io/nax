/** The run's turn hooks: reviewer tree guard (nax#2500) then run-state repair (#2497). */

import { ReviewerTreeGuard } from "../review/reviewer-guard";
import type { RepairContext } from "../runstate";
import type { TurnHookPair } from "../session";

export function createRunTurnHooks(deps: {
  readonly repairRunState: (ctx: RepairContext) => Promise<unknown>;
}): TurnHookPair {
  const guard = new ReviewerTreeGuard();
  return {
    before: (desc) => guard.beforeTurn(desc),
    after: async (desc, turn) => {
      await guard.afterTurn(desc);
      await deps.repairRunState({
        trigger: "turn",
        storyId: desc.storyId,
        sessionName: desc.handle ?? desc.id,
        stage: desc.role,
        turn,
      });
    },
  };
}
