/**
 * runFixCycle — the post-dispatch phases of one iteration.
 *
 * Extracted from cycle.ts (600-line source limit) as part of complexity drain
 * A10. After the iteration's group has been dispatched, three phases decide
 * what the loop does next: `handleGiveUps` (UNRESOLVED accounting — retire,
 * fall through to a remaining claimant, or exit agent-gave-up),
 * `liteValidateIfExhausted` (the terminal-exhausted branch that skips the full
 * validate), and `validateRecordAndDecide` (full validate with retries,
 * classify, record, and the resolved / short-circuit terminal decision).
 *
 * The state argument is mutated IN PLACE (see cycle-loop.ts) — `totalCostUsd`
 * accumulation and `unresolvedDetail` assignment happen exactly where the
 * monolith performed them, so every exit reports the same numbers.
 *
 * scope: repo-scoped (validate callbacks are caller-supplied; no direct I/O)
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { classifyOutcome } from "./classify-outcome";
import { recordIteration } from "./cycle-iteration-log";
import type { CycleFrame, CycleLoopState, DispatchedIteration } from "./cycle-loop";
import { buildHistory, finishExit } from "./cycle-loop";
import { countStrategyAttempts, hasRemainingClaimant } from "./cycle-selection";
import type { FixApplied, FixCycleResult, GiveUpResolution, ValidateResult } from "./cycle-types";
import type { Finding } from "./types";

/** What the give-up phase wants the loop to do next. */
export type GiveUpVerdict<F extends Finding> =
  | { action: "exit"; result: FixCycleResult<F> }
  | { action: "continue" }
  | { action: "validate" };

/** What the lite-validate gate wants the loop to do next. */
export type LiteVerdict<F extends Finding> =
  | { action: "exit"; result: FixCycleResult<F> }
  | { action: "continue" }
  | { action: "full" };

/** What the full-validate phase wants the loop to do next. */
export type TerminalVerdict<F extends Finding> = { action: "exit"; result: FixCycleResult<F> } | { action: "loop" };

function normalizeValidateResult<F extends Finding>(r: F[] | ValidateResult<F>): ValidateResult<F> {
  return Array.isArray(r) ? { findings: r, shortCircuited: false } : r;
}

/**
 * Handle agent-gave-up. Must run before the cap-exhausted skip-validate check:
 * if the agent signals UNRESOLVED on its final attempt, agent-gave-up takes
 * priority so the unresolvedDetail is surfaced rather than silently folded into
 * a cap-exit.
 *
 * UNRESOLVED is per-strategy, so the response depends on whether anyone else
 * in the group still ran (#1369):
 *
 *   - EVERY strategy that ran gave up  -> nothing was attempted that could
 *     have changed the tree, so revalidating would burn a full suite run to
 *     learn nothing. Exit immediately, as before.
 *
 *     This exit SURVIVES #1384's per-finding retirement, which looks wrong at a
 *     glance — surely a strategy that declined only finding A deserves another
 *     dispatch? It does not, here: nothing in the group touched the tree, so
 *     `validate` can only re-emit the findings that were already in the declined
 *     batch. There is no finding it could be re-dispatched FOR. The per-finding
 *     scope pays off on the other branch, where a sibling's work surfaces
 *     something new (US-006's barrel export).
 *   - SOME strategy ran without giving up -> its work may have resolved the
 *     findings. Retire only the strategies that gave up and fall through to
 *     validate, so the sibling's progress is measured instead of discarded.
 *     Previously the whole group was abandoned here with `finalFindings` still
 *     equal to `findingsBefore`, which reported the sibling's fix as no
 *     progress and (via rectificationExhausted) rolled the working tree back.
 */
