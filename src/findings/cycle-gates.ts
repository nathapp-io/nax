/**
 * runFixCycle — the pre-dispatch gates.
 *
 * Extracted from cycle.ts (600-line source limit) as part of complexity drain
 * A10. Each gate answers one question about whether the loop may continue and
 * what may run: is the cycle already clean (early resolved), does anything
 * claim the findings (no-strategy), does anyone still have attempts left
 * (per-strategy cap), is the total budget spent (max-attempts-total), and did
 * a bail predicate fire (bail-when). The dispatch itself stays in cycle.ts.
 *
 * Every failing exit applies `finishExit` here, at the same sites the monolith
 * called its `finish` closure — the two resolved exits are the exception and
 * never pass through it.
 *
 * scope: repo-scoped (pure over the cycle + ledger; the only I/O is logging)
 */

import type { CycleFrame, CycleLoopState } from "./cycle-loop";
import { buildHistory, finishExit } from "./cycle-loop";
import { countStrategyAttempts, countTotalAttempts, selectActiveStrategies } from "./cycle-selection";
import type { FixCycleResult, FixStrategy, Iteration } from "./cycle-types";
import type { Finding } from "./types";

/** A gate's verdict: end the cycle with `result`, or dispatch `uncappedActive`. */
export type GateSelection<F extends Finding> =
  | { action: "exit"; result: FixCycleResult<F> }
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  | { action: "dispatch"; uncappedActive: FixStrategy<F, any, any, any>[] };

/**
 * The loop-top resolved check: nothing left to fix and no verdict to act on.
 * Returns the resolved result WITHOUT `finishExit` — deliberately, as for the
 * other resolved exit (see `finishExit`).
 */
export function earlyResolvedExit<F extends Finding>(
  frame: CycleFrame<F>,
  state: CycleLoopState<F>,
): FixCycleResult<F> | null {
  if (frame.cycle.findings.length === 0 && frame.cycle.verdict === undefined) {
    return {
      iterations: frame.cycle.iterations,
      finalFindings: [],
      exitReason: "resolved",
      costUsd: state.totalCostUsd,
    };
  }
  return null;
}

/**
 * Run every pre-dispatch gate, in the monolith's order. Returning `dispatch`
 * hands the uncapped active strategies to the sequencer, which picks the
 * execution group and dispatches.
 */
export function selectIterationStrategies<F extends Finding>(
  frame: CycleFrame<F>,
  state: CycleLoopState<F>,
): GateSelection<F> {
  const { cycle } = frame;
  const history = buildHistory(cycle);

  // ── Select active strategies ──────────────────────────────────────────────
  // A strategy is excluded only once it has declined every remaining finding it
  // claims — declining one finding must not retire it for the others (#1384).
  const selectable = cycle.strategies.filter((s) => !state.declines.isRetiredFor(s, cycle.findings));
  const active = selectActiveStrategies(selectable, cycle.findings, cycle.verdict);
  if (active.length === 0) return noStrategyExit(frame, state);

  // ── Filter exhausted strategies ───────────────────────────────────────────
  // An exclusive strategy that exhausts its cap should not block uncapped
  // companions from running in subsequent iterations. Only exit when ALL
  // active strategies are exhausted (no uncapped companion can take over).
  const uncappedActive = active.filter((s) => countStrategyAttempts(history, s.name) < s.maxAttempts);
  if (uncappedActive.length === 0) return exhaustedExit(frame, state, active);

  // ── Total attempt cap ─────────────────────────────────────────────────────
  if (countTotalAttempts(history) >= cycle.config.maxAttemptsTotal) return totalCapExit(frame, state);

  // ── bailWhen predicates ───────────────────────────────────────────────────
  const bail = firstBailCondition(uncappedActive, history);
  if (bail !== null) return bailWhenExit(frame, state, bail);

  return { action: "dispatch", uncappedActive };
}

/**
 * Orphaned findings: at least one finding remains but no selectable
 * strategy's `appliesTo` claims it. Two distinct causes, and the log must
 * separate them or a reader chases the wrong one: either the `source` is
 * genuinely unhandled (a routing gap), or the only strategy that claimed
 * it was retired after answering UNRESOLVED (#1369). Surface both at warn
 * level — without this the cause is invisible, turning either into an
 * un-diagnosable "story failed for no reason".
 */
