/**
 * Runner Execution Phase
 *
 * Handles story execution via unified executor (parallel or sequential).
 * Extracted from runner.ts for better code organization.
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import type { InteractionChain } from "../interaction/chain";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { AgentGetFn } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD } from "../prd";
import { tryLlmBatchRoute } from "../routing";
import type { DispatchContext } from "../runtime/dispatch-context";
import { SessionManager } from "../session";
import { precomputeBatchPlan } from "./batching";
import type { DeferredReviewResult } from "./deferred-review";
import { ensureStoryPackageDirs } from "./ensure-package-dirs";
import type { ExitReason } from "./executor-types";
import { getAllReadyStories } from "./helpers";
import { markNewPackageDirs } from "./new-package-setup";

/**
 * Options for the execution phase.
 */
export interface RunnerExecutionOptions extends DispatchContext {
  prdPath: string;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  featureDir?: string;
  dryRun: boolean;
  useBatch: boolean;
  eventEmitter?: PipelineEventEmitter;
  // biome-ignore lint/suspicious/noExplicitAny: StatusWriter interface varies by platform
  statusWriter: any;
  statusFile: string;
  logFilePath?: string;
  runId: string;
  startedAt: string;
  startTime: number;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
  headless: boolean;
  parallel?: number;
  /** Protocol-aware agent resolver — bound from agentManager.getAgent in runner.ts */
  agentGetFn?: AgentGetFn;
  /** Interaction chain for cost/pre-merge triggers during sequential execution. */
  interactionChain?: InteractionChain | null;
  /** Per-run plugin-provider cache (Finding 5 / issue #473). */
  pluginProviderCache?: import("../context/engine").PluginProviderCache;
}

/**
 * Result from the execution phase.
 */
export interface RunnerExecutionResult {
  prd: PRD;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  allStoryMetrics: StoryMetrics[];
  completedEarly?: boolean;
  durationMs?: number;
  /** End-of-run deferred plugin review result (#1146 G2). Forwarded to the completion phase. */
  deferredReview?: DeferredReviewResult;
  /** Date.now() captured before postrun:phase:started for review was emitted. Forwarded for accurate durationMs (AC9). */
  deferredReviewStartedAt?: number;
  /** Why the unified executor's loop stopped — forwarded to the completion phase for status reporting. */
  exitReason: ExitReason;
}

/**
 * Execute the main execution phase via unified executor.
 *
 * @param options - Execution options
 * @param prd - Product requirements document
 * @param pluginRegistry - Plugin registry
 * @returns Execution result
 */