export async function handleGiveUps<F extends Finding>(
  frame: CycleFrame<F>,
  state: CycleLoopState<F>,
  it: DispatchedIteration<F>,
): Promise<GiveUpVerdict<F>> {
  const { cycle, logger, logCtx, now } = frame;
  const { group, findingsBefore, fixesApplied, startedAt } = it;
  const unresolvedFas = fixesApplied.filter((fa) => fa.unresolved);
  if (unresolvedFas.length === 0) return { action: "validate" };

  const firstUnresolved = unresolvedFas[0] as FixApplied;
  state.unresolvedDetail = firstUnresolved.unresolved;
  // Decline the findings that were IN that dispatch's input, not the strategy
  // as a whole (#1384).
  for (const fa of unresolvedFas) {
    const strategy = group.find((s) => s.name === fa.strategyName);
    if (strategy) state.declines.recordDeclined(strategy, findingsBefore);
  }

  const allGaveUp = unresolvedFas.length === fixesApplied.length;
  if (!allGaveUp) {
    logger?.info("findings.cycle", "strategy gave up — retired, continuing with co-run siblings", {
      ...logCtx,
      strategyName: firstUnresolved.strategyName,
      unresolvedDetail: firstUnresolved.unresolved,
      ranWithoutGivingUp: fixesApplied.filter((fa) => !fa.unresolved).map((fa) => fa.strategyName),
    });
    return { action: "validate" };
  }

  const finishedAt = now();
  recordIteration(
    cycle,
    {
      findingsBefore,
      fixesApplied,
      findingsAfter: cycle.findings,
      outcome: "unchanged",
      startedAt,
      finishedAt,
    },
    logCtx,
    logger,
  );
  // Every other exit accumulates the iteration's spend; this one used to
  // return before doing so, reporting costUsd: 0 for real spend (#1369).
  state.totalCostUsd += fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);

  // #1654: exiting here is right only when this group was the LAST claimant.
  // Skipping validation stays right either way — nothing touched the tree —
  // but when another strategy still claims these findings, has attempts
  // left, and has not itself been retired, the answer to "nothing changed"
  // is to dispatch that strategy, not to end the cycle. Without this, a
  // story-scoped rectifier declining a failing test as out-of-scope
  // deadlocks the story even though a repo-scoped strategy is registered
  // and willing. `declines` already holds this group's give-ups, so the
  // strategies that just declined cannot be re-selected and loop forever.
  // The history is rebuilt AFTER the recordIteration above, so the attempt
  // this iteration just spent participates in the remaining-claimant check.
  const historyAfter = buildHistory(cycle);
  const remains = hasRemainingClaimant(cycle.strategies, cycle.findings, state.declines, (s) =>
    countStrategyAttempts(historyAfter, s.name),
  );
  if (remains) {
    logger?.info("findings.cycle", "group gave up — falling through to a remaining claimant", {
      ...logCtx,
      strategyName: firstUnresolved.strategyName,
      unresolvedDetail: firstUnresolved.unresolved,
    });
    return { action: "continue" };
  }

  const advised = await consultGiveUpHook(frame, state, unresolvedFas, historyAfter);
  if (advised.action === "continue") return advised;
  const unresolvedDetail = advised.detailSuffix
    ? `${firstUnresolved.unresolved} ${advised.detailSuffix}`
    : (firstUnresolved.unresolved as string);
  state.unresolvedDetail = unresolvedDetail;

  logger?.info("findings.cycle", "cycle exited — agent gave up", {
    ...logCtx,
    reason: "agent-gave-up",
    strategyName: firstUnresolved.strategyName,
    unresolvedDetail,
  });
  return {
    action: "exit",
    result: finishExit(state, {
      iterations: cycle.iterations,
      finalFindings: cycle.findings,
      exitReason: "agent-gave-up",
      unresolvedDetail,
      costUsd: state.totalCostUsd,
    }),
  };
}

/**
 * A1: give the caller's `onGiveUp` hook (if any) the chance to resolve a
 * give-up the #1654 fall-through could not. A throw is logged and treated as
 * "no resolution" — the cycle exits exactly as before.
 */
async function consultGiveUpHook<F extends Finding>(
  frame: CycleFrame<F>,
  state: CycleLoopState<F>,
  unresolvedFas: readonly FixApplied[],
  history: ReturnType<typeof buildHistory>,
): Promise<{ action: "continue" } | { action: "exit"; detailSuffix?: string }> {
  const { cycle, logger, logCtx } = frame;
  if (!cycle.onGiveUp) return { action: "exit" };
  const attemptsLeft = Object.fromEntries(
    cycle.strategies.map((s) => [s.name, Math.max(0, s.maxAttempts - countStrategyAttempts(history, s.name))]),
  );
  let resolution: GiveUpResolution<F> | null = null;
  try {
    resolution = await cycle.onGiveUp({
      findings: cycle.findings,
      gaveUp: unresolvedFas.map((fa) => ({ strategyName: fa.strategyName, unresolvedDetail: fa.unresolved ?? "" })),
      attemptsLeft,
      totalAttemptsLeft: Math.max(0, cycle.config.maxAttemptsTotal - history.length),
    });
  } catch (err) {
    logger?.warn("findings.cycle", "onGiveUp hook threw — exiting as agent-gave-up", {
      ...logCtx,
      error: errorMessage(err),
    });
  }
  if (!resolution) return { action: "exit" };
  if (resolution.exit) return { action: "exit", detailSuffix: resolution.exit.detailSuffix };
  cycle.findings = resolution.findings;
  for (const name of resolution.reinstate) state.declines.clearDeclined(name, resolution.findings);
  logger?.info("findings.cycle", "give-up resolved by the caller — continuing", {
    ...logCtx,
    reinstated: [...resolution.reinstate],
    findings: resolution.findings.length,
  });
  return { action: "continue" };
}

