/**
 * Execution Runner — The Core Loop
 *
 * Orchestrates the agent loop:
 * 1. Load PRD → find next story/batch
 * 2. Run pipeline for each story/batch
 * 3. Handle pipeline results (escalate, mark complete, etc.)
 * 4. Loop until complete or blocked
 */

import * as os from "node:os";
import path from "node:path";
import chalk from "chalk";
import type { NaxConfig } from "../config";
import { LockAcquisitionError } from "../errors";
import { type LoadedHooksConfig, fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import { type RunSummary, formatRunSummary } from "../logging";
import { type StoryMetrics, saveRunMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import { loadPlugins } from "../plugins/loader";
import { countStories, isComplete, loadPRD } from "../prd";
import type { UserStory } from "../prd";
import { clearCache as clearLlmCache, routeBatch as llmRouteBatch } from "../routing/strategies/llm";
import { precomputeBatchPlan } from "./batching";
import { installCrashHandlers } from "./crash-recovery";
import { acquireLock, getAllReadyStories, hookCtx, releaseLock } from "./helpers";
import { executeParallel } from "./parallel";
import { PidRegistry } from "./pid-registry";
import { StatusWriter } from "./status-writer";

// Re-export for backward compatibility
export { resolveMaxAttemptsOutcome } from "./escalation";

/** Run options */

/**
 * Try LLM batch routing for ready stories. Logs and swallows errors (falls back to per-story routing).
 */
async function tryLlmBatchRoute(config: NaxConfig, stories: UserStory[], label = "routing"): Promise<void> {
  const mode = config.routing.llm?.mode ?? "hybrid";
  if (config.routing.strategy !== "llm" || mode === "per-story" || stories.length === 0) return;
  const logger = getSafeLogger();
  try {
    logger?.debug("routing", `LLM batch routing: ${label}`, { storyCount: stories.length, mode });
    await llmRouteBatch(stories, { config });
    logger?.debug("routing", "LLM batch routing complete", { label });
  } catch (err) {
    logger?.warn("routing", "LLM batch routing failed, falling back to individual routing", {
      error: (err as Error).message,
      label,
    });
  }
}

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
  /** Path to write a machine-readable JSON status file. Omit to skip writing. */
  statusFile?: string;
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

  // ── Status writer (encapsulates status file state and write logic) ───────
  const statusWriter = new StatusWriter(statusFile, config, {
    runId,
    feature,
    startedAt: runStartedAt,
    dryRun,
    startTimeMs: startTime,
    pid: process.pid,
  });

  // ── PID registry for orphan process cleanup (BUG-002) ───────
  const pidRegistry = new PidRegistry(workdir);

  // Cleanup stale PIDs from previous crashed runs
  const logger = getSafeLogger();
  await pidRegistry.cleanupStale();

  // Install crash handlers for signal recovery (US-007, BUG-1+MEM-1 fix: pass getters, cleanup in finally)
  const cleanupCrashHandlers = installCrashHandlers({
    statusWriter,
    getTotalCost: () => totalCost,
    getIterations: () => iterations,
    jsonlFilePath: logFilePath,
    pidRegistry,
  });

  // Acquire lock to prevent concurrent execution
  const lockAcquired = await acquireLock(workdir);
  if (!lockAcquired) {
    logger?.error("execution", "Another nax process is already running in this directory");
    logger?.error("execution", "If you believe this is an error, remove nax.lock manually");
    throw new LockAcquisitionError(workdir);
  }

  // Load plugins (before try block so it's accessible in finally)
  const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
  const projectPluginsDir = path.join(workdir, "nax", "plugins");
  const configPlugins = config.plugins || [];
  const pluginRegistry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins, workdir);
  const reporters = pluginRegistry.getReporters();

  // Load PRD (before try block so it's accessible in finally for onRunEnd)
  let prd = await loadPRD(prdPath);

  // ── Run precheck validations (unless --skip-precheck) ──────────────────────
  if (!skipPrecheck) {
    const { runPrecheckValidation } = await import("./lifecycle/precheck-runner");
    await runPrecheckValidation({
      config,
      prd,
      workdir,
      logFilePath,
      statusWriter,
      headless,
      formatterMode,
    });
  } else {
    logger?.warn("precheck", "Precheck validations skipped (--skip-precheck)");
  }

  try {
    logger?.info("plugins", `Loaded ${pluginRegistry.plugins.length} plugins`, {
      plugins: pluginRegistry.plugins.map((p) => ({ name: p.name, version: p.version, provides: p.provides })),
    });

    // Log run start
    const routingMode = config.routing.llm?.mode ?? "hybrid";
    logger?.info("run.start", `Starting feature: ${feature}`, {
      runId,
      feature,
      workdir,
      dryRun,
      useBatch,
      routingMode,
    });

    // Fire on-start hook
    await fireHook(hooks, "on-start", hookCtx(feature), workdir);

    // Initialize run: check agent, reconcile state, validate limits
    const { initializeRun } = await import("./lifecycle/run-initialization");
    const initResult = await initializeRun({
      config,
      prdPath,
      workdir,
      dryRun,
    });
    prd = initResult.prd;
    const counts = initResult.storyCounts;

    // ── Output run header in headless mode ─────────────────────────────────
    if (headless && formatterMode !== "json") {
      const pkg = await Bun.file(path.join(import.meta.dir, "..", "..", "package.json")).json();
      console.log("");
      console.log(chalk.bold(chalk.blue("═".repeat(60))));
      console.log(chalk.bold(chalk.blue(`  ▶ NAX v${pkg.version} — RUN STARTED`)));
      console.log(chalk.blue("═".repeat(60)));
      console.log(`  ${chalk.gray("Feature:")}  ${chalk.cyan(feature)}`);
      console.log(`  ${chalk.gray("Stories:")}  ${chalk.cyan(`${counts.total} total, ${counts.pending} pending`)}`);
      console.log(`  ${chalk.gray("Path:")}     ${chalk.dim(workdir)}`);
      console.log(chalk.blue("═".repeat(60)));
      console.log("");
    }

    // ── Status write point 1: run started ───────────────────────────────────
    statusWriter.setPrd(prd);
    statusWriter.setRunStatus("running");
    statusWriter.setCurrentStory(null);
    await statusWriter.update(totalCost, iterations);

    // Update reporters with correct totalStories count
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
      const readyStories = getAllReadyStories(prd);
      if (readyStories.length === 0) {
        logger?.info("parallel", "No stories ready for parallel execution");
      } else {
        const maxConcurrency = options.parallel === 0 ? os.cpus().length : Math.max(1, options.parallel);

        logger?.info("parallel", "Starting parallel execution mode", {
          totalStories: readyStories.length,
          maxConcurrency,
        });

        // Update status with parallel info
        statusWriter.setPrd(prd);
        await statusWriter.update(totalCost, iterations, {
          parallel: {
            enabled: true,
            maxConcurrency,
            activeStories: readyStories.map((s) => ({
              storyId: s.id,
              worktreePath: path.join(workdir, ".nax-wt", s.id),
            })),
          },
        });

        try {
          const parallelResult = await executeParallel(
            readyStories,
            prdPath,
            workdir,
            config,
            hooks,
            pluginRegistry,
            prd,
            featureDir,
            options.parallel,
            eventEmitter,
          );

          prd = parallelResult.updatedPrd;
          storiesCompleted += parallelResult.storiesCompleted;
          totalCost += parallelResult.totalCost;
          prdDirty = true;

          logger?.info("parallel", "Parallel execution complete", {
            storiesCompleted: parallelResult.storiesCompleted,
            totalCost: parallelResult.totalCost,
          });

          // Clear parallel status
          statusWriter.setPrd(prd);
          await statusWriter.update(totalCost, iterations, {
            parallel: {
              enabled: true,
              maxConcurrency,
              activeStories: [],
            },
          });
        } catch (error) {
          logger?.error("parallel", "Parallel execution failed", {
            error: error instanceof Error ? error.message : String(error),
          });

          // Clear parallel status on error
          await statusWriter.update(totalCost, iterations, {
            parallel: undefined,
          });

          throw error;
        }

        // Check if all stories are complete after parallel execution
        if (isComplete(prd)) {
          logger?.info("execution", "All stories complete!", {
            feature,
            totalCost,
          });
          await fireHook(hooks, "on-complete", hookCtx(feature, { status: "complete", cost: totalCost }), workdir);

          // Skip to metrics and cleanup
          const durationMs = Date.now() - startTime;
          const runCompletedAt = new Date().toISOString();
          const runMetrics = {
            runId,
            feature,
            startedAt: runStartedAt,
            completedAt: runCompletedAt,
            totalCost,
            totalStories: allStoryMetrics.length,
            storiesCompleted,
            storiesFailed: countStories(prd).failed,
            totalDurationMs: durationMs,
            stories: allStoryMetrics,
          };

          await saveRunMetrics(workdir, runMetrics);

          const finalCounts = countStories(prd);
          logger?.info("run.complete", "Feature execution completed", {
            runId,
            feature,
            success: true,
            iterations,
            totalStories: finalCounts.total,
            storiesCompleted,
            storiesFailed: finalCounts.failed,
            storiesPending: finalCounts.pending,
            totalCost,
            durationMs,
          });

          statusWriter.setPrd(prd);
          statusWriter.setCurrentStory(null);
          statusWriter.setRunStatus("completed");
          await statusWriter.update(totalCost, iterations);

          // ── Output run footer in headless mode (parallel path) ──────────────
          if (headless && formatterMode !== "json") {
            const runSummary: RunSummary = {
              total: finalCounts.total,
              passed: finalCounts.passed,
              failed: finalCounts.failed,
              skipped: finalCounts.skipped,
              durationMs,
              totalCost,
              startedAt: runStartedAt,
              completedAt: runCompletedAt,
            };
            const summaryOutput = formatRunSummary(runSummary, {
              mode: formatterMode,
              useColor: true,
            });
            console.log(summaryOutput);
          }

          return {
            success: true,
            iterations,
            storiesCompleted,
            totalCost,
            durationMs,
          };
        }
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

    const durationMs = Date.now() - startTime;

    // Save run metrics
    const runCompletedAt = new Date().toISOString();
    const runMetrics = {
      runId,
      feature,
      startedAt: runStartedAt,
      completedAt: runCompletedAt,
      totalCost,
      totalStories: allStoryMetrics.length,
      storiesCompleted,
      storiesFailed: countStories(prd).failed,
      totalDurationMs: durationMs,
      stories: allStoryMetrics,
    };

    await saveRunMetrics(workdir, runMetrics);

    // Log run completion
    const finalCounts = countStories(prd);

    // Prepare per-story metrics summary
    const storyMetricsSummary = allStoryMetrics.map((sm) => ({
      storyId: sm.storyId,
      complexity: sm.complexity,
      modelTier: sm.modelTier,
      modelUsed: sm.modelUsed,
      attempts: sm.attempts,
      finalTier: sm.finalTier,
      success: sm.success,
      cost: sm.cost,
      durationMs: sm.durationMs,
      firstPassSuccess: sm.firstPassSuccess,
    }));

    logger?.info("run.complete", "Feature execution completed", {
      runId,
      feature,
      success: isComplete(prd),
      iterations,
      totalStories: finalCounts.total,
      storiesCompleted,
      storiesFailed: finalCounts.failed,
      storiesPending: finalCounts.pending,
      totalCost,
      durationMs,
      storyMetrics: storyMetricsSummary,
    });

    // ── Status write point 4: run end ──────────────────────────────────────
    statusWriter.setPrd(prd);
    statusWriter.setCurrentStory(null);
    statusWriter.setRunStatus(isComplete(prd) ? "completed" : isStalled(prd) ? "stalled" : "running");
    await statusWriter.update(totalCost, iterations);

    // ── Output run footer in headless mode ─────────────────────────────────
    if (headless && formatterMode !== "json") {
      const runSummary: RunSummary = {
        total: finalCounts.total,
        passed: finalCounts.passed,
        failed: finalCounts.failed,
        skipped: finalCounts.skipped,
        durationMs,
        totalCost,
        startedAt: runStartedAt,
        completedAt: runCompletedAt,
      };
      const summaryOutput = formatRunSummary(runSummary, {
        mode: formatterMode,
        useColor: true,
      });
      console.log(summaryOutput);
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
    // Fire onRunEnd for reporters (even on failure/abort)
    const durationMs = Date.now() - startTime;
    const finalCounts = countStories(prd);
    for (const reporter of reporters) {
      if (reporter.onRunEnd) {
        try {
          await reporter.onRunEnd({
            runId,
            totalDurationMs: durationMs,
            totalCost,
            storySummary: {
              completed: storiesCompleted,
              failed: finalCounts.failed,
              skipped: finalCounts.skipped,
              paused: finalCounts.paused,
            },
          });
        } catch (error) {
          logger?.warn("plugins", `Reporter '${reporter.name}' onRunEnd failed`, { error });
        }
      }
    }

    // Teardown plugins
    try {
      await pluginRegistry.teardownAll();
    } catch (error) {
      logger?.warn("plugins", "Plugin teardown failed", { error });
    }

    // Always release lock, even if execution fails
    await releaseLock(workdir);
  }
}

// Re-exports for backward compatibility with existing test imports
export { buildSingleSessionPrompt, buildBatchPrompt } from "./prompts";
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier } from "./escalation";
