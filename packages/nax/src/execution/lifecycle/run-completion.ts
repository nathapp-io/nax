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

import { isWorkflowMode, type NaxConfig } from "@/config";
import { purgeStaleManifests } from "@/context/engine";
import { fireHook } from "@/hooks";
import type { HooksConfig } from "@/hooks/types";
import type { InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import type { McpAdoptionSummary } from "@/mcp/adoption";
import type { StoryMetrics } from "@/metrics";
import { pipelineEventBus, type RunCompletedEvent } from "@/pipeline/event-bus";
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
  summarizeMcpAdoptionPhase,
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
  summarizeMcpAdoptionPhase,
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
  /**
   * Do not write `run.complete` yet. The end phase (finish, or the feature workflow in workflow mode) still
   * has to run, so the caller writes the line itself (via `RunCompletionResult.logRunComplete`) once it knows
   * the whole duration (nax#2491, nax#2494). If a later phase here throws, the line is written before the
   * error propagates, so it is never lost.
   */
  deferRunCompleteLog?: boolean;
  /**
   * Do not emit `run:completed` yet. Independent of `deferRunCompleteLog`: either may be set
   * without the other. The caller emits the held-back event itself (via
   * `RunCompletionResult.emitRunCompleted`) once the end phase has closed, so reporters, the
   * events log, the TUI and the on-complete hook all see the whole run rather than the
   * stories-only figures. If a later phase here throws, the event is emitted — with the figures
   * this phase holds — before the error propagates, so it is never lost (US-001).
   */
  deferRunCompletedEvent?: boolean;
}

/**
 * What the caller knows only after the end phase: the whole run's duration and its two parts. Exactly one
 * of `featureWorkflowDurationMs` (workflow mode) and `endPhaseDurationMs` (pipeline mode: finish etc.) is set.
 */
export interface RunCompleteFinal {
  durationMs: number;
  storiesDurationMs: number;
  /** Workflow mode: the feature workflow's part of `durationMs`. */
  featureWorkflowDurationMs?: number;
  /** Pipeline mode: the end phase's (finish, ...) part of `durationMs`. */
  endPhaseDurationMs?: number;
  /** Spend through the end of the end phase. */
  totalCost: number;
  /** False when the feature workflow did not pass; the line's `success` follows it. Always true in pipeline mode. */
  workflowPassed: boolean;
  /** The PR the end phase opened, when it opened one. */
  url?: string;
  /** Why the end phase did not pass. Once the end phase is closed this is always set (`[]` on a pass). */
  reasons?: readonly string[];
}

export interface RunCompletionResult {
  durationMs: number;
  runCompletedAt: string;
  /** Authoritative run total from the cost aggregator. Use for all downstream reporting. */
  reportedTotal: number;
  /** nax#2410 D6: per-server MCP adoption; absent when no MCP server is configured. */
  mcpAdoption?: McpAdoptionSummary;
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
  /** Present only when `deferRunCompleteLog` was set: writes the held-back `run.complete` line. */
  logRunComplete?: (final: RunCompleteFinal) => void;
  /**
   * Present only when `deferRunCompletedEvent` was set: emits the held-back `run:completed`
   * with the caller's whole-run figures. Call it exactly once, after the end phase has closed
   * (US-001 wires it to the same exactly-once gate as `logRunComplete`).
   */
  emitRunCompleted?: (final: RunCompleteFinal) => void;
}

/**
 * The deferred `run:completed`: the payload phase 5 built (story counts, fallback aggregate and
 * the phase-3 `errorCostUsd`) with the caller's whole-run figures overlaid on it. `url` and
 * `reasons` ride along only when the caller supplied them, so a fallback emission carries
 * neither rather than an empty claim (US-001).
 */
function withWholeRunFigures(base: RunCompletedEvent, final: RunCompleteFinal): RunCompletedEvent {
  return {
    ...base,
    durationMs: final.durationMs,
    totalCost: final.totalCost,
    workflowPassed: final.workflowPassed,
    ...(final.url !== undefined ? { url: final.url } : {}),
    ...(final.reasons !== undefined ? { reasons: final.reasons } : {}),
  };
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
  const { finalCounts, runCompletedPayload } = await emitRunCompletedAndSaveMetrics({
    options,
    prd,
    allStoryMetrics,
    durationMs,
    runCompletedAt,
    reportedTotal: costs.reportedTotal,
    errorCostField: costs.errorCostField,
    logger,
  });

  /**
   * The deferred `run:completed` (US-001): the phase-5 payload with the caller's whole-run
   * figures overlaid on it. Handed to the caller on a clean completion, and used by the catch
   * below when a later phase rejects before the caller ever receives it.
   */
  const emitRunCompleted = (final: RunCompleteFinal): void => {
    pipelineEventBus.emit(withWholeRunFigures(runCompletedPayload, final));
  };

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
  const logComplete = (timing?: RunCompleteFinal): void =>
    logRunCompletion({
      options,
      prd,
      allStoryMetrics,
      finalCounts,
      reportedTotal: costs.reportedTotal,
      errorCostField: costs.errorCostField,
      // US-004: read the aggregator's splits as the line is written, not at phase 3. The deferred
      // line is written after the feature workflow, whose spend reached the aggregator since — a
      // phase-3 snapshot reported a breakdown that predated it and did not sum to the total.
      aggByStage: options.runtime.costAggregator.byStage(),
      aggByStory: options.runtime.costAggregator.byStory(),
      durationMs: timing?.durationMs ?? durationMs,
      ...(timing ? { timing } : {}),
      logger,
    });
  if (!options.deferRunCompleteLog) logComplete();

  let mcpAdoption: McpAdoptionSummary | undefined;
  try {
    // Phase 7.5 — MCP adoption summary (nax#2410 D6): per-server offered/called
    // counts plus the zero-adoption WARN. Undefined when MCP is unconfigured.
    mcpAdoption = await _runCompletionDeps.summarizeMcpAdoptionPhase({
      workdir,
      feature,
      config,
      outputDir: options.runtime.outputDir,
      toolAuditRunId: options.runtime.runId,
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
  } catch (err) {
    // The held-back line would never reach its caller: write it, as of now, before the error goes up.
    if (options.deferRunCompleteLog) logComplete();
    if (options.deferRunCompletedEvent) {
      // Same for the held-back event. The end phase never ran, so there is no verdict to report:
      // emit the figures this phase holds, and report a failure in workflow mode — the workflow
      // that was promised did not pass — while pipeline mode has no workflow to fail (US-001).
      // Drained before the error propagates so async subscribers are not cut short.
      emitRunCompleted({
        durationMs,
        storiesDurationMs: durationMs,
        totalCost: costs.reportedTotal,
        workflowPassed: !isWorkflowMode(config),
      });
      await pipelineEventBus.drain();
    }
    throw err;
  }

  return {
    durationMs,
    runCompletedAt,
    reportedTotal: costs.reportedTotal,
    ...(mcpAdoption !== undefined ? { mcpAdoption } : {}),
    finalCounts: {
      total: finalCounts.total,
      passed: finalCounts.passed,
      failed: finalCounts.failed,
      skipped: finalCounts.skipped,
      pending: finalCounts.pending,
    },
    pluginGateFailed,
    ...(options.deferRunCompleteLog ? { logRunComplete: logComplete } : {}),
    ...(options.deferRunCompletedEvent ? { emitRunCompleted } : {}),
  };
}
