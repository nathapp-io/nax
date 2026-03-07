/**
 * Run Setup — Initial Setup Logic
 *
 * Handles the initial setup phase before the main execution loop:
 * - Status writer initialization
 * - PID registry cleanup
 * - Crash handler installation
 * - Lock acquisition
 * - Plugin loading
 * - PRD loading
 * - Precheck validation
 * - Run initialization
 */

import * as os from "node:os";
import path from "node:path";
import type { NaxConfig } from "../../config";
import { LockAcquisitionError } from "../../errors";
import type { LoadedHooksConfig } from "../../hooks";
import { fireHook } from "../../hooks";
import type { InteractionChain } from "../../interaction";
import { initInteractionChain } from "../../interaction";
import { getSafeLogger } from "../../logger";
import { loadPlugins } from "../../plugins/loader";
import type { PluginRegistry } from "../../plugins/registry";
import type { PRD } from "../../prd";
import { loadPRD } from "../../prd";
import { installCrashHandlers } from "../crash-recovery";
import { acquireLock, hookCtx } from "../helpers";
import { PidRegistry } from "../pid-registry";
import { StatusWriter } from "../status-writer";

export interface RunSetupOptions {
  prdPath: string;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  dryRun: boolean;
  statusFile: string;
  logFilePath?: string;
  runId: string;
  startedAt: string;
  startTime: number;
  skipPrecheck: boolean;
  headless: boolean;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
  getTotalCost: () => number;
  getIterations: () => number;
  // BUG-017: Additional getters for run.complete event on SIGTERM
  getStoriesCompleted: () => number;
  getTotalStories: () => number;
}

export interface RunSetupResult {
  statusWriter: StatusWriter;
  pidRegistry: PidRegistry;
  cleanupCrashHandlers: () => void;
  pluginRegistry: PluginRegistry;
  prd: PRD;
  storyCounts: {
    total: number;
    passed: number;
    pending: number;
    failed: number;
  };
  interactionChain: InteractionChain | null;
}

/**
 * Execute initial setup phase
 */
export async function setupRun(options: RunSetupOptions): Promise<RunSetupResult> {
  const logger = getSafeLogger();
  const {
    prdPath,
    workdir,
    config,
    hooks,
    feature,
    dryRun,
    statusFile,
    logFilePath,
    runId,
    startedAt,
    startTime,
    skipPrecheck,
    headless,
    formatterMode,
    getTotalCost,
    getIterations,
  } = options;

  // ── Status writer (encapsulates status file state and write logic) ───────
  const statusWriter = new StatusWriter(statusFile, config, {
    runId,
    feature,
    startedAt,
    dryRun,
    startTimeMs: startTime,
    pid: process.pid,
  });

  // ── PID registry for orphan process cleanup (BUG-002) ───────
  const pidRegistry = new PidRegistry(workdir);

  // Cleanup stale PIDs from previous crashed runs
  await pidRegistry.cleanupStale();

  // Install crash handlers for signal recovery (US-007, BUG-1+MEM-1 fix: pass getters, cleanup in finally)
  const cleanupCrashHandlers = installCrashHandlers({
    statusWriter,
    getTotalCost,
    getIterations,
    jsonlFilePath: logFilePath,
    pidRegistry,
    // BUG-017: Pass context for run.complete event on SIGTERM
    runId: options.runId,
    feature: options.feature,
    getStartTime: () => options.startTime,
    getTotalStories: options.getTotalStories,
    getStoriesCompleted: options.getStoriesCompleted,
  });

  // Load PRD (before try block so it's accessible in finally for onRunEnd)
  let prd = await loadPRD(prdPath);

  // Initialize interaction chain (US-008) — do this BEFORE precheck so story size prompts can use it
  const interactionChain = await initInteractionChain(config, headless);

  // ── Prime StatusWriter with PRD so precheck-failed can be recorded ─────────
  statusWriter.setPrd(prd);

  // ── Run precheck validations (unless --skip-precheck) ──────────────────────
  if (!skipPrecheck) {
    const { runPrecheckValidation } = await import("./precheck-runner");
    await runPrecheckValidation({
      config,
      prd,
      workdir,
      logFilePath,
      statusWriter,
      headless,
      formatterMode,
      interactionChain,
      featureName: feature,
    });
  } else {
    logger?.warn("precheck", "Precheck validations skipped (--skip-precheck)");
  }

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

  // Log plugins loaded
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
    routingMode,
  });

  // Fire on-start hook
  await fireHook(hooks, "on-start", hookCtx(feature), workdir);

  // Initialize run: check agent, reconcile state, validate limits
  const { initializeRun } = await import("./run-initialization");
  const initResult = await initializeRun({
    config,
    prdPath,
    workdir,
    dryRun,
  });
  prd = initResult.prd;
  const counts = initResult.storyCounts;

  return {
    statusWriter,
    pidRegistry,
    cleanupCrashHandlers,
    pluginRegistry,
    prd,
    storyCounts: counts,
    interactionChain,
  };
}
