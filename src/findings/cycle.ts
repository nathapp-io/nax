/**
 * ADR-022 Phase 2 — runFixCycle and classifyOutcome.
 *
 * Sits above runRetryLoop: adds multi-strategy iteration, validator
 * deduplication, outcome classification, and cross-iteration history.
 *
 * scope: repo-scoped (cycle drives per-subsystem strategies; strategies
 * capture packageDir via closure in buildInput)
 */

import type { Logger } from "@/logger";
import { getSafeLogger } from "@/logger";
import type { Operation } from "@/operations";
import { callOp as _callOp } from "@/operations";
import { errorMessage } from "@/utils/errors";
import { recordIteration } from "./cycle-iteration-log";
import { createDeclineLedger } from "./cycle-retirement";
import {
  countStrategyAttempts,
  countTotalAttempts,
  hasRemainingClaimant,
  selectActiveStrategies,
  selectExecutionGroup,
} from "./cycle-selection";
import type {
  FixApplied,
  FixCycle,
  FixCycleContext,
  FixCycleResult,
  Iteration,
  IterationOutcome,
  ValidateResult,
} from "./cycle-types";
import type { Finding } from "./types";
import { findingRecurrenceKey } from "./types";

// ─── Injectable deps (for testing) ───────────────────────────────────────────

export type CallOpFn = <I, O, C>(ctx: FixCycleContext, op: Operation<I, O, C>, input: I) => Promise<O>;

export const _cycleDeps = {
  callOp: _callOp as unknown as CallOpFn,
  now: () => new Date().toISOString(),
};

function normalizeValidateResult<F extends Finding>(r: F[] | ValidateResult<F>): ValidateResult<F> {
  return Array.isArray(r) ? { findings: r, shortCircuited: false } : r;
}

// ─── classifyOutcome ─────────────────────────────────────────────────────────

/** Classify the outcome of a single iteration for one finding source. Uses findingRecurrenceKey (excludes message) so a reworded finding doesn't read as a spurious regression (nax#1581). */
function classifySingleSource<F extends Finding>(before: F[], after: F[]): IterationOutcome {
  const beforeKeys = new Set(before.map(findingRecurrenceKey));
  const afterKeys = new Set(after.map(findingRecurrenceKey));

  if (afterKeys.size === 0 && beforeKeys.size === 0) return "resolved";
  if (afterKeys.size === 0) return "resolved";

  // Check for new findings (regression)
  const hasNew = [...afterKeys].some((k) => !beforeKeys.has(k));
  const hasResolved = [...beforeKeys].some((k) => !afterKeys.has(k));

  if (hasNew && !hasResolved) return "regressed";
  if (!hasNew && !hasResolved) return "unchanged";
  if (hasNew && hasResolved) return "regressed"; // new ones appeared even if some resolved
  return "partial"; // hasResolved && !hasNew
}

/**
 * Classify an iteration outcome by computing per-source outcomes then
 * aggregating. Mixed cross-source comparisons are avoided: e.g. if before has
 * [lintA] and after has [typecheckC], that surfaces as "regressed-different-source"
 * because the lint source resolved but a new source appeared.
 */
