/**
 * Runner Setup Phase
 *
 * Handles initial setup: loading PRD, initializing status, loggers, and crash handlers.
 * Extracted from runner.ts for better code organization.
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import type { AgentGetFn } from "../pipeline/types";

/**
 * Options for the setup phase.
 */
export interface RunnerSetupOptions {
  prdPath: string;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  featureDir?: string;
  dryRun: boolean;
  statusFile: string;
  logFilePath?: string;
  runId: string;
  startedAt: string;
  startTime: number;
  skipPrecheck?: boolean;
  headless?: boolean;
  formatterMode?: "quiet" | "normal" | "verbose" | "json";
  getTotalCost: () => number;
  getIterations: () => number;
  getStoriesCompleted: () => number;
  getTotalStories: () => number;
  /** Protocol-aware agent resolver — bound from agentManager.getAgent in runner.ts */
  agentGetFn?: AgentGetFn;
  /** Per-run AgentManager (ADR-012). When provided, validateCredentials() is called during setup. */
  agentManager?: import("../agents").IAgentManager;
}

/**
 * Result from the setup phase.
 */
export interface RunnerSetupResult {
  statusWriter: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["statusWriter"];
  pidRegistry: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["pidRegistry"];
  sessionManager: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["sessionManager"];
  cleanupCrashHandlers: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["cleanupCrashHandlers"];
  pluginRegistry: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["pluginRegistry"];
  storyCounts: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["storyCounts"];
  interactionChain: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["interactionChain"];
  prd: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["prd"];
  shutdownController: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["shutdownController"];
  runtime: Awaited<ReturnType<typeof import("./lifecycle/run-setup").setupRun>>["runtime"];
}

/**
 * Execute the setup phase of the run.
 *
 * @param options - Setup options
 * @returns Setup result with initialized components
 */
export async function runSetupPhase(options: RunnerSetupOptions): Promise<RunnerSetupResult> {
  // ── Execute initial setup phase ──────────────────────────────────────────────
  const { setupRun } = await import("./lifecycle/run-setup");
  const setupResult = await setupRun({
    prdPath: options.prdPath,
    workdir: options.workdir,
    config: options.config,
    hooks: options.hooks,
    feature: options.feature,
    featureDir: options.featureDir,
    dryRun: options.dryRun,
    statusFile: options.statusFile,
    logFilePath: options.logFilePath,
    runId: options.runId,
    startedAt: options.startedAt,
    startTime: options.startTime,
    skipPrecheck: options.skipPrecheck ?? false,
    headless: options.headless ?? false,
    formatterMode: options.formatterMode ?? "normal",
    getTotalCost: options.getTotalCost,
    getIterations: options.getIterations,
    // @design: BUG-017: Pass getters for run.complete event on SIGTERM
    getStoriesCompleted: options.getStoriesCompleted,
    getTotalStories: options.getTotalStories,
    agentGetFn: options.agentGetFn,
    agentManager: options.agentManager,
  });

  return setupResult;
}
