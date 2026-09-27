/**
 * Run Completion — Final Metrics and Status Updates
 *
 * Handles the final steps after sequential execution completes:
 * - Run deferred regression gate (if configured)
 * - Save run metrics
 * - Log completion summary with per-story metrics
 * - Update final status
 *
 * The phases live in sibling files (complexity-drain batch A9):
 * - `run-completion-regression.ts` — the deferred regression gate
 * - `run-completion-phases.ts` — review consumption, cost snapshot + backfill,
 *   teardown, run:completed event + metrics save, stale-artifact purge,
 *   completion log, final status
 *
 * `handleRunCompletion` is the sequencer: it reads as a list of phases in
 * execution order. `_runCompletionDeps` stays defined here — the lifecycle
 * barrel re-exports it by reference for tests to mutate, so the phase
 * functions receive it BY REFERENCE and read `deps.X` at call time.
 */

import type { NaxConfig } from "@/config";
import { purgeStaleManifests } from "@/context/engine";
import { fireHook } from "@/hooks";
import type { HooksConfig } from "@/hooks/types";
import type { InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import type { PRD } from "@/prd";
import type { DispatchContext } from "@/runtime/dispatch-context";
import type { DeferredReviewResult } from "../deferred-review";
import type { ExitReason } from "../executor-types";
import { closeAllRunSessions } from "../session-manager-runtime";
import type { StatusWriter } from "../status-writer";
import {
  consumeDeferredReview,
  emitRunCompletedAndSaveMetrics,
  logRunCompletion,
  purgeStaleRunArtifacts,
  snapshotCostsAndBackfill,
  teardownRunSessions,
  writeFinalStatus,
} from "./run-completion-phases";
import { runRegressionGate } from "./run-completion-regression";
import { runDeferredRegression } from "./run-regression";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runCompletionDeps = {
  runDeferredRegression,
  fireHook,
  closeAllRunSessions,
  purgeStaleManifests,
};

export interface RunCompletionOptions extends DispatchContext {
  runId: string;
  feature: string;
  startedAt: string;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
  totalCost: number;
  storiesCompleted: number;
  iterations: number;
  startTime: number;
  workdir: string;
  statusWriter: StatusWriter;
  config: NaxConfig;
  hooksConfig?: HooksConfig;
  /** Whether the run used sequential (non-parallel) execution. Defaults to true. */
  isSequential?: boolean;
  /** Skip deferred regression gate — set when regression phase already passed on a prior run. */
  skipRegression?: boolean;
  /**
   * Absolute path to the project root (where .nax/ lives).
   * Defaults to workdir when absent (non-monorepo).
   * Used for session scratch purge (AC-20).
   */
  projectDir?: string;
  /** Per-run plugin-provider cache (Finding 5 / issue #473). Disposed after session teardown. */
  pluginProviderCache?: import("@/context/engine").PluginProviderCache;
  /**
   * Result of the end-of-run deferred plugin review (#1146 G2). Undefined when no
   * IReviewPlugin reviewers are registered. Consumed here: always surfaced; gates
   * the run only when config.review.pluginMode === "gating".
   */
  deferredReview?: DeferredReviewResult;
  /**
   * Timestamp (from Date.now()) when postrun:phase:started was emitted for the review phase.
   * Emitted in unified-executor.ts before the review ran; threaded here so handleRunCompletion
   * can compute accurate durationMs for the postrun:phase:completed event (AC9).
   */
  deferredReviewStartedAt?: number;
  /** Why the execution phase stopped — used to distinguish a cost-limit stop from a normal completion. */
  exitReason?: ExitReason;
  /** The run's interaction chain, threaded to the deferred regression rectifier's ask resolver (#2201). */
  interactionChain?: InteractionChain | null;
}

export interface RunCompletionResult {
  durationMs: number;
  runCompletedAt: string;
  /** Authoritative run total from the cost aggregator. Use for all downstream reporting. */
  reportedTotal: number;
  finalCounts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
  };
  /**
   * True when config.review.pluginMode === "gating" AND a deferred plugin reviewer
   * failed. Propagated up to runner.ts to fail RunResult.success. Always false in
   * observational mode (#1146 G2).
   */
  pluginGateFailed: boolean;
}

/**
 * Handle final run completion: save metrics, log summary, update status
 */
export async function handleRunCompletion(options: RunCompletionOptions): Promise<RunCompletionResult> {
  const logger = getSafeLogger() ?? undefined;
  const { runId, feature, prd, allStoryMetrics, iterations, startTime, workdir, statusWriter, config, hooksConfig } =
    options;

  // Phase 1 — deferred regression gate. Mutates prd + allStoryMetrics in place
  // (RL-004 marking, #679 rectification fold-in). regressionGateFailed is
  // tracked separately from the setRunStatus("failed") call in the final-status
  // phase so a cost-limit exit can never mask a genuine regression-gate
  // failure — see the final classification there.
  const { regressionGateFailed } = await runRegressionGate({
    options,
    config,
    prd,
    workdir,
    feature,
    allStoryMetrics,
    statusWriter,
    hooksConfig,
    deps: _runCompletionDeps,
  });

  // Phase 2 — deferred plugin review consumption (#1146 G2)
  const { pluginGateFailed } = consumeDeferredReview({ options, config, runId, logger });

  // Phase 3 — aggregator snapshot + story-metrics backfill (Bug 909, nax#1721)
  const costs = snapshotCostsAndBackfill({ options, config, prd, allStoryMetrics });

  const durationMs = Date.now() - startTime;
  const runCompletedAt = new Date().toISOString();

  // Phase 4 — session teardown (ADR-020 §D3 / PERF-1) + plugin-provider disposal
  await teardownRunSessions({ options, deps: _runCompletionDeps });

  // Phase 5 — run:completed event with real story counts (RL-002) + metrics save
  const { finalCounts } = await emitRunCompletedAndSaveMetrics({
    options,
    prd,
    allStoryMetrics,
    durationMs,
    runCompletedAt,
    reportedTotal: costs.reportedTotal,
    errorCostField: costs.errorCostField,
    logger,
  });

  // Phase 6 — purge stale session scratch (AC-20) + stale manifests (US-002)
  await purgeStaleRunArtifacts({
    options,
    prd,
    config,
    workdir,
    feature,
    logger,
    deps: _runCompletionDeps,
  });

  // Phase 7 — completion summary log (per-story metrics, AC-25 context cost)
  logRunCompletion({
    options,
    prd,
    allStoryMetrics,
    finalCounts,
    reportedTotal: costs.reportedTotal,
    errorCostField: costs.errorCostField,
    aggByStage: costs.aggByStage,
    aggByStory: costs.aggByStory,
    durationMs,
    logger,
  });

  // Phase 8 — final status
  await writeFinalStatus({
    options,
    prd,
    statusWriter,
    config,
    regressionGateFailed,
    reportedTotal: costs.reportedTotal,
    iterations,
  });

  return {
    durationMs,
    runCompletedAt,
    reportedTotal: costs.reportedTotal,
    finalCounts: {
      total: finalCounts.total,
      passed: finalCounts.passed,
      failed: finalCounts.failed,
      skipped: finalCounts.skipped,
      pending: finalCounts.pending,
    },
    pluginGateFailed,
  };
}