export function classifyOutcome<F extends Finding>(before: F[], after: F[]): IterationOutcome {
  if (before.length === 0 && after.length === 0) return "resolved";
  // No prior findings — any new finding is a plain regression, not a source-switch.
  if (before.length === 0) return "regressed";

  const beforeSources = new Set(before.map((f) => f.source));
  const afterSources = new Set(after.map((f) => f.source));

  // Detect new sources appearing that weren't in before
  const newSources = [...afterSources].filter((s) => !beforeSources.has(s));
  if (newSources.length > 0) return "regressed-different-source";

  // Compute per-source outcomes for sources that existed before
  const sources = [...beforeSources];
  const perSource = sources.map((source) =>
    classifySingleSource(
      before.filter((f) => f.source === source),
      after.filter((f) => f.source === source),
    ),
  );

  if (perSource.every((o) => o === "resolved")) return "resolved";
  if (perSource.some((o) => o === "regressed")) return "regressed";
  if (perSource.every((o) => o === "unchanged")) return "unchanged";
  return "partial";
}

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
  const doCallOp = _deps.callOp ?? _cycleDeps.callOp;
  const now = _deps.now ?? _cycleDeps.now;

  const storyId = ctx.storyId;
  const packageDir = ctx.packageDir;
  /** Correlation triple every `findings.cycle` log line carries; `storyId` stays first. */
  const logCtx = { storyId, packageDir, cycleName };
  let totalCostUsd = 0;

  // Per-finding retirement ledger (#1369, #1384) — see `createDeclineLedger` for why
  // UNRESOLVED retires a (strategy, finding) pair rather than the strategy itself, and
  // for the termination argument.
  const declines = createDeclineLedger<F>(_deps.declineBacking);
  let unresolvedDetail: string | undefined;

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
  const finish = (result: FixCycleResult<F>): FixCycleResult<F> =>
    unresolvedDetail !== undefined && result.unresolvedDetail === undefined ? { ...result, unresolvedDetail } : result;

  for (;;) {
    if (cycle.findings.length === 0 && cycle.verdict === undefined) {
      return { iterations: cycle.iterations, finalFindings: [], exitReason: "resolved", costUsd: totalCostUsd };
    }

    // Per-iteration concatenation of carried + this-cycle history. Cap checks,
    // the terminal-exhaustion counter, and bailWhen read this so carried
    // history participates in every accounting read site (US-002). `cycle.iterations`
    // and `FixCycleResult.iterations` keep their this-cycle meaning, so oscillation
    // counting and recordIteration's iterationNum are unaffected.
    const history: readonly Iteration<F>[] = cycle.priorIterations
      ? [...cycle.priorIterations, ...cycle.iterations]
      : cycle.iterations;

    // ── Select active strategies ──────────────────────────────────────────────
    // A strategy is excluded only once it has declined every remaining finding it
    // claims — declining one finding must not retire it for the others (#1384).
    const selectable = cycle.strategies.filter((s) => !declines.isRetiredFor(s, cycle.findings));
    const active = selectActiveStrategies(selectable, cycle.findings, cycle.verdict);
    if (active.length === 0) {
      // Orphaned findings: at least one finding remains but no selectable
      // strategy's `appliesTo` claims it. Two distinct causes, and the log must
      // separate them or a reader chases the wrong one: either the `source` is
      // genuinely unhandled (a routing gap), or the only strategy that claimed
      // it was retired after answering UNRESOLVED (#1369). Surface both at warn
      // level — without this the cause is invisible, turning either into an
      // un-diagnosable "story failed for no reason".
      const orphanSources = [...new Set(cycle.findings.map((f) => f.source))];
      const retiredStrategies = declines.retiredNames(cycle.strategies, cycle.findings);
      logger?.warn("findings.cycle", "cycle exited — no matching strategy (orphaned findings)", {
        ...logCtx,
        reason: "no-strategy",
        findingsCount: cycle.findings.length,
        orphanSources,
        ...(retiredStrategies.length > 0 ? { retiredStrategies } : {}),
      });
      return finish({
        iterations: cycle.iterations,
        finalFindings: cycle.findings,
        exitReason: "no-strategy",
        costUsd: totalCostUsd,
      });
    }

    // ── Filter exhausted strategies ───────────────────────────────────────────
    // An exclusive strategy that exhausts its cap should not block uncapped
    // companions from running in subsequent iterations. Only exit when ALL
    // active strategies are exhausted (no uncapped companion can take over).
    const uncappedActive = active.filter((s) => countStrategyAttempts(history, s.name) < s.maxAttempts);
    if (uncappedActive.length === 0) {
      const exhaustedStrategy = active.find((s) => countStrategyAttempts(history, s.name) >= s.maxAttempts);
      logger?.info("findings.cycle", "cycle exited — all active strategies exhausted", {
        ...logCtx,
        reason: "max-attempts-per-strategy",
        exhaustedStrategy: exhaustedStrategy?.name,
      });
      return finish({
        iterations: cycle.iterations,
        finalFindings: cycle.findings,
        exitReason: "max-attempts-per-strategy",
        exhaustedStrategy: exhaustedStrategy?.name,
        costUsd: totalCostUsd,
      });
    }

    // ── Total attempt cap ─────────────────────────────────────────────────────
    const totalAttempts = countTotalAttempts(history);
    if (totalAttempts >= cycle.config.maxAttemptsTotal) {
      logger?.info("findings.cycle", "cycle exited — total attempt cap reached", {
        ...logCtx,
        reason: "max-attempts-total",
        totalAttempts,
        maxAttemptsTotal: cycle.config.maxAttemptsTotal,
      });
      return finish({
        iterations: cycle.iterations,
        finalFindings: cycle.findings,
        exitReason: "max-attempts-total",
        costUsd: totalCostUsd,
      });
    }

    // ── bailWhen predicates ───────────────────────────────────────────────────
    for (const strategy of uncappedActive) {
      const bailReason = strategy.bailWhen?.(history) ?? null;
      if (bailReason !== null) {
        // `bailDetail` is computed over `history`, which folds in iterations
        // carried from earlier cycles for this rung. Without the two counters
        // below, a bail that fires on purely inherited history reads as a
        // nonsense log — a detail quoting counts no iteration of THIS cycle
        // produced (#1530). Report where the numbers came from.
        const inheritedIterations = cycle.priorIterations?.length ?? 0;
        logger?.info("findings.cycle", "cycle exited — bail predicate fired", {
          ...logCtx,
          reason: "bail-when",
          strategyName: strategy.name,
          bailDetail: bailReason,
          cycleIterations: cycle.iterations.length,
          ...(inheritedIterations > 0 ? { inheritedIterations } : {}),
        });
        return finish({
          iterations: cycle.iterations,
          finalFindings: cycle.findings,
          exitReason: "bail-when",
          bailDetail: bailReason,
          costUsd: totalCostUsd,
        });
      }
    }

    // ── Execute strategies ────────────────────────────────────────────────────
    const group = selectExecutionGroup(uncappedActive);
    const startedAt = now();
    const findingsBefore = [...cycle.findings];
    const fixesApplied: FixApplied[] = [];

    for (const strategy of group) {
      const relevantFindings = findingsBefore.filter((f) => strategy.appliesTo(f));
      const input = strategy.buildInput(relevantFindings, cycle.iterations, ctx);
      const fixCtx: FixCycleContext = {
        ...ctx,
        fixStrategy: { name: strategy.name, findingsBefore: findingsBefore.length },
        // #1654: a strategy may run under its own session role, which gives it a
        // session of its own rather than continuing the one the previous
        // strategy used. `callOp` resolves `sessionOverride.role ?? op.session.role`,
        // so this isolates the dispatch without the op having to be duplicated.
        ...(strategy.sessionRole ? { sessionOverride: { role: strategy.sessionRole } } : {}),
      };
      const output = await doCallOp(fixCtx, strategy.fixOp, input);
      const extracted = await (strategy.extractApplied?.(output, input) ?? {});
      fixesApplied.push({
        strategyName: strategy.name,
        op: strategy.fixOp.name,
        targetFiles: extracted.targetFiles ?? [],
        summary: extracted.summary ?? "",
        ...(extracted.unresolved ? { unresolved: extracted.unresolved } : {}),
        costUsd: extracted.costUsd,
      });
    }

    // ── Handle agent-gave-up ──────────────────────────────────────────────────
    // Must run before the cap-exhausted skip-validate check: if the agent signals
    // UNRESOLVED on its final attempt, agent-gave-up takes priority so the
    // unresolvedDetail is surfaced rather than silently folded into a cap-exit.
    //
    // UNRESOLVED is per-strategy, so the response depends on whether anyone else
    // in the group still ran (#1369):
    //
    //   - EVERY strategy that ran gave up  -> nothing was attempted that could
    //     have changed the tree, so revalidating would burn a full suite run to
    //     learn nothing. Exit immediately, as before.
    //
    //     This exit SURVIVES #1384's per-finding retirement, which looks wrong at a
    //     glance — surely a strategy that declined only finding A deserves another
    //     dispatch? It does not, here: nothing in the group touched the tree, so
    //     `validate` can only re-emit the findings that were already in the declined
    //     batch. There is no finding it could be re-dispatched FOR. The per-finding
    //     scope pays off on the other branch, where a sibling's work surfaces
    //     something new (US-006's barrel export).
    //   - SOME strategy ran without giving up -> its work may have resolved the
    //     findings. Retire only the strategies that gave up and fall through to
    //     validate, so the sibling's progress is measured instead of discarded.
    //     Previously the whole group was abandoned here with `finalFindings` still
    //     equal to `findingsBefore`, which reported the sibling's fix as no
    //     progress and (via rectificationExhausted) rolled the working tree back.
    const unresolvedFas = fixesApplied.filter((fa) => fa.unresolved);
    if (unresolvedFas.length > 0) {
      const firstUnresolved = unresolvedFas[0] as FixApplied;
      unresolvedDetail = firstUnresolved.unresolved;
      // Decline the findings that were IN that dispatch's input, not the strategy
      // as a whole (#1384).
      for (const fa of unresolvedFas) {
        const strategy = group.find((s) => s.name === fa.strategyName);
        if (strategy) declines.recordDeclined(strategy, findingsBefore);
      }

      const allGaveUp = unresolvedFas.length === fixesApplied.length;
      if (allGaveUp) {
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
          { storyId, packageDir, cycleName },
          logger,
        );
        // Every other exit accumulates the iteration's spend; this one used to
        // return before doing so, reporting costUsd: 0 for real spend (#1369).
        totalCostUsd += fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);

        // #1654: exiting here is right only when this group was the LAST claimant.
        // Skipping validation stays right either way — nothing touched the tree —
        // but when another strategy still claims these findings, has attempts
        // left, and has not itself been retired, the answer to "nothing changed"
        // is to dispatch that strategy, not to end the cycle. Without this, a
        // story-scoped rectifier declining a failing test as out-of-scope
        // deadlocks the story even though a repo-scoped strategy is registered
        // and willing. `declines` already holds this group's give-ups, so the
        // strategies that just declined cannot be re-selected and loop forever.
        const historyAfter: readonly Iteration<F>[] = cycle.priorIterations
          ? [...cycle.priorIterations, ...cycle.iterations]
          : cycle.iterations;
        const remains = hasRemainingClaimant(cycle.strategies, cycle.findings, declines, (s) =>
          countStrategyAttempts(historyAfter, s.name),
        );
        if (remains) {
          logger?.info("findings.cycle", "group gave up — falling through to a remaining claimant", {
            ...logCtx,
            strategyName: firstUnresolved.strategyName,
            unresolvedDetail: firstUnresolved.unresolved,
          });
          continue;
        }

        logger?.info("findings.cycle", "cycle exited — agent gave up", {
          ...logCtx,
          reason: "agent-gave-up",
          strategyName: firstUnresolved.strategyName,
          unresolvedDetail: firstUnresolved.unresolved,
        });
        return finish({
          iterations: cycle.iterations,
          finalFindings: cycle.findings,
          exitReason: "agent-gave-up",
          unresolvedDetail: firstUnresolved.unresolved,
          costUsd: totalCostUsd,
        });
      }

      logger?.info("findings.cycle", "strategy gave up — retired, continuing with co-run siblings", {
        ...logCtx,
        strategyName: firstUnresolved.strategyName,
        unresolvedDetail: firstUnresolved.unresolved,
        ranWithoutGivingUp: fixesApplied.filter((fa) => !fa.unresolved).map((fa) => fa.strategyName),
      });
    }

    // ── Lite-validate on terminal exhausted iteration ─────────────────────────
    // Count provisional attempts including this iteration's fixesApplied, without
    // constructing a fake Iteration<F> object (only fixesApplied is relevant here).
    const allExhausted = group.every((s) => {
      const prior = countStrategyAttempts(history, s.name);
      const current = fixesApplied.filter((fa) => fa.strategyName === s.name).length;
      return prior + current >= s.maxAttempts;
    });
    if (allExhausted) {
      // Accumulate once, up front, so every exit below reports this iteration's
      // spend. Previously only the `continue` path did, so the four terminal
      // exits in this branch under-reported cost the same way the agent-gave-up
      // exit did (#1369).
      totalCostUsd += fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);
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
          { storyId, packageDir, cycleName },
          logger,
        );
        logger?.warn("findings.cycle", "lite validate failed on terminal exhausted branch", {
          ...logCtx,
          error: errorMessage(err),
        });
        return finish({
          iterations: cycle.iterations,
          finalFindings: cycle.findings,
          exitReason: "max-attempts-per-strategy",
          exhaustedStrategy: group[0]?.name,
          costUsd: totalCostUsd,
        });
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
        { storyId, packageDir, cycleName },
        logger,
      );
      cycle.findings = liteFindingsAfter;

      if (liteFindingsAfter.length === 0 && !liteShortCircuited) {
        logger?.info("findings.cycle", "cycle exited — resolved after terminal lite validate", {
          ...logCtx,
          reason: "resolved",
        });
        return finish({
          iterations: cycle.iterations,
          finalFindings: [],
          exitReason: "resolved",
          costUsd: totalCostUsd,
        });
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
          continue;
        }
        logger?.info("findings.cycle", "cycle exited — validate short-circuited", {
          ...logCtx,
          reason: "validate-short-circuit",
          liteFindingsAfterCount: liteFindingsAfter.length,
        });
        return finish({
          iterations: cycle.iterations,
          finalFindings: liteFindingsAfter,
          exitReason: "validate-short-circuit",
          costUsd: totalCostUsd,
        });
      }

      logger?.info("findings.cycle", "cycle exited — strategy attempt cap reached (lite validate)", {
        ...logCtx,
        reason: "max-attempts-per-strategy",
        exhaustedStrategy: group[0]?.name,
        liteFindingsAfterCount: liteFindingsAfter.length,
      });
      return finish({
        iterations: cycle.iterations,
        finalFindings: liteFindingsAfter,
        exitReason: "max-attempts-per-strategy",
        exhaustedStrategy: group[0]?.name,
        costUsd: totalCostUsd,
      });
    }

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
          logger?.error("findings.cycle", "cycle exited — validator error", {
            storyId,
            packageDir,
            cycleName,
            reason: "validator-error",
            error: errorMessage(err),
          });
          return finish({
            iterations: cycle.iterations,
            finalFindings: cycle.findings,
            exitReason: "validator-error",
            costUsd: totalCostUsd,
          });
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
      { storyId, packageDir, cycleName },
      logger,
    );
    cycle.findings = findingsAfter;

    const iterationCostUsd = fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);
    totalCostUsd += iterationCostUsd;

    if (outcome === "resolved") {
      // A short-circuited full validate (stopped on a failing phase before the gate)
      // must never read as "resolved" — the false-green case this guards against.
      if (fullShortCircuited) {
        logger?.info("findings.cycle", "cycle exited — validate short-circuited", { ...logCtx });
        return finish({
          iterations: cycle.iterations,
          finalFindings: findingsAfter,
          exitReason: "validate-short-circuit",
          costUsd: totalCostUsd,
        });
      }
      return { iterations: cycle.iterations, finalFindings: [], exitReason: "resolved", costUsd: totalCostUsd };
    }
  }
}
