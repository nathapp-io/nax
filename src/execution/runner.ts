/**
 * Execution Runner — The Core Loop
 *
 * Orchestrates the agent loop:
 * 1. Load PRD → find next story/batch
 * 2. Run pipeline for each story/batch
 * 3. Handle pipeline results (escalate, mark complete, etc.)
 * 4. Loop until complete or blocked
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import { countStories, isComplete } from "../prd";
import type { UserStory } from "../prd";
import { tryLlmBatchRoute } from "../routing/batch-route";
import { clearCache as clearLlmCache, routeBatch as llmRouteBatch } from "../routing/strategies/llm";
import { precomputeBatchPlan } from "./batching";
import { stopHeartbeat, writeExitSummary } from "./crash-recovery";
import { getAllReadyStories } from "./helpers";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runnerDeps = {
  fireHook,
};

// Re-export for backward compatibility
export { resolveMaxAttemptsOutcome } from "./escalation";

/** Run options */

export interface RunOptions {
  /** Path to prd.json */
  prdPath: string;
  /** Working directory */
  workdir: string;
  /** Ngent config */
  config: NaxConfig;
  /** Hooks config */
  hooks: LoadedHooksConfig;
  /** Feature name */
  feature: string;
  /** Feature directory (for progress logging) */
  featureDir?: string;
  /** Dry run */
  dryRun: boolean;
  /** Enable story batching (default: true) */
  useBatch?: boolean;
  /** Max parallel sessions: undefined=sequential, 0=auto-detect, N>0=cap at N */
  parallel?: number;
  /** Optional event emitter for TUI integration */
  eventEmitter?: PipelineEventEmitter;
  /** Path to write a machine-readable JSON status file */
  statusFile: string;
  /** Path to JSONL log file (for crash recovery) */
  logFilePath?: string;
  /** Formatter verbosity mode for headless stdout (default: "normal") */
  formatterMode?: "quiet" | "normal" | "verbose" | "json";
  /** Whether running in headless mode (vs TUI mode) */
  headless?: boolean;
  /** Skip precheck validations (for advanced users) */
  skipPrecheck?: boolean;
}

/** Run result */
export interface RunResult {
  success: boolean;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  durationMs: number;
}