/**
 * Lite-validate on the terminal exhausted iteration. Runs only when every
 * strategy in the group has spent its cap counting this iteration's
 * fixesApplied; otherwise the loop proceeds to the full validate.
 */
export async function liteValidateIfExhausted<F extends Finding>(
  frame: CycleFrame<F>,
  state: CycleLoopState<F>,
  it: DispatchedIteration<F>,
): Promise<LiteVerdict<F>> {
  const { cycle, ctx, logger, logCtx, now } = frame;
  const { group, uncappedActive, findingsBefore, fixesApplied, startedAt } = it;

  // Count provisional attempts including this iteration's fixesApplied, without
  // constructing a fake Iteration<F> object (only fixesApplied is relevant here).
  const history = buildHistory(cycle);
  const allExhausted = group.every((s) => {
    const prior = countStrategyAttempts(history, s.name);
    const current = fixesApplied.filter((fa) => fa.strategyName === s.name).length;
    return prior + current >= s.maxAttempts;
  });
  if (!allExhausted) return { action: "full" };

  // Accumulate once, up front, so every exit below reports this iteration's
  // spend. Previously only the `continue` path did, so the four terminal
  // exits in this branch under-reported cost the same way the agent-gave-up
  // exit did (#1369).
  state.totalCostUsd += fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);

  let liteFindingsAfter: F[];
  let liteShortCircuited = false;
  try {
    const liteRaw = await cycle.validate(ctx, { mode: "lite", strategiesRun: group.map((s) => s.name) });
    const liteResult = normalizeValidateResult(liteRaw);
    liteFindingsAfter = liteResult.findings as F[];
    liteShortCircuited = liteResult.shortCircuited ?? false;
  } catch (err) {
    const finishedAt = now();
    recordIteration(
      cycle,
      {
        findingsBefore,
        fixesApplied,
        findingsAfter: cycle.findings,
        outcome: "unchanged",
        startedAt,
        finishedAt,
      },
      logCtx,
      logger,
    );
    logger?.warn("findings.cycle", "lite validate failed on terminal exhausted branch", {
      ...logCtx,
      error: errorMessage(err),
    });
    return {
      action: "exit",
      result: finishExit(state, {
        iterations: cycle.iterations,
        finalFindings: cycle.findings,
        exitReason: "max-attempts-per-strategy",
        exhaustedStrategy: group[0]?.name,
        costUsd: state.totalCostUsd,
      }),
    };
  }

  const outcome = classifyOutcome(findingsBefore, liteFindingsAfter);
  const finishedAt = now();
  recordIteration(
    cycle,
    {
      findingsBefore,
      fixesApplied,
      findingsAfter: liteFindingsAfter,
      outcome,
      startedAt,
      finishedAt,
    },
    logCtx,
    logger,
  );
  cycle.findings = liteFindingsAfter;

  if (liteFindingsAfter.length === 0 && !liteShortCircuited) {
    logger?.info("findings.cycle", "cycle exited — resolved after terminal lite validate", {
      ...logCtx,
      reason: "resolved",
    });
    // A resolved exit: deliberately not passed through finishExit.
    return {
      action: "exit",
      result: {
        iterations: cycle.iterations,
        finalFindings: [],
        exitReason: "resolved",
        costUsd: state.totalCostUsd,
      },
    };
  }

  if (liteShortCircuited) {
    // If uncapped companion strategies exist outside this group, let them
    // run in the next iteration rather than exiting. The exclusive strategy
    // exhausted but a co-run companion (e.g. autofix-implementer after
    // mechanical-lintfix) may still be able to resolve the findings.
    const companions = uncappedActive.filter((s) => !group.includes(s));
    if (companions.length > 0) {
      // Cost already accumulated at the top of this branch.
      logger?.info("findings.cycle", "exclusive strategy exhausted — continuing to companion strategies", {
        ...logCtx,
        exhaustedStrategies: group.map((s) => s.name),
        remainingStrategies: companions.map((s) => s.name),
      });
      return { action: "continue" };
    }
    logger?.info("findings.cycle", "cycle exited — validate short-circuited", {
      ...logCtx,
      reason: "validate-short-circuit",
      liteFindingsAfterCount: liteFindingsAfter.length,
    });
    return {
      action: "exit",
      result: finishExit(state, {
        iterations: cycle.iterations,
        finalFindings: liteFindingsAfter,
        exitReason: "validate-short-circuit",
        costUsd: state.totalCostUsd,
      }),
    };
  }

  logger?.info("findings.cycle", "cycle exited — strategy attempt cap reached (lite validate)", {
    ...logCtx,
    reason: "max-attempts-per-strategy",
    exhaustedStrategy: group[0]?.name,
    liteFindingsAfterCount: liteFindingsAfter.length,
  });
  return {
    action: "exit",
    result: finishExit(state, {
      iterations: cycle.iterations,
      finalFindings: liteFindingsAfter,
      exitReason: "max-attempts-per-strategy",
      exhaustedStrategy: group[0]?.name,
      costUsd: state.totalCostUsd,
    }),
  };
}

