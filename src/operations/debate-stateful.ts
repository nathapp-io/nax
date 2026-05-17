import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { Debater } from "../debate/types";
import { type DebateTurnSemaphore, raceAgainstAbort } from "../debate/utils";
import type { SessionRole } from "../session/types";
import type { RunOperation } from "./types";

export interface DebateStatefulInput {
  readonly debater: Debater;
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (peerProposals: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly signal: AbortSignal;
  readonly storyId: string;
  readonly skipRebuttal?: boolean;
  readonly turnSemaphore?: DebateTurnSemaphore;
}

export interface DebateStatefulOutput {
  readonly success: boolean;
  readonly rebut: string;
}

export const statefulDebaterOp: RunOperation<DebateStatefulInput, DebateStatefulOutput, DebateConfig> = {
  kind: "run",
  name: "debate-stateful",
  stage: "review",
  session: { role: "debate-stateful" satisfies SessionRole, lifetime: "fresh" },
  config: debateConfigSelector,
  model: (input) => ({ agent: input.debater.agent, model: input.debater.model ?? "fast" }),
  timeoutMs: (_input, ctx) => (ctx.config.debate?.stages?.review?.timeoutSeconds ?? 600) * 1000,
  async hopBody(initialPrompt, ctx) {
    const proposal = ctx.input.turnSemaphore
      ? await ctx.input.turnSemaphore.run(() => ctx.send(initialPrompt))
      : await ctx.send(initialPrompt);
    ctx.input.proposalBarriers[ctx.input.index].resolve(proposal.output);
    if (ctx.input.skipRebuttal) {
      return proposal;
    }

    const peerProposals = await raceAgainstAbort(
      Promise.all(ctx.input.proposalBarriers.map((barrier) => barrier.promise)),
      ctx.input.signal,
      ctx.input.storyId,
    );

    return ctx.input.turnSemaphore
      ? ctx.input.turnSemaphore.run(() => ctx.send(ctx.input.buildRebutPrompt(peerProposals)))
      : ctx.send(ctx.input.buildRebutPrompt(peerProposals));
  },
  build(input, _ctx) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.proposePrompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    return {
      success: !output.startsWith('Agent "'),
      rebut: output,
    };
  },
};
