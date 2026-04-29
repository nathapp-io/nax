/**
 * Execution Runner — The Core Loop
 *
 * Orchestrates the agent loop:
 * 1. Load PRD → find next story/batch
 * 2. Run pipeline for each story/batch
 * 3. Handle pipeline results (escalate, mark complete, etc.)
 * 4. Loop until complete or blocked
 *
 * Delegates to extracted modules for each phase:
 * - runner-setup.ts: Initial setup (PRD, status, loggers)
 * - runner-execution.ts: Parallel/sequential execution
 * - runner-completion.ts: Acceptance loop, hooks, metrics
 */

import type { NaxConfig } from "../config";
import { PluginProviderCache } from "../context/engine";
import type { LoadedHooksConfig } from "../hooks";
import { fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import { countStories, isComplete } from "../prd";
import type { PRD } from "../prd/types";
import { gitWithTimeout } from "../utils/git";
import { NAX_VERSION } from "../version";
import { stopHeartbeat } from "./crash-recovery";
import { runCompletionPhase } from "./runner-completion";
import { runExecutionPhase } from "./runner-execution";
import { runSetupPhase } from "./runner-setup";

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
  let runCompleted = false;
  const allStoryMetrics: StoryMetrics[] = [];

  const pluginProviderCache = new PluginProviderCache();

  // Declare prd before crash handler setup to avoid TDZ if SIGTERM arrives during setup
  let prd: PRD | undefined;

  // ── Phase 1: Setup ──────────────────────────────────────────────────────────
  const setupResult = await runSetupPhase({
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
    // @design: BUG-017: Pass getters for run.complete event on SIGTERM
    getStoriesCompleted: () => storiesCompleted,
    getTotalStories: () => (prd ? countStories(prd).total : 0),
  });

  const {
    statusWriter,
    pidRegistry,
    sessionManager,
    cleanupCrashHandlers,
    pluginRegistry,
    interactionChain,
    shutdownController,
    runtime,
  } = setupResult;
  prd = setupResult.prd;
  const agentManager = runtime.agentManager;
  const agentGetFn = agentManager.getAgent.bind(agentManager);

  try {
    // ── Phase 2: Execution ──────────────────────────────────────────────────────
    const executionResult = await runExecutionPhase(
      {
        prdPath,
        workdir,
        config,
        hooks,
        feature,
        featureDir,
        dryRun,
        useBatch,
        eventEmitter,
        statusWriter,
        statusFile,
        logFilePath,
        runId,
        startedAt: runStartedAt,
        startTime,
        formatterMode,
        headless,
        parallel,
        agentGetFn,
        pidRegistry,
        abortSignal: shutdownController.signal,
        interactionChain,
        sessionManager,
        agentManager,
        pluginProviderCache,
        runtime,
      },
      prd,
      pluginRegistry,
    );

    prd = executionResult.prd;
    iterations = executionResult.iterations;
    storiesCompleted = executionResult.storiesCompleted;
    totalCost = executionResult.totalCost;
    allStoryMetrics.push(...executionResult.allStoryMetrics);

    // Return early if parallel execution completed everything.
    // NOTE: This path skips runCompletionPhase, so run:completed is never emitted
    // and runCompleted stays false. cleanupRun will fire onRunEnd directly (correct).
    // If this path is ever activated, also wire run:completed emission here so
    // reporter subscribers and the on-complete hook fire consistently.
    if (executionResult.completedEarly && executionResult.durationMs !== undefined) {
      return {
        success: isComplete(prd),
        iterations,
        storiesCompleted,
        totalCost,
        durationMs: executionResult.durationMs,
      };
    }

    // ── Phase 3: Completion ────────────────────────────────────────────────────
    const completionResult = await runCompletionPhase({
      config,
      hooks,
      feature,
      workdir,
      prdPath,
      statusFile,
      logFilePath,
      runId,
      startedAt: runStartedAt,
      startTime,
      formatterMode,
      headless,
      featureDir,
      prd,
      allStoryMetrics,
      totalCost,
      storiesCompleted,
      iterations,
      statusWriter,
      pluginRegistry,
      eventEmitter,
      agentGetFn,
      sessionManager,
      agentManager,
      pluginProviderCache,
      runtime,
      abortSignal: shutdownController.signal,
    });

    const { durationMs, acceptancePassed } = completionResult;
    runCompleted = true;

    return {
      success: isComplete(prd) && acceptancePassed,
      iterations,
      storiesCompleted,
      totalCost,
      durationMs,
    };
  } finally {
    const logger = getSafeLogger();
    try {
      logger?.debug("execution", "Runner finally block — starting cleanup");
      // Stop heartbeat on any exit (US-007)
      stopHeartbeat();
      // Cleanup crash handlers (MEM-1 fix)
      cleanupCrashHandlers();

      // Phase 3 (#477): sidecar sweep removed — SessionManager.closeStory() handles
      // session cleanup at story completion. Orphan sweep is via SessionManager.sweepOrphans().

      // Resolve current branch at runtime
      let branch = "";
      try {
        const { stdout, exitCode } = await gitWithTimeout(["branch", "--show-current"], workdir);
        if (exitCode === 0) branch = stdout.trim();
      } catch {
        // Branch resolution is non-critical
      }

      // Execute cleanup operations
      logger?.debug("execution", "Runner finally — running cleanupRun");
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
        feature,
        prdPath,
        branch,
        version: NAX_VERSION,
        runCompleted,
      });
      logger?.debug("execution", "Runner finally — cleanupRun done, run() returning");
    } finally {
      await runtime.close();
    }
  }
}

// Re-exports for backward compatibility with existing test imports
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier } from "./escalation";
