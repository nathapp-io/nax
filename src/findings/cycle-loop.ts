/**
 * runFixCycle — loop-carried state and the phases' shared vocabulary.
 *
 * Extracted from cycle.ts (600-line source limit) when the fix cycle's
 * while-loop split into named phase functions (complexity drain A10). The
 * frame holds everything that is fixed for the cycle's lifetime; the loop
 * state holds everything the iterations mutate.
 *
 * MUTATE-IN-PLACE: `CycleLoopState` is threaded by reference through every
 * phase and mutated in place — a phase never hands a fresh state object back.
 * Two facts about this loop force that shape: `recordIteration` appends to
 * `cycle.iterations` between the selection gates and the give-up phase's
 * history re-read (so gates' and give-up's histories must be derived from the
 * live cycle, not cached), and a strategy's UNRESOLVED detail — set
 * mid-iteration — must be visible to `finishExit` on whichever failing exit
 * the cycle eventually reaches. This is the same discipline as turn-loop.ts's
 * `TurnLoopState` (complexity drain A2): any mid-loop throw or cross-phase
 * closure would lose a copy-out-and-return state.
 *
 * scope: repo-scoped (pure bookkeeping; no I/O)
 */

import type { Logger } from "@/logger";
import type { DispatchLogContext } from "./cycle-dispatch";
import type { DeclineLedger } from "./cycle-retirement";
import type {
  CallOpFn,
  FixApplied,
  FixCycle,
  FixCycleContext,
  FixCycleResult,
  FixStrategy,
  Iteration,
} from "./cycle-types";
import type { Finding } from "./types";

/** Everything fixed for the cycle's lifetime, resolved once in runFixCycle's prologue. */
export interface CycleFrame<F extends Finding> {
  cycle: FixCycle<F>;
  ctx: FixCycleContext;
  logger: Logger | null | undefined;
  /** Correlation triple every `findings.cycle` log line carries; `storyId` stays first. */
  logCtx: DispatchLogContext;
  /**
   * The resolved `callOp` seam — the caller's `_deps.callOp`, `_cycleDeps.callOp`,
   * or the real `callOp`. Resolved lazily at call time in the prologue so no
   * phase module needs a static `@/operations` edge (that import closes a
   * runtime import cycle — see docs/plans/STATUS-import-cycles-drain.md).
   */
  doCallOp: CallOpFn;
  /** Fresh correlation id per dispatch (#1932); injected for the same reason. */
  newCallId: () => string;
  now: () => string;
}

/**
 * The loop's mutable state, mutated IN PLACE by the phase functions (see the
 * module comment). `unresolvedDetail` is read by `finishExit` on every failing
 * exit; `totalCostUsd` accumulates the iteration spend at exactly the sites
 * the monolith accumulated it.
 */
export interface CycleLoopState<F extends Finding> {
  totalCostUsd: number;
  unresolvedDetail?: string;
  /**
   * Per-finding retirement ledger (#1369, #1384) — see `createDeclineLedger` for
   * why UNRESOLVED retires a (strategy, finding) pair rather than the strategy
   * itself, and for the termination argument.
   */
  declines: DeclineLedger<F>;
}

/** One dispatched iteration, shared by the post-dispatch phases. */
export interface DispatchedIteration<F extends Finding> {
  /** The execution group `selectExecutionGroup` picked for this iteration. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  group: FixStrategy<F, any, any, any>[];
  /** The active strategies that still had attempts left when the gates passed. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  uncappedActive: FixStrategy<F, any, any, any>[];
  /** Snapshot of `cycle.findings` taken before the dispatch ran. */
  findingsBefore: F[];
  fixesApplied: FixApplied[];
  startedAt: string;
}

/**
 * Attach the UNRESOLVED reason to whatever failing exit the cycle reaches.
 * Once a strategy has given up, that text is the most useful diagnostic
 * available no matter which exit fires afterwards — without this the detail is
 * lost as soon as the cycle exits via `no-strategy` or a cap instead of
 * `agent-gave-up`.
 *
 * Deliberately NOT applied to the two `resolved` exits: a sibling cleared the
 * findings, so reporting "the agent could not fix this" alongside a success
 * would misread as a partial failure.
 */
export function finishExit<F extends Finding>(state: CycleLoopState<F>, result: FixCycleResult<F>): FixCycleResult<F> {
  return state.unresolvedDetail !== undefined && result.unresolvedDetail === undefined
    ? { ...result, unresolvedDetail: state.unresolvedDetail }
    : result;
}

/**
 * Per-iteration concatenation of carried + this-cycle history. Cap checks,
 * the terminal-exhaustion counter, and bailWhen read this so carried
 * history participates in every accounting read site (US-002). `cycle.iterations`
 * and `FixCycleResult.iterations` keep their this-cycle meaning, so oscillation
 * counting and recordIteration's iterationNum are unaffected.
 */
export function buildHistory<F extends Finding>(cycle: FixCycle<F>): readonly Iteration<F>[] {
  return cycle.priorIterations ? [...cycle.priorIterations, ...cycle.iterations] : cycle.iterations;
}
