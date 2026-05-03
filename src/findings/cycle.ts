/**
 * ADR-022 Phase 2 — runFixCycle and classifyOutcome.
 *
 * Sits above runRetryLoop: adds multi-strategy iteration, validator
 * deduplication, outcome classification, and cross-iteration history.
 *
 * scope: repo-scoped (cycle drives per-subsystem strategies; strategies
 * capture packageDir via closure in buildInput)
 */

import { getSafeLogger } from "../logger";
import { callOp as _callOp } from "../operations/call";
import type { Operation } from "../operations/types";
import { errorMessage } from "../utils/errors";
import type {
  FixApplied,
  FixCycle,
  FixCycleContext,
  FixCycleResult,
  FixStrategy,
  Iteration,
  IterationOutcome,
} from "./cycle-types";
import type { Finding } from "./types";
import { findingKey } from "./types";

// ─── Injectable deps (for testing) ───────────────────────────────────────────

export type CallOpFn = <I, O, C>(ctx: FixCycleContext, op: Operation<I, O, C>, input: I) => Promise<O>;

export const _cycleDeps = {
  callOp: _callOp as unknown as CallOpFn,
  now: () => new Date().toISOString(),
};

// ─── classifyOutcome ─────────────────────────────────────────────────────────

/**
 * Classify the outcome of a single iteration for one finding source.
 * Uses findingKey for stable identity.
 */