/**
 * Main execution loop
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const {
    prdPath,
    workdir,
    config,
    hooks,
    feature,
    featureDir,
    dryRun,
    useBatch = true,
    eventEmitter,
    statusFile,
    parallel,
    logFilePath,
    formatterMode = "normal",
    headless = false,
    skipPrecheck = false,
  } = options;
  const startTime = Date.now();
  const runStartedAt = new Date().toISOString();
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let iterations = 0;
  let storiesCompleted = 0;
  let totalCost = 0;
  const allStoryMetrics: StoryMetrics[] = [];

  const logger = getSafeLogger();

  // Declare prd before crash handler setup to avoid TDZ if SIGTERM arrives during setupRun
  let prd: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["prd"] | undefined;

  // ── Execute initial setup phase ──────────────────────────────────────────────
  const { setupRun } = await import("./lifecycle/run-setup");
  const setupResult = await setupRun({
    prdPath,
    workdir,
    config,
    hooks,
    feature,
    featureDir,
    dryRun,
    statusFile,
    logFilePath,
    runId,
    startedAt: runStartedAt,
    startTime,
    skipPrecheck,
    headless,
    formatterMode,
    getTotalCost: () => totalCost,
    getIterations: () => iterations,
    // BUG-017: Pass getters for run.complete event on SIGTERM
    getStoriesCompleted: () => storiesCompleted,
    getTotalStories: () => (prd ? countStories(prd).total : 0),
  });

  const {
    statusWriter,
    pidRegistry,
    cleanupCrashHandlers,
    pluginRegistry,
    storyCounts: counts,
    interactionChain,
  } = setupResult;
  prd = setupResult.prd;

  try {
    // ── Output run header in headless mode ─────────────────────────────────
    if (headless && formatterMode !== "json") {
      const { outputRunHeader } = await import("./lifecycle/headless-formatter");
      await outputRunHeader({
        feature,
        totalStories: counts.total,
        pendingStories: counts.pending,
        workdir,
        formatterMode,
      });
    }

    // ── Status write point 1: run started ───────────────────────────────────
    statusWriter.setPrd(prd);
    statusWriter.setRunStatus("running");
    statusWriter.setCurrentStory(null);
    await statusWriter.update(totalCost, iterations);

    // Update reporters with correct totalStories count
    const reporters = pluginRegistry.getReporters();
    for (const reporter of reporters) {
      if (reporter.onRunStart) {
        try {
          await reporter.onRunStart({
            runId,
            feature,
            totalStories: counts.total,
            startTime: runStartedAt,
          });
        } catch (error) {
          logger?.warn("plugins", `Reporter '${reporter.name}' onRunStart failed`, { error });
        }
      }
    }

    logger?.info("execution", `Starting ${feature}`, {
      totalStories: counts.total,
      doneStories: counts.passed,
      pendingStories: counts.pending,
      batchingEnabled: useBatch,
    });

    // Clear LLM routing cache at start of new run
    clearLlmCache();

    // PERF-1: Precompute batch plan once from ready stories
    const batchPlan = useBatch ? precomputeBatchPlan(getAllReadyStories(prd), 4) : [];

    if (useBatch) {
      await tryLlmBatchRoute(config, getAllReadyStories(prd), "routing");
    }

    // ── Parallel Execution Path (when --parallel is set) ──────────────────────
    if (options.parallel !== undefined) {
      const { runParallelExecution } = await import("./parallel-executor");
      const parallelResult = await runParallelExecution(
        {
          prdPath,
          workdir,
          config,
          hooks,
          feature,
          featureDir,
          parallelCount: options.parallel,
          eventEmitter,
          statusWriter,
          runId,
          startedAt: runStartedAt,
          startTime,
          totalCost,
          iterations,
          storiesCompleted,
          allStoryMetrics,
          pluginRegistry,
          formatterMode,
          headless,
        },
        prd,
      );

      prd = parallelResult.prd;
      totalCost = parallelResult.totalCost;
      storiesCompleted = parallelResult.storiesCompleted;

      // If parallel execution completed everything, return early
      if (parallelResult.completed && parallelResult.durationMs !== undefined) {
        return {
          success: true,
          iterations,
          storiesCompleted,
          totalCost,
          durationMs: parallelResult.durationMs,
        };
      }
    }

    // ── Sequential Execution Path (default) ────────────────────────────────────
    const { executeSequential } = await import("./sequential-executor");
    const sequentialResult = await executeSequential(
      {
        prdPath,
        workdir,
        config,
        hooks,
        feature,
        featureDir,
        dryRun,
        useBatch,
        pluginRegistry,
        eventEmitter,
        statusWriter,
        logFilePath,
        runId,
        startTime,
        batchPlan,
      },
      prd,
    );

    prd = sequentialResult.prd;
    iterations = sequentialResult.iterations;
    storiesCompleted = sequentialResult.storiesCompleted;
    totalCost = sequentialResult.totalCost;
    allStoryMetrics.push(...sequentialResult.allStoryMetrics);

    // After main loop: Check if we need acceptance retry loop
    if (config.acceptance.enabled && isComplete(prd)) {
      const { runAcceptanceLoop } = await import("./lifecycle/acceptance-loop");
      const acceptanceResult = await runAcceptanceLoop({
        config,
        prd,
        prdPath,
        workdir,
        featureDir,
        hooks,
        feature,
        totalCost,
        iterations,
        storiesCompleted,
        allStoryMetrics,
        pluginRegistry,
        eventEmitter,
        statusWriter,
      });

      prd = acceptanceResult.prd;
      totalCost = acceptanceResult.totalCost;
      iterations = acceptanceResult.iterations;
      storiesCompleted = acceptanceResult.storiesCompleted;
    }

    // Handle run completion: save metrics, log summary, update status
    const { handleRunCompletion } = await import("./lifecycle/run-completion");
    const completionResult = await handleRunCompletion({
      runId,
      feature,
      startedAt: runStartedAt,
      prd,
      allStoryMetrics,
      totalCost,
      storiesCompleted,
      iterations,
      startTime,
      workdir,
      statusWriter,
      config,
    });

    const { durationMs, runCompletedAt, finalCounts } = completionResult;

    // ── Write feature-level status (SFC-002) ────────────────────────────────
    if (featureDir) {
      const finalStatus = isComplete(prd) ? "completed" : "failed";
      statusWriter.setRunStatus(finalStatus);
      await statusWriter.writeFeatureStatus(featureDir, totalCost, iterations);
    }

    // ── Output run footer in headless mode ─────────────────────────────────
    if (headless && formatterMode !== "json") {
      const { outputRunFooter } = await import("./lifecycle/headless-formatter");
      outputRunFooter({
        finalCounts: {
          total: finalCounts.total,
          passed: finalCounts.passed,
          failed: finalCounts.failed,
          skipped: finalCounts.skipped,
        },
        durationMs,
        totalCost,
        startedAt: runStartedAt,
        completedAt: runCompletedAt,
        formatterMode,
      });
    }

    // Stop heartbeat and write exit summary (US-007)
    stopHeartbeat();
    await writeExitSummary(logFilePath, totalCost, iterations, storiesCompleted, durationMs);

    return {
      success: isComplete(prd),
      iterations,
      storiesCompleted,
      totalCost,
      durationMs,
    };
  } finally {
    // Stop heartbeat on any exit (US-007)
    stopHeartbeat();
    // Cleanup crash handlers (MEM-1 fix)
    cleanupCrashHandlers();

    // Execute cleanup operations
    const { cleanupRun } = await import("./lifecycle/run-cleanup");
    await cleanupRun({
      runId,
      startTime,
      totalCost,
      storiesCompleted,
      prd,
      pluginRegistry,
      workdir,
      interactionChain,
    });
  }
}

// Re-exports for backward compatibility with existing test imports
export { buildSingleSessionPrompt, buildBatchPrompt } from "./prompts";
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier } from "./escalation";
