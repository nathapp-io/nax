/**
 * Run Lifecycle — Setup & Teardown Logic
 *
 * Encapsulates the bookend operations for a nax execution run:
 * - Setup: lock acquisition, PRD loading, plugin initialization, reporter setup
 * - Teardown: metrics computation, final status write, lock release, plugin cleanup
 */

import * as os from "node:os";
import path from "node:path";
import { getAgent } from "../agents";
import type { NaxConfig } from "../config";
import { type LoadedHooksConfig, fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import { type StoryMetrics, saveRunMetrics } from "../metrics";
import { loadPlugins } from "../plugins/loader";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD } from "../prd";
import { countStories, isComplete, isStalled, loadPRD } from "../prd";
import { clearCache as clearLlmCache, routeBatch as llmRouteBatch } from "../routing/strategies/llm";
import { precomputeBatchPlan, type StoryBatch } from "./batching";
import { acquireLock, getAllReadyStories, hookCtx, releaseLock } from "./helpers";
import type { StatusWriter } from "./status-writer";

/** Setup result containing initialized state */
export interface SetupResult {
  prd: PRD;
  pluginRegistry: PluginRegistry;
  batchPlan: StoryBatch[];
}

/** Teardown options */
export interface TeardownOptions {
  runId: string;
  feature: string;
  startedAt: string;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
  totalCost: number;
  storiesCompleted: number;
  startTime: number;
  workdir: string;
  pluginRegistry: PluginRegistry;
  statusWriter: StatusWriter;
  iterations: number;
}

/**
 * Run lifecycle manager — handles setup and teardown for nax execution
 */
export class RunLifecycle {
  constructor(
    private readonly prdPath: string,
    private readonly workdir: string,
    private readonly config: NaxConfig,
    private readonly hooks: LoadedHooksConfig,
    private readonly feature: string,
    private readonly dryRun: boolean,
    private readonly useBatch: boolean,
    private readonly statusWriter: StatusWriter,
    private readonly runId: string,
    private readonly startedAt: string,
  ) {}

  /**
   * Setup: Acquire lock, load PRD, initialize plugins, setup reporters
   */
  async setup(): Promise<SetupResult> {
    const logger = getSafeLogger();

    // Acquire lock to prevent concurrent execution
    const lockAcquired = await acquireLock(this.workdir);
    if (!lockAcquired) {
      logger?.error("execution", "Another nax process is already running in this directory");
      logger?.error("execution", "If you believe this is an error, remove nax.lock manually");
      process.exit(1);
    }

    // Load plugins
    const globalPluginsDir = path.join(os.homedir(), ".nax", "plugins");
    const projectPluginsDir = path.join(this.workdir, "nax", "plugins");
    const configPlugins = this.config.plugins || [];
    const pluginRegistry = await loadPlugins(globalPluginsDir, projectPluginsDir, configPlugins);
    const reporters = pluginRegistry.getReporters();

    logger?.info("plugins", `Loaded ${pluginRegistry.plugins.length} plugins`, {
      plugins: pluginRegistry.plugins.map((p) => ({ name: p.name, version: p.version, provides: p.provides })),
    });

    // Log run start
    const routingMode = this.config.routing.llm?.mode ?? "hybrid";
    logger?.info("run.start", `Starting feature: ${this.feature}`, {
      runId: this.runId,
      feature: this.feature,
      workdir: this.workdir,
      dryRun: this.dryRun,
      useBatch: this.useBatch,
      routingMode,
    });

    // Fire on-start hook
    await fireHook(this.hooks, "on-start", hookCtx(this.feature), this.workdir);

    // Check agent installation before starting
    const agent = getAgent(this.config.autoMode.defaultAgent);
    if (!agent) {
      logger?.error("execution", "Agent not found", {
        agent: this.config.autoMode.defaultAgent,
      });
      process.exit(1);
    }

    const installed = await agent.isInstalled();
    if (!installed) {
      logger?.error("execution", "Agent is not installed or not in PATH", {
        agent: this.config.autoMode.defaultAgent,
        binary: agent.binary,
      });
      logger?.error("execution", "Please install the agent and try again");
      process.exit(1);
    }

    // Load PRD
    const prd = await loadPRD(this.prdPath);
    const counts = countStories(prd);

    // Status write point: run started
    this.statusWriter.setPrd(prd);
    this.statusWriter.setRunStatus("running");
    this.statusWriter.setCurrentStory(null);
    await this.statusWriter.update(0, 0);

    // Update reporters with correct totalStories count
    for (const reporter of reporters) {
      if (reporter.onRunStart) {
        try {
          await reporter.onRunStart({
            runId: this.runId,
            feature: this.feature,
            totalStories: counts.total,
            startTime: this.startedAt,
          });
        } catch (error) {
          logger?.warn("plugins", `Reporter '${reporter.name}' onRunStart failed`, { error });
        }
      }
    }

    // MEM-1: Validate story count doesn't exceed limit
    if (counts.total > this.config.execution.maxStoriesPerFeature) {
      logger?.error("execution", "Feature exceeds story limit", {
        totalStories: counts.total,
        limit: this.config.execution.maxStoriesPerFeature,
      });
      logger?.error("execution", "Split this feature into smaller features or increase maxStoriesPerFeature in config");
      process.exit(1);
    }

    logger?.info("execution", `Starting ${this.feature}`, {
      totalStories: counts.total,
      doneStories: counts.passed,
      pendingStories: counts.pending,
      batchingEnabled: this.useBatch,
    });

    // Clear LLM routing cache at start of new run
    clearLlmCache();

    // PERF-1: Precompute batch plan once from ready stories
    let batchPlan: StoryBatch[] = [];
    if (this.useBatch) {
      const readyStories = getAllReadyStories(prd);
      batchPlan = precomputeBatchPlan(readyStories, 4);

      // Initial batch routing
      const mode = this.config.routing.llm?.mode ?? "hybrid";
      if (this.config.routing.strategy === "llm" && mode !== "per-story" && readyStories.length > 0) {
        try {
          logger?.debug("routing", "LLM batch routing: routing", { storyCount: readyStories.length, mode });
          await llmRouteBatch(readyStories, { config: this.config });
          logger?.debug("routing", "LLM batch routing complete", { label: "routing" });
        } catch (err) {
          logger?.warn("routing", "LLM batch routing failed, falling back to individual routing", {
            error: (err as Error).message,
            label: "routing",
          });
        }
      }
    }

    return {
      prd,
      pluginRegistry,
      batchPlan,
    };
  }

  /**
   * Teardown: Compute final metrics, write final status, release lock, cleanup plugins
   */
  async teardown(options: TeardownOptions): Promise<void> {
    const logger = getSafeLogger();
    const {
      runId,
      feature,
      startedAt,
      prd,
      allStoryMetrics,
      totalCost,
      storiesCompleted,
      startTime,
      workdir,
      pluginRegistry,
      statusWriter,
      iterations,
    } = options;

    const durationMs = Date.now() - startTime;

    // Save run metrics
    const runCompletedAt = new Date().toISOString();
    const runMetrics = {
      runId,
      feature,
      startedAt,
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

    // Emit onRunEnd to reporters
    const reporters = pluginRegistry.getReporters();
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

    // Status write point: run end
    statusWriter.setPrd(prd);
    statusWriter.setCurrentStory(null);
    statusWriter.setRunStatus(isComplete(prd) ? "completed" : isStalled(prd) ? "stalled" : "running");
    await statusWriter.update(totalCost, iterations);

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
