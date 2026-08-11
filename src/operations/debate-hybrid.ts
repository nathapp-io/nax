import type { TurnResult } from "../agents/types";
import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import { _debateSessionDeps } from "../debate/session-helpers";
import type { Debater } from "../debate/types";
import { type DebateTurnSemaphore, raceAgainstAbort } from "../debate/utils";
import type { SessionRole } from "../session/types";
import type { RunOperation } from "./types";

export interface DebateHybridInput {
  readonly debater: Debater;
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (round: number, peerOutputs: string[], priorRoundOutputs: string[][]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly rebutBarriers: PromiseWithResolvers<string>[][];
  readonly signal: AbortSignal;
  readonly storyId: string;
  readonly rounds: number;
  readonly turnSemaphore?: DebateTurnSemaphore;
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
  timeoutMs: (_input, ctx) => (ctx.config.debate?.stages?.review?.timeoutSeconds ?? 600) * 1000,
  async hopBody(initialPrompt, ctx) {
    const logger = _debateSessionDeps.getSafeLogger();
    let totalCostUsd = 0;

    const proposal = ctx.input.turnSemaphore
      ? await ctx.input.turnSemaphore.run(() => ctx.send(initialPrompt))
      : await ctx.send(initialPrompt);
    totalCostUsd += proposal.estimatedCostUsd ?? 0;
    ctx.input.proposalBarriers[ctx.input.index].resolve(proposal.output);

    // Use allSettled so a failing peer does not cascade and abort this debater's
    // rebuttal — the failed peer's output is replaced with an empty string.
    const proposalSettled = await raceAgainstAbort(
      Promise.allSettled(ctx.input.proposalBarriers.map((b) => b.promise)),
      ctx.input.signal,
      ctx.input.storyId,
    );
    let roundInputs = proposalSettled.map((r) => (r.status === "fulfilled" ? r.value : ""));

    let lastTurn: TurnResult = proposal;
    const priorRoundOutputs: string[][] = [];
    for (let round = 1; round <= ctx.input.rounds; round++) {
      logger?.info("debate:rebuttal-start", "debate:rebuttal-start", {
        storyId: ctx.input.storyId,
        round,
        debaterIndex: ctx.input.index,
      });
      try {
        const myRebut = ctx.input.turnSemaphore
          ? await ctx.input.turnSemaphore.run(() =>
              ctx.send(ctx.input.buildRebutPrompt(round, roundInputs, priorRoundOutputs)),
            )
          : await ctx.send(ctx.input.buildRebutPrompt(round, roundInputs, priorRoundOutputs));
        totalCostUsd += myRebut.estimatedCostUsd ?? 0;
        ctx.input.rebutBarriers[round - 1][ctx.input.index].resolve(myRebut.output);
        lastTurn = myRebut;
      } catch (err) {
        logger?.warn("debate", "debate:rebuttal-failed", {
          storyId: ctx.input.storyId,
          round,
          debaterIndex: ctx.input.index,
          error: err instanceof Error ? err.message : String(err),
        });
        ctx.input.rebutBarriers[round - 1][ctx.input.index].reject(err instanceof Error ? err : new Error(String(err)));
        return { ...proposal, output: `Agent "failed" during rebuttal`, estimatedCostUsd: totalCostUsd };
      }
      if (round < ctx.input.rounds) {
        // allSettled here too (see the proposal-round comment above) — Promise.all would
        // let one failing peer's rejected barrier cascade into every surviving debater's
        // hopBody, aborting their own callOp and rejecting THEIR barriers in turn
        // (BUG-13), turning a single proposal/rebuttal-stage failure into a total
        // hybrid-debate failure despite the documented allSettled intent.
        const settledRound = await raceAgainstAbort(
          Promise.allSettled(ctx.input.rebutBarriers[round - 1].map((b) => b.promise)),
          ctx.input.signal,
          ctx.input.storyId,
        );
        const roundOutputs = settledRound.map((r) => (r.status === "fulfilled" ? r.value : ""));
        priorRoundOutputs.push(roundOutputs);
        roundInputs = roundOutputs;
      }
    }
    return { ...lastTurn, estimatedCostUsd: totalCostUsd };
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
