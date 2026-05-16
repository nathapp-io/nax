/**
 * Judge selector strategy.
 *
 * Dispatches via callOp(ctx.callContext, judgeOp, …) — audit, cost, and retry
 * middleware fire through the standard operation layer.
 *
 * Compat note: callJudgeComplete has been moved to src/debate/resolvers.ts so that
 * resolvers.ts can call agentManager.completeAs without this file doing so directly.
 * The debate barrel (index.ts) continues to re-export callJudgeComplete from resolvers.
 */

import { callOp } from "@/operations";
import { judgeOp } from "@/operations";
import type { Selector, SelectorContext, SelectorResult } from "./types";

const RESOLVER_FALLBACK_AGENT = "synthesis";
const RESOLVER_FALLBACK_MODEL = "fast";

export const judgeSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const resolverAgent = ctx.stageConfig.resolver.agent ?? RESOLVER_FALLBACK_AGENT;
  const resolverModel = ctx.stageConfig.resolver.model ?? RESOLVER_FALLBACK_MODEL;
  const proposals = ctx.proposals.map((p) => p.output);

  const output = await callOp(ctx.callContext, judgeOp, {
    proposals,
    critiques: ctx.critiques,
    debaters: ctx.debaters,
    resolverAgent,
    resolverModel,
  });

  return {
    outcome: output.trim() ? "passed" : "failed",
    output,
  };
};