function noStrategyExit<F extends Finding>(frame: CycleFrame<F>, state: CycleLoopState<F>): GateSelection<F> {
  const { cycle, logger, logCtx } = frame;
  const orphanSources = [...new Set(cycle.findings.map((f) => f.source))];
  const retiredStrategies = state.declines.retiredNames(cycle.strategies, cycle.findings);
  logger?.warn("findings.cycle", "cycle exited — no matching strategy (orphaned findings)", {
    ...logCtx,
    reason: "no-strategy",
    findingsCount: cycle.findings.length,
    orphanSources,
    ...(retiredStrategies.length > 0 ? { retiredStrategies } : {}),
  });
  return {
    action: "exit",
    result: finishExit(state, {
      iterations: cycle.iterations,
      finalFindings: cycle.findings,
      exitReason: "no-strategy",
      costUsd: state.totalCostUsd,
    }),
  };
}

function exhaustedExit<F extends Finding>(
  frame: CycleFrame<F>,
  state: CycleLoopState<F>,
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  active: FixStrategy<F, any, any, any>[],
): GateSelection<F> {
  const { cycle, logger, logCtx } = frame;
  const exhaustedStrategy = active.find((s) => countStrategyAttempts(buildHistory(cycle), s.name) >= s.maxAttempts);
  logger?.info("findings.cycle", "cycle exited — all active strategies exhausted", {
    ...logCtx,
    reason: "max-attempts-per-strategy",
    exhaustedStrategy: exhaustedStrategy?.name,
  });
  return {
    action: "exit",
    result: finishExit(state, {
      iterations: cycle.iterations,
      finalFindings: cycle.findings,
      exitReason: "max-attempts-per-strategy",
      exhaustedStrategy: exhaustedStrategy?.name,
      costUsd: state.totalCostUsd,
    }),
  };
}

function totalCapExit<F extends Finding>(frame: CycleFrame<F>, state: CycleLoopState<F>): GateSelection<F> {
  const { cycle, logger, logCtx } = frame;
  logger?.info("findings.cycle", "cycle exited — total attempt cap reached", {
    ...logCtx,
    reason: "max-attempts-total",
    totalAttempts: countTotalAttempts(buildHistory(cycle)),
    maxAttemptsTotal: cycle.config.maxAttemptsTotal,
  });
  return {
    action: "exit",
    result: finishExit(state, {
      iterations: cycle.iterations,
      finalFindings: cycle.findings,
      exitReason: "max-attempts-total",
      costUsd: state.totalCostUsd,
    }),
  };
}

interface BailCondition<F extends Finding> {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  strategy: FixStrategy<F, any, any, any>;
  bailReason: string;
}

/** The first strategy whose `bailWhen` predicate fires over `history`, if any. */
function firstBailCondition<F extends Finding>(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategies share a cycle; I/O are opaque here
  uncappedActive: FixStrategy<F, any, any, any>[],
  history: readonly Iteration<F>[],
): BailCondition<F> | null {
  for (const strategy of uncappedActive) {
    const bailReason = strategy.bailWhen?.(history) ?? null;
    if (bailReason !== null) return { strategy, bailReason };
  }
  return null;
}

function bailWhenExit<F extends Finding>(
  frame: CycleFrame<F>,
  state: CycleLoopState<F>,
  bail: BailCondition<F>,
): GateSelection<F> {
  const { cycle, logger, logCtx } = frame;
  // `bailDetail` is computed over `history`, which folds in iterations
  // carried from earlier cycles for this rung. Without the two counters
  // below, a bail that fires on purely inherited history reads as a
  // nonsense log — a detail quoting counts no iteration of THIS cycle
  // produced (#1530). Report where the numbers came from.
  const inheritedIterations = cycle.priorIterations?.length ?? 0;
  logger?.info("findings.cycle", "cycle exited — bail predicate fired", {
    ...logCtx,
    reason: "bail-when",
    strategyName: bail.strategy.name,
    bailDetail: bail.bailReason,
    cycleIterations: cycle.iterations.length,
    ...(inheritedIterations > 0 ? { inheritedIterations } : {}),
  });
  return {
    action: "exit",
    result: finishExit(state, {
      iterations: cycle.iterations,
      finalFindings: cycle.findings,
      exitReason: "bail-when",
      bailDetail: bail.bailReason,
      costUsd: state.totalCostUsd,
    }),
  };
}
