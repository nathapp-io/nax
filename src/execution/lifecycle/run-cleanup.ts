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

import { disposeFeatureResolver } from "../../context";
import type { InteractionChain } from "../../interaction";
import { getSafeLogger } from "../../logger";
import type { PostRunContext } from "../../plugins/extensions";
import type { PluginRegistry } from "../../plugins/registry";
import type { PluginLogger } from "../../plugins/types";
import { countStories } from "../../prd";
import type { PRD } from "../../prd";
import { releaseLock } from "../helpers";

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
  /**
   * True when run:completed was already emitted (success path).
   * When true, skip the direct onRunEnd call — the reporters.ts subscriber
   * handles it via the event. Only fire directly for abnormal exits where
   * run:completed was never emitted.
   */
  runCompleted?: boolean;
}

/**
 * Build PostRunContext from RunCleanupOptions and run duration.
 */
export function buildPostRunContext(opts: RunCleanupOptions, durationMs: number, logger: PluginLogger): PostRunContext {
  const { runId, feature, workdir, prdPath, branch, version, totalCost, storiesCompleted, prd } = opts;
  const counts = countStories(prd);

  return {
    runId,
    feature,
    workdir,
    prdPath,
    branch,
    version,
    totalDurationMs: durationMs,
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
  const actions = pluginRegistry.getPostRunActions();
  const pluginLogger: PluginLogger = {
    debug: (msg: string) => logger?.debug("post-run", msg),
    info: (msg: string) => logger?.info("post-run", msg),
    warn: (msg: string) => logger?.warn("post-run", msg),
    error: (msg: string) => logger?.error("post-run", msg),
  };
  const ctx = buildPostRunContext(options, durationMs, pluginLogger);

  for (const action of actions) {
    try {
      const shouldRun = await action.shouldRun(ctx);
      if (!shouldRun) {
        logger?.debug("post-run", `[post-run] ${action.name}: shouldRun=false, skipping`);
        continue;
      }
      const result = await action.execute(ctx);
      if (result.skipped) {
        logger?.info("post-run", `[post-run] ${action.name}: skipped — ${result.reason}`);
      } else if (!result.success) {
        logger?.warn("post-run", `[post-run] ${action.name}: failed — ${result.message}`);
      } else {
        const msg = result.url
          ? `[post-run] ${action.name}: ${result.message} (${result.url})`
          : `[post-run] ${action.name}: ${result.message}`;
        logger?.info("post-run", msg);
      }
    } catch (error) {
      logger?.warn("post-run", `[post-run] ${action.name}: error — ${error}`);
    }
  }

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

  // Always release lock, even if execution fails
  await releaseLock(workdir);
}
