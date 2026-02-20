/**
 * Queue Check Stage
 *
 * Checks for queue commands (PAUSE/ABORT/SKIP) before executing a story.
 * Processes commands atomically and updates PRD accordingly.
 */

import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { readQueueFile, clearQueueFile } from "../../execution/queue-handler";
import { markStorySkipped, savePRD } from "../../prd";
import { getLogger } from "../../logger";

/**
 * Queue Check Stage
 *
 * Checks for queue commands (PAUSE/ABORT/SKIP) before executing a story.
 * If a command is found, processes it and returns appropriate action.
 *
 * @returns
 * - `continue`: No queue commands, proceed
 * - `pause`: PAUSE/ABORT command found, stop execution
 * - `skip`: SKIP command removed all stories from batch
 *
 * @example
 * ```ts
 * // User writes: echo "PAUSE" > .queue.txt
 * const result = await queueCheckStage.execute(ctx);
 * // result: { action: "pause", reason: "User requested pause via .queue.txt" }
 * ```
 */
export const queueCheckStage: PipelineStage = {
  name: "queue-check",
  enabled: () => true,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const queueCommands = await readQueueFile(ctx.workdir);

    if (queueCommands.length === 0) {
      return { action: "continue" };
    }

    for (const cmd of queueCommands) {
      if (cmd.type === "PAUSE") {
        logger.warn("queue", "Paused by user", { command: "PAUSE" });
        await clearQueueFile(ctx.workdir);
        return { action: "pause", reason: "User requested pause via .queue.txt" };
      }

      if (cmd.type === "ABORT") {
        logger.warn("queue", "Aborting: marking remaining stories as skipped");

        // Mark all pending stories as skipped
        ctx.prd.userStories.forEach((s) => {
          if (s.status === "pending") {
            markStorySkipped(ctx.prd, s.id);
          }
        });

        // Save PRD path from featureDir
        const prdPath = ctx.featureDir
          ? `${ctx.featureDir}/prd.json`
          : `${ctx.workdir}/nax/features/unknown/prd.json`;
        await savePRD(ctx.prd, prdPath);
        await clearQueueFile(ctx.workdir);

        return { action: "pause", reason: "User requested abort" };
      }

      if (cmd.type === "SKIP") {
        // Check if this SKIP applies to any story in the current batch
        const isTargeted = ctx.stories.some((s) => s.id === cmd.storyId);

        if (isTargeted) {
          logger.warn("queue", "Skipping story by user request", {
            storyId: cmd.storyId,
          });

          // Mark as skipped in PRD
          markStorySkipped(ctx.prd, cmd.storyId);

          // Save PRD
          const prdPath = ctx.featureDir
            ? `${ctx.featureDir}/prd.json`
            : `${ctx.workdir}/nax/features/unknown/prd.json`;
          await savePRD(ctx.prd, prdPath);

          // Remove from batch
          ctx.stories = ctx.stories.filter((s) => s.id !== cmd.storyId);

          // If batch is now empty, skip this iteration
          if (ctx.stories.length === 0) {
            await clearQueueFile(ctx.workdir);
            return { action: "skip", reason: "All stories in batch were skipped" };
          }
        }
      }
    }

    // Clear processed commands
    await clearQueueFile(ctx.workdir);

    return { action: "continue" };
  },
};