function classifySingleSource<F extends Finding>(before: F[], after: F[]): IterationOutcome {
  const beforeKeys = new Set(before.map(findingKey));
  const afterKeys = new Set(after.map(findingKey));

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

// ─── Strategy selection ───────────────────────────────────────────────────────

function selectActiveStrategies<F extends Finding>(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are opaque to the cycle
  strategies: FixStrategy<F, any, any, any>[],
  findings: F[],
  verdict: string | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: see above
): FixStrategy<F, any, any, any>[] {
  if (findings.length > 0) {
    return strategies.filter((s) => findings.some((f) => s.appliesTo(f)));
  }
  if (verdict !== undefined) {
    return strategies.filter((s) => s.appliesToVerdict?.(verdict) ?? false);
  }
  return [];
}

function selectExecutionGroup<F extends Finding>(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are opaque to the cycle
  active: FixStrategy<F, any, any, any>[],
  // biome-ignore lint/suspicious/noExplicitAny: see above
): FixStrategy<F, any, any, any>[] {
  const exclusive = active.find((s) => !s.coRun || s.coRun === "exclusive");
  if (exclusive) return [exclusive];
  return active.filter((s) => s.coRun === "co-run-sequential");
}

// ─── Attempt counting ────────────────────────────────────────────────────────

function countStrategyAttempts<F extends Finding>(iterations: Iteration<F>[], strategyName: string): number {
  return iterations.reduce(
    (sum, iter) => sum + iter.fixesApplied.filter((fa) => fa.strategyName === strategyName).length,
    0,
  );
}

function countTotalAttempts<F extends Finding>(iterations: Iteration<F>[]): number {
  return iterations.reduce((sum, iter) => sum + iter.fixesApplied.length, 0);
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
  _deps: { callOp?: CallOpFn; now?: () => string } = {},
): Promise<FixCycleResult<F>> {
  const logger = getSafeLogger();
  const doCallOp = _deps.callOp ?? _cycleDeps.callOp;
  const now = _deps.now ?? _cycleDeps.now;

  const storyId = ctx.storyId;
  const packageDir = ctx.packageDir;
  let totalCostUsd = 0;

  for (;;) {
    // ── Select active strategies ──────────────────────────────────────────────
    const active = selectActiveStrategies(cycle.strategies, cycle.findings, cycle.verdict);
    if (active.length === 0) {
      logger?.info("findings.cycle", "cycle exited — no matching strategy", {
        storyId,
        packageDir,
        cycleName,
        reason: "no-strategy",
        findingsCount: cycle.findings.length,
      });
      return {
        iterations: cycle.iterations,
        finalFindings: cycle.findings,
        exitReason: "no-strategy",
        costUsd: totalCostUsd,
      };
    }

    // ── Per-strategy attempt cap ──────────────────────────────────────────────
    for (const strategy of active) {
      const attempts = countStrategyAttempts(cycle.iterations, strategy.name);
      if (attempts >= strategy.maxAttempts) {
        logger?.info("findings.cycle", "cycle exited — strategy attempt cap reached", {
          storyId,
          packageDir,
          cycleName,
          reason: "max-attempts-per-strategy",
          exhaustedStrategy: strategy.name,
          attempts,
          maxAttempts: strategy.maxAttempts,
        });
        return {
          iterations: cycle.iterations,
          finalFindings: cycle.findings,
          exitReason: "max-attempts-per-strategy",
          exhaustedStrategy: strategy.name,
          costUsd: totalCostUsd,
        };
      }
    }

    // ── Total attempt cap ─────────────────────────────────────────────────────
    const totalAttempts = countTotalAttempts(cycle.iterations);
    if (totalAttempts >= cycle.config.maxAttemptsTotal) {
      logger?.info("findings.cycle", "cycle exited — total attempt cap reached", {
        storyId,
        packageDir,
        cycleName,
        reason: "max-attempts-total",
        totalAttempts,
        maxAttemptsTotal: cycle.config.maxAttemptsTotal,
      });
      return {
        iterations: cycle.iterations,
        finalFindings: cycle.findings,
        exitReason: "max-attempts-total",
        costUsd: totalCostUsd,
      };
    }

    // ── bailWhen predicates ───────────────────────────────────────────────────
    for (const strategy of active) {
      const bailReason = strategy.bailWhen?.(cycle.iterations) ?? null;
      if (bailReason !== null) {
        logger?.info("findings.cycle", "cycle exited — bail predicate fired", {
          storyId,
          packageDir,
          cycleName,
          reason: "bail-when",
          strategyName: strategy.name,
          bailDetail: bailReason,
        });
        return {
          iterations: cycle.iterations,
          finalFindings: cycle.findings,
          exitReason: "bail-when",
          bailDetail: bailReason,
          costUsd: totalCostUsd,
        };
      }
    }

    // ── Execute strategies ────────────────────────────────────────────────────
    const group = selectExecutionGroup(active);
    const startedAt = now();
    const findingsBefore = [...cycle.findings];
    const fixesApplied: FixApplied[] = [];

    for (const strategy of group) {
      const relevantFindings = findingsBefore.filter((f) => strategy.appliesTo(f));
      const input = strategy.buildInput(relevantFindings, cycle.iterations, ctx);
      const output = await doCallOp(ctx, strategy.fixOp, input);
      const extracted = strategy.extractApplied?.(output, input) ?? {};
      fixesApplied.push({
        strategyName: strategy.name,
        op: strategy.fixOp.name,
        targetFiles: extracted.targetFiles ?? [],
        summary: extracted.summary ?? "",
        costUsd: extracted.costUsd,
      });
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    let findingsAfter: F[];
    let validatorAttempt = 0;
    for (;;) {
      try {
        findingsAfter = await cycle.validate(ctx);
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
          return {
            iterations: cycle.iterations,
            finalFindings: cycle.findings,
            exitReason: "validator-error",
            costUsd: totalCostUsd,
          };
        }
        logger?.warn("findings.cycle", "validator retry", {
          storyId,
          packageDir,
          cycleName,
          attempt: validatorAttempt + 1,
          error: errorMessage(err),
        });
        validatorAttempt++;
      }
    }

    // ── Classify and record ───────────────────────────────────────────────────
    const outcome = classifyOutcome(findingsBefore, findingsAfter);
    const finishedAt = now();
    const iterationNum = cycle.iterations.length + 1;
    const iteration: Iteration<F> = {
      iterationNum,
      findingsBefore,
      fixesApplied,
      findingsAfter,
      outcome,
      startedAt,
      finishedAt,
    };

    cycle.iterations.push(iteration);
    cycle.findings = findingsAfter;

    const iterationCostUsd = fixesApplied.reduce((sum, fa) => sum + (fa.costUsd ?? 0), 0);
    totalCostUsd += iterationCostUsd;
    logger?.info("findings.cycle", "iteration completed", {
      storyId,
      packageDir,
      cycleName,
      iterationNum,
      strategiesRan: fixesApplied.map((fa) => fa.strategyName),
      outcome,
      findingsBefore: findingsBefore.length,
      findingsAfter: findingsAfter.length,
      ...(iterationCostUsd > 0 ? { costUsd: iterationCostUsd } : {}),
    });

    if (outcome === "resolved") {
      return { iterations: cycle.iterations, finalFindings: [], exitReason: "resolved", costUsd: totalCostUsd };
    }
  }
}
