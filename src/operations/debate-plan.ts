import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { Debater } from "../debate/types";
import { type DebateTurnSemaphore, raceAgainstAbort } from "../debate/utils";
import type { SessionRole } from "../session/types";
import type { RunOperation } from "./types";

export interface DebatePlanInput {
  readonly debater: Debater;
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (peerProposals: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly rebuttalBarrier: PromiseWithResolvers<string>;
  readonly selectionSignal: Promise<{ readonly patchPrompt?: string }>;
  readonly signal: AbortSignal;
  readonly storyId: string;
  readonly outputPath: string;
  /** When explicitly false, skip the rebuttal send and resolve the rebuttal barrier with the proposal output. Default: true (rebuttal runs). */
  readonly includeHybridRebuttals?: boolean;
  readonly turnSemaphore?: DebateTurnSemaphore;
}

export interface DebatePlanOutput {
  readonly success: boolean;
  readonly rebut: string;
  readonly patched?: string;
}

export const planDebaterOp: RunOperation<DebatePlanInput, DebatePlanOutput, DebateConfig> = {
  kind: "run",
  name: "debate-plan",
  stage: "plan",
  session: { role: "debate-plan" satisfies SessionRole, lifetime: "fresh" },
  config: debateConfigSelector,
  model: (input) => ({ agent: input.debater.agent, model: input.debater.model ?? "fast" }),
  fileOutput: (input) => input.outputPath,
  async hopBody(initialPrompt, ctx) {
    const proposal = ctx.input.turnSemaphore
      ? await ctx.input.turnSemaphore.run(() => ctx.send(initialPrompt))
      : await ctx.send(initialPrompt);
    ctx.input.proposalBarriers[ctx.input.index].resolve(proposal.output);

    if (ctx.input.includeHybridRebuttals === false) {
      ctx.input.rebuttalBarrier.resolve(proposal.output);
      const decision = await raceAgainstAbort(ctx.input.selectionSignal, ctx.input.signal, ctx.input.storyId);
      const patchPrompt = decision.patchPrompt;
      if (!patchPrompt) return proposal;
      try {
        return ctx.input.turnSemaphore
          ? await ctx.input.turnSemaphore.run(() => ctx.send(patchPrompt))
          : await ctx.send(patchPrompt);
      } catch {
        return proposal;
      }
    }

    const peerProposals = await raceAgainstAbort(
      Promise.all(ctx.input.proposalBarriers.map((barrier) => barrier.promise)),
      ctx.input.signal,
      ctx.input.storyId,
    );

    const rebutResult = ctx.input.turnSemaphore
      ? await ctx.input.turnSemaphore.run(() => ctx.send(ctx.input.buildRebutPrompt(peerProposals)))
      : await ctx.send(ctx.input.buildRebutPrompt(peerProposals));
    ctx.input.rebuttalBarrier.resolve(rebutResult.output);

    const decision = await raceAgainstAbort(ctx.input.selectionSignal, ctx.input.signal, ctx.input.storyId);
    const patchPrompt = decision.patchPrompt;
    if (!patchPrompt) {
      return rebutResult;
    }

    try {
      return ctx.input.turnSemaphore
        ? await ctx.input.turnSemaphore.run(() => ctx.send(patchPrompt))
        : await ctx.send(patchPrompt);
    } catch {
      return rebutResult;
    }
  },
  build(input) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: input.proposePrompt, overridable: false },
    };
  },
  parse(output) {
    return {
      success: !output.startsWith('Agent "'),
      rebut: output,
    };
  },
};
