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

import { callOp as _callOp } from "@/operations";
import { synthesisOp } from "@/operations";
import type { DebateSynthesisInput } from "@/operations/debate-synthesis";
import type { CallContext } from "@/operations/types";
import type { Selector, SelectorContext, SelectorResult } from "./types";

const RESOLVER_FALLBACK_AGENT = "synthesis";
const RESOLVER_FALLBACK_MODEL = "fast";

/** Injectable dependencies for the synthesis selector — allows tests to mock without mock.module() */
export const _synthesisDeps: {
  /**
   * Monomorphic on purpose: this module dispatches exactly one op, so the
   * inferred generic signature over-stated the seam and no stub could satisfy
   * it without a cast (#1514 callop-seam).
   */
  callOp: (ctx: CallContext, op: typeof synthesisOp, input: DebateSynthesisInput) => Promise<string>;
} = {
  callOp: _callOp,
};

export const synthesisSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const resolverAgent = ctx.stageConfig.resolver.agent ?? RESOLVER_FALLBACK_AGENT;
  const resolverModel = ctx.stageConfig.resolver.model ?? RESOLVER_FALLBACK_MODEL;
  const proposals = ctx.proposals.map((p) => p.output);

  const output = await _synthesisDeps.callOp(ctx.callContext, synthesisOp, {
    proposals,
    critiques: ctx.critiques,
    debaters: ctx.debaters,
    resolverAgent,
    resolverModel,
    promptSuffix: ctx.promptSuffix,
    timeoutSeconds: ctx.stageConfig.timeoutSeconds,
  });

  return {
    outcome: output.trim() ? "passed" : "failed",
    output,
  };
};
