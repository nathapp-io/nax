/**
 * ADR-022 Phase 2 — runFixCycle and classifyOutcome.
 *
 * Sits above runRetryLoop: adds multi-strategy iteration, validator
 * deduplication, outcome classification, and cross-iteration history.
 *
 * runFixCycle itself is a sequencer: it resolves the injectable deps once,
 * then drives the loop through named phase functions — the pre-dispatch gates
 * (cycle-gates.ts), the dispatch (cycle-dispatch.ts), and the post-dispatch
 * phases (cycle-execute.ts). The loop's mutable state lives in a
 * `CycleLoopState` that every phase mutates in place (cycle-loop.ts), so an
 * early exit — or a throw escaping the dispatch — still leaves the accumulated
 * spend and any UNRESOLVED detail readable on the cycle object.
 *
 * scope: repo-scoped (cycle drives per-subsystem strategies; strategies
 * capture packageDir via closure in buildInput)
 */

import type { Logger } from "@/logger";
import { getSafeLogger } from "@/logger";
import { dispatchGroup } from "./cycle-dispatch";
import { handleGiveUps, liteValidateIfExhausted, validateRecordAndDecide } from "./cycle-execute";
import { earlyResolvedExit, selectIterationStrategies } from "./cycle-gates";
import type { CycleFrame, CycleLoopState, DispatchedIteration } from "./cycle-loop";
import { finishExit } from "./cycle-loop";
import { createDeclineLedger } from "./cycle-retirement";
import { selectExecutionGroup } from "./cycle-selection";
import type { CallOpFn, FixCycle, FixCycleContext, FixCycleResult } from "./cycle-types";
import type { Finding } from "./types";

// Re-exported so every existing import — including the `@/findings` barrel and
// `@/findings/cycle` — keeps working after classifyOutcome moved to
// ./classify-outcome.ts (nax#2154).
export { classifyOutcome } from "./classify-outcome";

// ─── Injectable deps (for testing) ───────────────────────────────────────────

// Declared in cycle-types.ts so cycle-dispatch.ts can name it without importing
// this module back (the import-cycle ratchet counts type-only edges too);
// re-exported here because that is where callers have always found it.
export type { CallOpFn } from "./cycle-types";

/**
 * Injectable deps. `callOp` is deliberately absent by default: binding it here
 * would need a static `@/operations` import, and that edge closes a runtime
 * import cycle (see docs/plans/STATUS-import-cycles-drain.md). `runFixCycle`
 * resolves the real `callOp` lazily at call time; set this field only to
 * override it.
 */
export const _cycleDeps: { callOp?: CallOpFn; now: () => string } = {
  now: () => new Date().toISOString(),
};

// ─── runFixCycle ─────────────────────────────────────────────────────────────

/**
 * Drive a fix cycle: select strategies, apply fixes, validate, classify outcome,
 * repeat until resolved or a budget/bail condition fires.
 *
 * The cycle object is mutated: `findings` and `iterations` are updated in place
 * so the caller can inspect partial progress if the run is interrupted.
 */
export async function runFixCycle<F extends Finding>(
  cycle: FixCycle<F>,
  ctx: FixCycleContext,
  cycleName: string,
  _deps: {
    callOp?: CallOpFn;
    now?: () => string;
    logger?: Logger | null;
    /** Caller-supplied map (strategy name -> set of declined findingKeys)
     *  so a later cycle inherits prior decline records (US-003). */
    declineBacking?: Map<string, Set<string>>;
  } = {},
): Promise<FixCycleResult<F>> {
  const logger = _deps.logger !== undefined ? _deps.logger : getSafeLogger();
  const ops = await import("@/operations");
  const doCallOp = _deps.callOp ?? _cycleDeps.callOp ?? (ops.callOp as unknown as CallOpFn);
  const newCallId = ops.newCorrelationId;
  const now = _deps.now ?? _cycleDeps.now;

  const frame: CycleFrame<F> = {
    cycle,
    ctx,
    logger,
    logCtx: { storyId: ctx.storyId, packageDir: ctx.packageDir, cycleName },
    doCallOp,
    newCallId,
    now,
  };
  const state: CycleLoopState<F> = {
    totalCostUsd: 0,
    declines: createDeclineLedger<F>(_deps.declineBacking),
  };

  for (;;) {
    const early = earlyResolvedExit(frame, state);
    if (early) return early;

    // ── Select active strategies + pre-dispatch gates ─────────────────────────
    const selection = selectIterationStrategies(frame, state);
    if (selection.action === "exit") return selection.result;

    // ── Execute strategies ────────────────────────────────────────────────────
    const group = selectExecutionGroup(selection.uncappedActive);
    const findingsBefore = [...cycle.findings];
    // Correlation ids, the session override and both halves of the dispatch's
    // spend live beside the dispatch they belong to (cycle-dispatch.ts). A throw
    // propagates unchanged (#1948) — except US-003's CALL_OP_NO_DISPATCH, which
    // becomes the zero-dispatch exit: nothing reached a model, so there is
    // nothing for validate to judge.
    const dispatch = await dispatchGroup({
      strategies: group,
      cycle,
      ctx,
      findingsBefore,
      spentBeforeUsd: state.totalCostUsd,
      deps: {
        callOp: frame.doCallOp,
        newCallId: frame.newCallId,
        logger: frame.logger,
        logCtx: frame.logCtx,
        now: frame.now,
      },
    });
    if (dispatch.kind === "no-dispatch") return finishExit(state, dispatch.result);
    const iteration: DispatchedIteration<F> = {
      group,
      uncappedActive: selection.uncappedActive,
      findingsBefore,
      fixesApplied: dispatch.fixesApplied,
      startedAt: dispatch.startedAt,
    };

    // ── Handle agent-gave-up ──────────────────────────────────────────────────
    const gaveUp = await handleGiveUps(frame, state, iteration);
    if (gaveUp.action === "exit") return gaveUp.result;
    if (gaveUp.action === "continue") continue;

    // ── Lite-validate on terminal exhausted iteration ─────────────────────────
    const lite = await liteValidateIfExhausted(frame, state, iteration);
    if (lite.action === "exit") return lite.result;
    if (lite.action === "continue") continue;

    // ── Validate, classify and record ─────────────────────────────────────────
    const terminal = await validateRecordAndDecide(frame, state, iteration);
    if (terminal.action === "exit") return terminal.result;
  }
}
