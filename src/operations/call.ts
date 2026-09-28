/**
 * callOp — the operation dispatch entry point.
 *
 * Since the A6 complexity drain (docs/plans/STATUS-complexity-drain.md) this
 * file is the thin orchestrator: it owns `_callOpDeps` (the test seam the
 * operations barrel re-exports by reference — it must stay HERE, phases take
 * it by reference as a `deps` parameter so tests can keep mutating its
 * properties) and `callOpDispatch`, which resolves the shared prologue and
 * branches to the kind-specific phase files:
 *
 * - `call-dispatch-prologue.ts` — shared resolution + shared error helpers
 * - `call-dispatch-complete.ts` — `kind:"complete"` (completeAsWithFallback + retries)
 * - `call-dispatch-run.ts`      — `kind:"run"` (runWithFallback + buildHopCallback)
 *
 * Behaviour lives in the phase files; do not grow this file — it is held
 * well under the 600-line gate on purpose.
 */

import { cancellableDelay } from "../utils/bun-deps";
import { buildHopCallback } from "./build-hop-callback";
import { dispatchCompleteOp } from "./call-dispatch-complete";
import { buildDispatchPrologue } from "./call-dispatch-prologue";
import { dispatchRunOp } from "./call-dispatch-run";
import type { CallContext, CompleteOperation, DeterministicOperation, Operation, RunOperation } from "./types";

/** Injectable deps for testability — mirrors _agentManagerDeps pattern. */
export const _callOpDeps = {
  sleep: (ms: number, signal?: AbortSignal) => cancellableDelay(ms, signal),
  /**
   * Seam over buildHopCallback so tests can observe the hopCtx literal this
   * function assembles. Without it nothing pins what callOp forwards — the
   * contextToolRunCounter threading was silently absent for exactly that reason.
   */
  buildHopCallback,
  readFileOutput: async (path: string) =>
    Bun.file(path)
      .text()
      .catch(() => null),
};

export async function callOp<I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> {
  if (op.kind === "deterministic" || ctx.scopeId !== undefined) {
    return callOpDispatch(ctx, op, input);
  }

  const scope = ctx.runtime.costAggregator.openScope();
  try {
    return await callOpDispatch({ ...ctx, scopeId: scope.scopeId }, op, input);
  } finally {
    scope.close();
  }
}

async function callOpDispatch<I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> {
  // Deterministic ops bypass all LLM dispatch, cost tracking, and session management.
  if (op.kind === "deterministic") {
    return (op as DeterministicOperation<I, O, C>).execute(input, ctx);
  }

  const prologue = buildDispatchPrologue(ctx, op, input);
  if (op.kind === "complete") {
    return dispatchCompleteOp({ ctx, op: op as CompleteOperation<I, O, C>, input, prologue, deps: _callOpDeps });
  }
  return dispatchRunOp({ ctx, op: op as RunOperation<I, O, C>, input, prologue, deps: _callOpDeps });
}

// attachOutcomeAdapterFailure moved to ./call-dispatch-run with the run-kind outcome
// ladder it serves; re-exported so its import path is unchanged.
export { attachOutcomeAdapterFailure } from "./call-dispatch-run";
// Post-parse verify/recover lives in ./post-parse; re-exported so the test seam keeps its
// long-standing "@/operations/call" import path.
export { _runPostParseForTest } from "./post-parse";
