import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { TurnResult } from "../agents/types";
import type { SessionRole } from "../session/types";
import type { Debater } from "../debate/types";
import { raceAgainstAbort } from "../debate/utils";
import type { RunOperation } from "./types";

export interface DebateHybridInput {
  readonly debater: Debater;
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (round: number, peerOutputs: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly rebutBarriers: PromiseWithResolvers<string>[][];
  readonly signal: AbortSignal;
  readonly storyId: string;
  readonly rounds: number;
}

export interface DebateHybridOutput {
  readonly success: boolean;
  readonly rebut: string;
}

export const hybridDebaterOp: RunOperation<DebateHybridInput, DebateHybridOutput, DebateConfig> = {
  kind: "run",
  name: "debate-hybrid",
  stage: "review",
  session: { role: "debate-hybrid" satisfies SessionRole, lifetime: "fresh" },
  config: debateConfigSelector,
  model: (input) => ({ agent: input.debater.agent, model: input.debater.model ?? "fast" }),
  async hopBody(_initialPrompt, ctx) {
    // Proposal barriers are pre-resolved by the coordinator; await directly
    // without racing against the abort signal so the send happens in fewer
    // microtask hops and the barrier chain can be tested synchronously.
    let priorPeerOutputs = await Promise.all(ctx.input.proposalBarriers.map((b) => b.promise));
    let lastTurn!: TurnResult;
    for (let round = 1; round <= ctx.input.rounds; round++) {
      const myRebut = await ctx.send(ctx.input.buildRebutPrompt(round, priorPeerOutputs));
      ctx.input.rebutBarriers[round - 1][ctx.input.index].resolve(myRebut.output);
      lastTurn = myRebut;
      if (round < ctx.input.rounds) {
        priorPeerOutputs = await raceAgainstAbort(
          Promise.all(ctx.input.rebutBarriers[round - 1].map((b) => b.promise)),
          ctx.input.signal,
          ctx.input.storyId,
        );
      }
    }
    return lastTurn;
  },
  build(input, _ctx) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.proposePrompt, overridable: false },
    };
  },
  parse(output) {
    return { success: !output.startsWith('Agent "'), rebut: output };
  },
};
