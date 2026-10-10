/**
 * The `callOp` the rectification fix cycle dispatches through: every fix op runs
 * as a story-orchestrator phase (costs + outputs recorded), in the `rectify`
 * context stage. Extracted from `rectification.ts` (file-size limit).
 */
import type { FixCycleContext } from "@/findings";
import type { Operation, RunOperation } from "@/operations";
import { runPhase } from "./run-phase";
import type { AnySlot } from "./types";

export function makeRectificationCallOp(
  phaseCosts: Record<string, number>,
  fixOpPhaseOutputs: Record<string, unknown>,
  isThreeSession: boolean | undefined,
): <I, O, C>(cycleCtx: FixCycleContext, op: Operation<I, O, C>, input: I) => Promise<O> {
  return async <I, O, C>(cycleCtx: FixCycleContext, op: Operation<I, O, C>, input: I): Promise<O> => {
    // runFixCycle dispatches fixOps, which are Operation<I,O,C> (run or complete). The
    // builder's runPhase wrapper only needs op.name + dispatch, so widening the cast is safe.
    const slot: AnySlot = { op: op as unknown as RunOperation<unknown, unknown, unknown>, input };
    // inRectification=true so a fix-cycle `implementer` requests the `rectify`
    // context-engine stage (query_scratch) rather than `tdd-implementer` — see
    // contextStageForOp's precedence rule (nax#1737 Phase B follow-up).
    return (await runPhase(cycleCtx, slot, phaseCosts, fixOpPhaseOutputs, isThreeSession, undefined, true)) as O;
  };
}
