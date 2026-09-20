/**
 * Run Cleanup — Finally Block Cleanup Logic
 *
 * Handles cleanup operations that run in the finally block:
 * - Stop heartbeat
 * - Cleanup crash handlers
 * - Fire onRunEnd for reporters
 * - Execute post-run actions sequentially
 * - Teardown plugins
 * - Release lock
 */

import { packageConfigCache } from "@/config";
import { disposeFeatureResolver } from "@/context";
import { _resetCanonicalRulesCache } from "@/context/engine";
import { fireHook, type HookContext, type LoadedHooksConfig } from "@/hooks";
import type { InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import type {
  IPostRunAction,
  PluginLogger,
  PluginRegistry,
  PostRunActionRegistration,
  PostRunActionResult,
  PostRunContext,
} from "@/plugins";
import { countStories, type PRD } from "@/prd";
import { clearLanguageCache } from "@/project";
import { clearWorkspaceCache } from "@/test-runners/detect";
import { errorMessage } from "@/utils/errors";
import { clearGitRootCache } from "@/verification";
import { resetRuntimeCrashRetryCounts } from "../escalation";
import { releaseLock } from "../helpers";
// Sibling import: the wipe is a local lifecycle module, and routing it through
// the lifecycle barrel would point this module at its own barrel to reach the
// file next door.
import { wipeScratchpad } from "./scratchpad-wipe";

type PostRunActionOutcome =
  | { status: "succeeded"; message: string; url?: string }
  | { status: "failed"; message: string; url?: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

export const _runCleanupDeps = {
  fireHook,
  resetRuntimeCrashRetryCounts,
  clearLanguageCache,
  clearWorkspaceCache,
  clearGitRootCache,
  resetCanonicalRulesCache: _resetCanonicalRulesCache,
  clearPackageConfigCache: () => packageConfigCache.clear(),
  // US-004 — end-of-run scratchpad wipe. Injected so the test can stub a
  // fail-open path without monkey-patching Bun.file / fs.rm.
  wipeScratchpad,
};

export interface RunCleanupOptions {
  runId: string;
  startTime: number;
  totalCost: number;
  storiesCompleted: number;
  prd: PRD;
  pluginRegistry: PluginRegistry;
  workdir: string;
  interactionChain: InteractionChain | null;
  feature: string;
  prdPath: string;
  branch: string;
  version: string;
  hooks: LoadedHooksConfig;
  /**
   * True when run:completed was already emitted (success path).
   * When true, skip the direct onRunEnd call — the reporters.ts subscriber
   * handles it via the event. Only fire directly for abnormal exits where
   * run:completed was never emitted.
   */
  runCompleted?: boolean;
  /**
   * US-004 — dry-run flag forwarded from runner.ts. Gated on together with
   * `runCompleted` to decide whether the end-of-run scratchpad wipe fires:
   * a successful dry run never wrote to the scratchpad (no story dispatched)
   * and a preview is not a mutation, so the wipe is skipped.
   */
  dryRun: boolean;
  /** Project output directory (for curator and other plugins) */
  outputDir?: string;
  /** Global output directory (for curator and other plugins) */
  globalDir?: string;
  /** Project key (for curator and other plugins) */
  projectKey?: string;
  /** Path to curator rollup file (for curator plugin) */
  curatorRollupPath?: string;
  /** Path to active run JSONL (for curator and other plugins) */
  logFilePath?: string;
  /** Full nax config (for curator and other plugins) */
  config?: unknown;
}

async function settlePostRunAction(action: IPostRunAction, ctx: PostRunContext): Promise<PostRunActionOutcome> {
  try {
    if (!(await action.shouldRun(ctx))) return { status: "skipped", reason: "shouldRun=false" };
    return outcomeFromResult(await action.execute(ctx));
  } catch (error) {
    return { status: "error", reason: errorMessage(error) };
  }
}

function outcomeFromResult(result: PostRunActionResult): PostRunActionOutcome {
  if (result.skipped) return { status: "skipped", reason: result.reason ?? result.message };
  if (!result.success) return { status: "failed", message: result.message, url: result.url };
  return { status: "succeeded", message: result.message, url: result.url };
}

function logPostRunOutcome(actionName: string, outcome: PostRunActionOutcome): void {
  const logger = getSafeLogger();
  if (outcome.status === "skipped") {
    const level = outcome.reason === "shouldRun=false" ? "debug" : "info";
    logger?.[level]("post-run", `[post-run] ${actionName}: skipped — ${outcome.reason}`);
  } else if (outcome.status === "failed") {
    logger?.warn("post-run", `[post-run] ${actionName}: failed — ${outcome.message}`);
  } else if (outcome.status === "error") {
    logger?.warn("post-run", `[post-run] ${actionName}: error — ${outcome.reason}`);
  } else {
    const suffix = outcome.url ? `${outcome.message} (${outcome.url})` : outcome.message;
    logger?.info("post-run", `[post-run] ${actionName}: ${suffix}`);
  }
}

function postRunHookContext(
  feature: string,
  registration: PostRunActionRegistration,
  outcome: PostRunActionOutcome,
): HookContext {
  const reason = outcome.status === "succeeded" || outcome.status === "failed" ? outcome.message : outcome.reason;
  return {
    event: "on-post-run-action",
    feature,
    pluginName: registration.pluginName,
    actionName: registration.action.name,
    status: outcome.status,
    reason,
    url: "url" in outcome ? outcome.url : undefined,
  };
}

async function runPostRunActions(options: RunCleanupOptions, ctx: PostRunContext): Promise<void> {
  const registrations = options.pluginRegistry.getPostRunActionRegistrations();
  for (const registration of registrations) {
    const outcome = await settlePostRunAction(registration.action, ctx);
    logPostRunOutcome(registration.action.name, outcome);
    try {
      await _runCleanupDeps.fireHook(
        options.hooks,
        "on-post-run-action",
        postRunHookContext(options.feature, registration, outcome),
        options.workdir,
      );
    } catch (error) {
      getSafeLogger()?.warn("hooks", `on-post-run-action hook failed for '${registration.pluginName}'`, { error });
    }
  }
}

/**
 * Build PostRunContext from RunCleanupOptions and run duration.
 */
export function buildPostRunContext(opts: RunCleanupOptions, durationMs: number, logger: PluginLogger): PostRunContext {
  const {
    runId,
    feature,
    workdir,
    prdPath,
    branch,
    version,
    totalCost,
    storiesCompleted,
    prd,
    outputDir,
    globalDir,
    projectKey,
    curatorRollupPath,
    logFilePath,
    config,
    startTime,
  } = opts;
  const counts = countStories(prd);

  return {
    runId,
    feature,
    workdir,
    prdPath,
    branch,
    version,
    totalDurationMs: durationMs,
    runStartedAt: startTime,
    totalCost,
    storySummary: {
      completed: storiesCompleted,
      failed: counts.failed,
      skipped: counts.skipped,
      paused: counts.paused,
    },
    stories: prd.userStories,
    pluginConfig: {},
    logger,
    outputDir,
    globalDir,
    projectKey,
    curatorRollupPath,
    logFilePath,
    config,
  };
}

/**
 * Execute cleanup operations in finally block
 */
export async function cleanupRun(options: RunCleanupOptions): Promise<void> {
  const logger = getSafeLogger();
  const { runId, startTime, totalCost, storiesCompleted, prd, pluginRegistry, workdir, interactionChain } = options;

  const durationMs = Date.now() - startTime;

  // Fire onRunEnd for reporters only on abnormal exits (failure/abort/SIGTERM).
  // On the success path, run:completed is emitted by run-completion.ts and the
  // reporters.ts subscriber handles onRunEnd via the event — so we skip the
  // direct call to avoid duplicate notifications.
  if (!options.runCompleted) {
    const finalCounts = countStories(prd);
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
  }

  // Execute post-run actions sequentially after reporters.onRunEnd()
  // `data` must be forwarded, not dropped: PluginLogger's contract is
  // (message, data), and every post-run action relies on it — each one's catch
  // path logs `{ error: String(err) }`, and nax-finish logs the finish flow's
  // stdout/stderr there. Swallowing the third argument silently discarded all
  // of it, leaving bare messages with no cause attached. Secrets are handled
  // downstream: the Logger write path runs `redactEntry` over message + data.
  const pluginLogger: PluginLogger = {
    debug: (msg: string, data?: Record<string, unknown>) => logger?.debug("post-run", msg, data),
    info: (msg: string, data?: Record<string, unknown>) => logger?.info("post-run", msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => logger?.warn("post-run", msg, data),
    error: (msg: string, data?: Record<string, unknown>) => logger?.error("post-run", msg, data),
  };
  const ctx = buildPostRunContext(options, durationMs, pluginLogger);

  await runPostRunActions(options, ctx);

  // Teardown plugins
  try {
    await pluginRegistry.teardownAll();
  } catch (error) {
    logger?.warn("plugins", "Plugin teardown failed", { error });
  }

  // Destroy interaction chain (US-008)
  if (interactionChain) {
    try {
      await interactionChain.destroy();
      logger?.debug("interaction", "Interaction chain destroyed");
    } catch (error) {
      logger?.warn("interaction", "Interaction chain cleanup failed", { error });
    }
  }

  // Release per-workdir feature resolver index to prevent memory leak across runs
  disposeFeatureResolver(workdir);

  // BUG-15: clear the runtime-crash retry budget so the next run in this
  // process starts with a fresh budget (tests, watch mode).
  _runCleanupDeps.resetRuntimeCrashRetryCounts();

  // MEM-7: clear per-run detection memos so subsequent runs in the same process
  // start fresh. These live in the finally (cleanupRun), not in run-completion:
  // completion is inside the runner try, so a throw out of setup or execution
  // would otherwise leave all four process-lifetime memos stale.
  _runCleanupDeps.clearLanguageCache();
  _runCleanupDeps.clearWorkspaceCache();
  _runCleanupDeps.clearGitRootCache();
  _runCleanupDeps.clearPackageConfigCache();
  // CTX-2: canonical-rules memoization joins the same per-run-cache-clear
  // convention as the caches above — without this, a long-lived in-process
  // consumer (embedded TUI, watch mode) would keep serving the first run's
  // .nax/rules/ content to every subsequent run in the same process.
  _runCleanupDeps.resetCanonicalRulesCache();

  // US-004 — end-of-run scratchpad wipe. The run-start wipe (run-setup-init.ts)
  // remains the backstop that guarantees a clean slate however the previous run
  // died (SIGKILL, hard crash, power loss). This wipe is the load-bearing
  // promise the agents advertise: "nothing there survives the run". Gated on
  // `runCompleted && !dryRun` because a failed run's scratchpad is retained
  // for inspection (bounded by the next run's start wipe) and a dry run never
  // wrote anything to the scratchpad in the first place. Fail-open by design:
  // a wipe that rejects is logged at warn, and run success is unaffected —
  // `cleanupRun` is the finally block, and the run has already committed to
  // its success/failure verdict before this line is reached.
  if (options.runCompleted && !options.dryRun) {
    try {
      await _runCleanupDeps.wipeScratchpad(workdir);
    } catch (err) {
      logger?.warn("cleanup", "End-of-run scratchpad wipe failed — continuing", {
        workdir,
        error: errorMessage(err),
      });
    }
  }

  // Always release lock, even if execution fails
  await releaseLock(workdir);
}
