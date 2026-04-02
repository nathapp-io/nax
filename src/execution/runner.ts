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

import { sweepFeatureSessions } from "../agents/acp/adapter";
import { createAgentRegistry } from "../agents/registry";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import { countStories, isComplete } from "../prd";
import { gitWithTimeout } from "../utils/git";
import { NAX_VERSION } from "../version";
import { stopHeartbeat } from "./crash-recovery";
import { type RunnerCompletionOptions, runCompletionPhase } from "./runner-completion";
import { type RunnerExecutionOptions, runExecutionPhase } from "./runner-execution";
import { type RunnerSetupOptions, runSetupPhase } from "./runner-setup";

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
  // biome-ignore lint/suspicious/noExplicitAny: Metrics array type varies
  const allStoryMetrics: any[] = [];

  const logger = getSafeLogger();

  // Create protocol-aware agent registry (ACP wiring — ACP-003/registry-wiring)
  const registry = createAgentRegistry(config);
  const agentGetFn = registry.getAgent.bind(registry);

  // Declare prd before crash handler setup to avoid TDZ if SIGTERM arrives during setup
  // biome-ignore lint/suspicious/noExplicitAny: PRD type initialized during setup
  let prd: any | undefined;

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
    agentGetFn,
    getTotalCost: () => totalCost,
    getIterations: () => iterations,
    // BUG-017: Pass getters for run.complete event on SIGTERM
    getStoriesCompleted: () => storiesCompleted,
    getTotalStories: () => (prd ? countStories(prd).total : 0),
  });

  const { statusWriter, pidRegistry, cleanupCrashHandlers, pluginRegistry, interactionChain } = setupResult;
  prd = setupResult.prd;

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
        interactionChain,
      },
      prd,
      pluginRegistry,
    );

    prd = executionResult.prd;
    iterations = executionResult.iterations;
    storiesCompleted = executionResult.storiesCompleted;
    totalCost = executionResult.totalCost;
    allStoryMetrics.push(...executionResult.allStoryMetrics);

    // Return early if parallel execution completed everything
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
    });

    const { durationMs } = completionResult;

    return {
      success: isComplete(prd),
      iterations,
      storiesCompleted,
      totalCost,
      durationMs,
    };
  } finally {
    const logger = getSafeLogger();
    logger?.debug("execution", "Runner finally block — starting cleanup");
    // Stop heartbeat on any exit (US-007)
    stopHeartbeat();
    // Cleanup crash handlers (MEM-1 fix)
    cleanupCrashHandlers();

    // Sweep any remaining open ACP sessions for this feature
    logger?.debug("execution", "Runner finally — sweeping ACP sessions");
    await sweepFeatureSessions(workdir, feature).catch(() => {});
    logger?.debug("execution", "Runner finally — ACP sweep done");

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
    });
    logger?.debug("execution", "Runner finally — cleanupRun done, run() returning");
  }
}

// Re-exports for backward compatibility with existing test imports
export { groupStoriesIntoBatches, type StoryBatch } from "./batching";
export { escalateTier } from "./escalation";