export async function runExecutionPhase(
  options: RunnerExecutionOptions,
  prd: PRD,
  pluginRegistry: PluginRegistry,
): Promise<RunnerExecutionResult> {
  const logger = getSafeLogger();

  let iterations = 0;
  let storiesCompleted = 0;
  let totalCost = 0;
  const allStoryMetrics: StoryMetrics[] = [];

  // Output run header in headless mode
  if (options.headless && options.formatterMode !== "json") {
    const { outputRunHeader } = await import("./lifecycle/headless-formatter");
    await outputRunHeader({
      feature: options.feature,
      totalStories: prd.userStories.length,
      pendingStories: prd.userStories.filter((s) => s.status === "pending").length,
      workdir: options.workdir,
      formatterMode: options.formatterMode,
    });
  }

  // Status write point 1: run started
  options.statusWriter.setPrd(prd);
  options.statusWriter.setRunStatus("running");
  options.statusWriter.setCurrentStory(null);
  await options.statusWriter.update(totalCost, iterations);

  // onRunStart is now handled by the reporters.ts subscriber via the run:started event
  // emitted inside executeUnified/executeSequential after bus wiring.

  logger?.info("execution", `Starting ${options.feature}`, {
    totalStories: prd.userStories.length,
    doneStories: prd.userStories.filter((s) => s.status === "passed").length,
    pendingStories: prd.userStories.filter((s) => s.status === "pending").length,
    batchingEnabled: options.useBatch,
  });

  // The LLM routing cache is run-scoped (options.runtime.routingCache, BUG-19)
  // and already starts empty — no explicit clear needed here.

  // Create package directories for stories targeting not-yet-existing packages
  // (new feature on a new package). Must run before any session opens — both the
  // pre-run acceptance pipeline (inside executeUnified) and the execution loop
  // resolve the agent cwd to join(repoRoot, story.workdir); acpx cannot spawn in
  // a nonexistent cwd. Skipped under dryRun so planning never mutates the tree.
  if (!options.dryRun) {
    try {
      const createdDirs = await ensureStoryPackageDirs(prd, options.workdir);
      if (createdDirs.length > 0) {
        // Register the new dirs so quality.commands.setup runs once per package,
        // lazily, before that package's first verify gate (after the implementer
        // scaffolds its manifest).
        markNewPackageDirs(options.runtime, createdDirs);
        logger?.info("execution", "Bootstrapped new package directories", {
          count: createdDirs.length,
          dirs: createdDirs,
        });
      }
    } catch (err) {
      logger?.warn("execution", "Failed to ensure story package directories — continuing", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // PERF-1: Precompute batch plan once from ready stories
  const readyStories = getAllReadyStories(prd);

  // @design: BUG-068: debug log to diagnose unexpected storyCount in batch routing
  logger?.debug("routing", "Ready stories for batch routing", {
    readyCount: readyStories.length,
    readyIds: readyStories.map((s) => s.id),
    allStories: prd.userStories.map((s) => ({
      id: s.id,
      status: s.status,
      passes: s.passes,
      deps: s.dependencies,
    })),
  });

  const batchPlan = options.useBatch ? precomputeBatchPlan(readyStories, 4) : [];

  if (options.useBatch) {
    await tryLlmBatchRoute(options.config, readyStories, "routing", {
      agentManager: options.agentManager,
      runtime: options.runtime,
    });
  }

  const { executeUnified } = await import("./unified-executor");
  const unifiedResult = await executeUnified(
    {
      prdPath: options.prdPath,
      workdir: options.workdir,
      config: options.config,
      hooks: options.hooks,
      feature: options.feature,
      featureDir: options.featureDir,
      dryRun: options.dryRun,
      useBatch: options.useBatch,
      pluginRegistry,
      eventEmitter: options.eventEmitter,
      statusWriter: options.statusWriter,
      logFilePath: options.logFilePath,
      sessionManager: options.sessionManager ?? new SessionManager(),
      runId: options.runId,
      startTime: options.startTime,
      parallelCount: options.parallel,
      agentGetFn: options.agentGetFn,
      abortSignal: options.abortSignal,
      interactionChain: options.interactionChain,
      agentManager: options.agentManager,
      pluginProviderCache: options.pluginProviderCache,
      runtime: options.runtime,
      batchPlan,
    },
    prd,
  );

  // biome-ignore lint/style/noParameterAssign: Update prd state through pipeline
  prd = unifiedResult.prd;
  iterations = unifiedResult.iterations;
  storiesCompleted = unifiedResult.storiesCompleted;
  totalCost = unifiedResult.totalCost;
  allStoryMetrics.push(...unifiedResult.allStoryMetrics);

  // Always let Phase 3 (runCompletionPhase) run to handle setRunStatus,
  // metrics, hooks, and cleanup — the unified executor does not perform these.
  logger?.debug("execution", "Execution phase complete — handing off to completion phase", {
    exitReason: unifiedResult.exitReason,
    iterations,
    storiesCompleted,
    totalCost,
  });
  return {
    prd,
    iterations,
    storiesCompleted,
    totalCost,
    allStoryMetrics,
    deferredReview: unifiedResult.deferredReview,
    deferredReviewStartedAt: unifiedResult.deferredReviewStartedAt,
    exitReason: unifiedResult.exitReason,
  };
}