/**
 * Full validate with retries, then classify, record, and decide the terminal
 * exits. `recordIteration` appends to `cycle.iterations` and `cycle.findings`
 * is updated BEFORE the terminal decision, exactly as the monolith ordered it,
 * so a caller inspecting partial progress after a throw sees the same state.
 */
export async function validateRecordAndDecide<F extends Finding>(
  frame: CycleFrame<F>,
  state: CycleLoopState<F>,
  it: DispatchedIteration<F>,
): Promise<TerminalVerdict<F>> {
  const { cycle, ctx, logger, logCtx, now } = frame;
  const { group, findingsBefore, fixesApplied, startedAt } = it;

  // ── Validate ──────────────────────────────────────────────────────────────
  let findingsAfter: F[];
  let fullShortCircuited = false;
  let validatorAttempt = 0;
  for (;;) {
    try {
      const fullRaw = await cycle.validate(ctx, { mode: "full", strategiesRun: group.map((s) => s.name) });
      const fullResult = normalizeValidateResult(fullRaw);
      findingsAfter = fullResult.findings as F[];
      fullShortCircuited = fullResult.shortCircuited ?? false;
      break;
    } catch (err) {
      if (validatorAttempt >= cycle.config.validatorRetries) {
        // Accumulate this iteration's spend before exiting, mirroring
        // handleGiveUps and liteValidateIfExhausted (#1369). No recordIteration
        // call here: validation threw, so there is no post-dispatch findingsAfter
        // to pass to it, and a fabricated outcome would feed a false signal to
        // the oscillation counter, the curator, and the strategy-attempt history.
        // Prior completed iterations' costs were already accumulated in their
        // respective passes through this function.
        const iterationCostUsd = fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);
        state.totalCostUsd += iterationCostUsd;
        logger?.error("findings.cycle", "cycle exited — validator error", {
          storyId: logCtx.storyId,
          packageDir: logCtx.packageDir,
          cycleName: logCtx.cycleName,
          reason: "validator-error",
          strategiesRun: group.map((s) => s.name),
          iterationCostUsd,
          error: errorMessage(err),
        });
        return {
          action: "exit",
          result: finishExit(state, {
            iterations: cycle.iterations,
            finalFindings: cycle.findings,
            exitReason: "validator-error",
            costUsd: state.totalCostUsd,
          }),
        };
      }
      logger?.warn("findings.cycle", "validator retry", {
        ...logCtx,
        attempt: validatorAttempt + 1,
        error: errorMessage(err),
      });
      validatorAttempt++;
    }
  }

  // ── Classify and record ───────────────────────────────────────────────────
  const outcome = classifyOutcome(findingsBefore, findingsAfter);
  const finishedAt = now();
  recordIteration(
    cycle,
    {
      findingsBefore,
      fixesApplied,
      findingsAfter,
      outcome,
      startedAt,
      finishedAt,
    },
    logCtx,
    logger,
  );
  cycle.findings = findingsAfter;

  const iterationCostUsd = fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);
  state.totalCostUsd += iterationCostUsd;

  if (outcome === "resolved") {
    // A short-circuited full validate (stopped on a failing phase before the gate)
    // must never read as "resolved" — the false-green case this guards against.
    if (fullShortCircuited) {
      logger?.info("findings.cycle", "cycle exited — validate short-circuited", { ...logCtx });
      return {
        action: "exit",
        result: finishExit(state, {
          iterations: cycle.iterations,
          finalFindings: findingsAfter,
          exitReason: "validate-short-circuit",
          costUsd: state.totalCostUsd,
        }),
      };
    }
    // A resolved exit: deliberately not passed through finishExit.
    return {
      action: "exit",
      result: {
        iterations: cycle.iterations,
        finalFindings: [],
        exitReason: "resolved",
        costUsd: state.totalCostUsd,
      },
    };
  }
  return { action: "loop" };
}
