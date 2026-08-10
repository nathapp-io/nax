/**
 * Queue Check Stage
 *
 * Checks for queue commands (PAUSE/ABORT/SKIP) before executing a story.
 * Processes commands atomically and updates PRD accordingly.
 */

import path from "node:path";
import { validateFilePath } from "@/config";
import { NaxError } from "@/errors";
import { errorMessage } from "@/utils/errors";
import { clearQueueFile, readQueueFile } from "../../execution/queue-handler";
import { getLogger } from "../../logger";
import {
  injectStory,
  markStorySkipped,
  resetStoryToPending,
  savePRD,
  setStoryPriority,
  validateInjectedStory,
} from "../../prd";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/**
 * Resolve the PRD path for this pipeline context. Prefers the feature directory
 * when known; falls back to the canonical `.nax/features/unknown/prd.json` path
 * (matching the layout documented in `.gitignore` / `.naxignore` /
 * `src/cli/accept.ts` / `src/cli/features-resolve.ts`) so a missing featureDir
 * never writes an untracked, un-ignored file into the repo root.
 */
function resolvePrdPath(ctx: PipelineContext): string {
  return ctx.featureDir ? `${ctx.featureDir}/prd.json` : `${ctx.workdir}/.nax/features/unknown/prd.json`;
}

/**
 * PAUSE and ABORT stop processing mid-loop and clear the whole queue file — any
 * commands still unprocessed after the current index are lost with no record.
 * That control flow is intentional (a paused/aborted run should not keep applying
 * queued mutations), but the loss must be auditable. Logs one warn naming how many
 * commands were dropped and their types, before the queue file is cleared.
 */
function logDroppedCommands(
  logger: ReturnType<typeof getLogger>,
  ctx: PipelineContext,
  queueCommands: readonly { type: string }[],
  currentIndex: number,
): void {
  const dropped = queueCommands.slice(currentIndex + 1);
  if (dropped.length === 0) {
    return;
  }
  logger.warn("queue", "Dropped unprocessed queue commands", {
    storyId: ctx.story?.id ?? "unknown",
    droppedCount: dropped.length,
    droppedTypes: dropped.map((c) => c.type),
  });
}

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

    for (const [index, cmd] of queueCommands.entries()) {
      if (cmd.type === "PAUSE") {
        logger.warn("queue", "Paused by user", { storyId: ctx.story?.id ?? "unknown", command: "PAUSE" });
        logDroppedCommands(logger, ctx, queueCommands, index);
        await clearQueueFile(ctx.workdir);
        return { action: "pause", reason: "User requested pause via .queue.txt" };
      }

      if (cmd.type === "ABORT") {
        logger.warn("queue", "Aborting: marking remaining stories as skipped", { storyId: ctx.story?.id ?? "unknown" });

        // Mark all pending stories as skipped
        for (const s of ctx.prd.userStories) {
          if (s.status === "pending") {
            markStorySkipped(ctx.prd, s.id);
          }
        }

        // Save PRD path from featureDir
        await savePRD(ctx.prd, resolvePrdPath(ctx));
        logDroppedCommands(logger, ctx, queueCommands, index);
        await clearQueueFile(ctx.workdir);

        return { action: "pause", reason: "User requested abort" };
      }

      if (cmd.type === "RETRY") {
        logger.warn("queue", "Retrying story by user request", { storyId: cmd.storyId });
        resetStoryToPending(ctx.prd, cmd.storyId);

        await savePRD(ctx.prd, resolvePrdPath(ctx));
        continue;
      }

      if (cmd.type === "PRIORITY") {
        logger.warn("queue", "Setting story priority by user request", {
          storyId: cmd.storyId,
          priority: cmd.value,
        });
        setStoryPriority(ctx.prd, cmd.storyId, cmd.value);

        await savePRD(ctx.prd, resolvePrdPath(ctx));
        continue;
      }

      if (cmd.type === "INJECT") {
        try {
          if (path.isAbsolute(cmd.storyFile)) {
            throw new NaxError(
              `INJECT storyFile must be a relative path within the workspace: ${cmd.storyFile}`,
              "INJECT_PATH_ABSOLUTE",
              { stage: "queue-check", storyId: ctx.story?.id ?? "unknown", storyFile: cmd.storyFile },
            );
          }
          const storyFilePath = validateFilePath(path.join(ctx.workdir, cmd.storyFile), ctx.workdir);
          const raw: unknown = await Bun.file(storyFilePath).json();
          const existingIds = new Set(ctx.prd.userStories.map((s) => s.id));
          const story = validateInjectedStory(raw, existingIds);
          injectStory(ctx.prd, story);

          logger.warn("queue", "Injected new story via user request", {
            storyId: ctx.story?.id ?? "unknown",
            injectedStoryId: story.id,
            storyFile: cmd.storyFile,
          });

          await savePRD(ctx.prd, resolvePrdPath(ctx));
        } catch (err) {
          logger.error("queue", "Failed to inject story — skipping INJECT command", {
            storyId: ctx.story?.id ?? "unknown",
            storyFile: cmd.storyFile,
            error: errorMessage(err),
          });
        }
        continue;
      }

      if (cmd.type === "SKIP") {
        logger.warn("queue", "Skipping story by user request", {
          storyId: cmd.storyId,
        });

        // Mark as skipped in PRD unconditionally — matches RETRY / PRIORITY / INJECT,
        // which all mutate ctx.prd regardless of batch membership. Without this, a
        // SKIP naming a story outside the current batch (e.g. sequential mode, where
        // ctx.stories has length 1) is silently discarded by clearQueueFile below.
        // markStorySkipped no-ops for an unknown storyId, same as resetStoryToPending.
        markStorySkipped(ctx.prd, cmd.storyId);
        await savePRD(ctx.prd, resolvePrdPath(ctx));

        // Batch membership is an ADDITIONAL, separate action: if the story is part of
        // the batch currently being executed, also remove it from the batch.
        const isTargeted = ctx.stories.some((s) => s.id === cmd.storyId);
        if (isTargeted) {
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
