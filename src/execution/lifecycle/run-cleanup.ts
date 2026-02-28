/**
 * Run Cleanup — Finally Block Cleanup Logic
 *
 * Handles cleanup operations that run in the finally block:
 * - Stop heartbeat
 * - Cleanup crash handlers
 * - Fire onRunEnd for reporters
 * - Teardown plugins
 * - Release lock
 */

import { getSafeLogger } from "../../logger";
import type { PluginRegistry } from "../../plugins/registry";
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
}

/**
 * Execute cleanup operations in finally block
 */
export async function cleanupRun(options: RunCleanupOptions): Promise<void> {
  const logger = getSafeLogger();
  const { runId, startTime, totalCost, storiesCompleted, prd, pluginRegistry, workdir } = options;

  // Fire onRunEnd for reporters (even on failure/abort)
  const durationMs = Date.now() - startTime;
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

  // Teardown plugins
  try {
    await pluginRegistry.teardownAll();
  } catch (error) {
    logger?.warn("plugins", "Plugin teardown failed", { error });
  }

  // Always release lock, even if execution fails
  await releaseLock(workdir);
}
