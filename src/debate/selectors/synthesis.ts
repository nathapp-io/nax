/**
 * Synthesis selector strategy.
 *
 * Dispatches via callOp(ctx.callContext, synthesisOp, …) — audit, cost, and retry
 * middleware fire through the standard operation layer.
 *
 * Compat note: callSynthesisComplete has been moved to src/debate/resolvers.ts so
 * that resolvers.ts can call agentManager.completeAs without this file doing so
 * directly. The debate barrel (index.ts) continues to re-export callSynthesisComplete
 * from resolvers.
 */

import { callOp } from "@/operations";
import { synthesisOp } from "@/operations";
import type { Selector, SelectorContext, SelectorResult } from "./types";

const RESOLVER_FALLBACK_AGENT = "synthesis";
const RESOLVER_FALLBACK_MODEL = "fast";

export const synthesisSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const resolverAgent = ctx.stageConfig.resolver.agent ?? RESOLVER_FALLBACK_AGENT;
  const resolverModel = ctx.stageConfig.resolver.model ?? RESOLVER_FALLBACK_MODEL;
  const proposals = ctx.proposals.map((p) => p.output);

  let resolverCostUsd = 0;
  const callCtx = {
    ...ctx.callContext,
    onCostAccumulated: (c: number) => {
      resolverCostUsd += c;
    },
  };

  const output = await callOp(callCtx, synthesisOp, {
    proposals,
    critiques: ctx.critiques,
    debaters: ctx.debaters,
    resolverAgent,
    resolverModel,
    promptSuffix: ctx.promptSuffix,
  });

  return {
    outcome: output.trim() ? "passed" : "failed",
    output,
    resolverCostUsd,
  };
};
