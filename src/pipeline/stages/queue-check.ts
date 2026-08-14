/**
 * Queue Check Stage
 *
 * Checks for queue commands (PAUSE/ABORT/SKIP) before executing a story.
 * Processes commands atomically and updates PRD accordingly.
 */

import path from "node:path";
import { validateFilePath } from "@/config";
import { NaxError } from "@/errors";
import { processQueueFile } from "@/execution";
import { getLogger } from "@/logger";
import {
  injectStory,
  markStorySkipped,
  resetStoryToPending,
  savePRD,
  setStoryPriority,
  validateInjectedStory,
} from "@/prd";
import type { QueueCommand } from "@/queue";
import { errorMessage } from "@/utils/errors";
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
 * PAUSE and ABORT stop processing mid-loop, and the whole queue batch is
 * cleared once processQueueCommands returns — any commands still unprocessed
 * after the current index are lost with no record. That control flow is
 * intentional (a paused/aborted run should not keep applying queued
 * mutations), but the loss must be auditable. Logs one warn naming how many
 * commands were dropped and their types, before the batch is cleared.
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
 * BUG-4 follow-up: in parallel mode (`ctx.skipPrdPersistence: true`) the command
 * mutates only the worktree's stale PRD clone — `savePRD` is correctly skipped
 * (see `persistPrd` above) — but the queue batch is still cleared unconditionally
 * once this stage's processor returns, so the command disappears with zero trace.
 * Log which command and target were dropped so the user has a record instead of
 * the command silently vanishing.
 */
function warnUnpersistedCommand(
  logger: ReturnType<typeof getLogger>,
  ctx: PipelineContext,
  detail: { command: string; target?: string },
): void {
  logger.warn(
    "queue",
    "Queue command applied to in-memory PRD but NOT persisted — parallel-mode worktree clone is stale, command will be lost when the queue file is cleared",
    {
      storyId: ctx.story?.id ?? "unknown",
      command: detail.command,
      target: detail.target ?? "unknown",
    },
  );
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

    // BUG-11: claim, process, and clear all happen inside one queue-file-lock
    // critical section (processQueueFile) — a crash between "commands applied"
    // and "processing file cleared" used to leave the same commands to be
    // re-read and re-applied on the next run.
    const result = await processQueueFile(ctx.workdir, (queueCommands) =>
      processQueueCommands(ctx, logger, queueCommands),
    );

    return result ?? { action: "continue" };
  },
};

async function processQueueCommands(
  ctx: PipelineContext,
  logger: ReturnType<typeof getLogger>,
  queueCommands: QueueCommand[],
): Promise<StageResult> {
  if (queueCommands.length === 0) {
    return { action: "continue" };
  }

  // BUG-4: in parallel mode every story's worktree pipeline runs on a
  // structuredClone of the PRD with skipPrdPersistence: true (CR-1 single-writer
  // rule) — this stage must not write that stale clone over prd.json. Mirrors
  // the persistPrd gate in completion.ts / routing.ts.
  const persistPrd = ctx.skipPrdPersistence !== true;

  for (const [index, cmd] of queueCommands.entries()) {
    if (cmd.type === "PAUSE") {
      logger.warn("queue", "Paused by user", { storyId: ctx.story?.id ?? "unknown", command: "PAUSE" });
      logDroppedCommands(logger, ctx, queueCommands, index);
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
      if (persistPrd) {
        await savePRD(ctx.prd, resolvePrdPath(ctx));
      } else {
        warnUnpersistedCommand(logger, ctx, { command: "ABORT" });
      }
      logDroppedCommands(logger, ctx, queueCommands, index);

      return { action: "pause", reason: "User requested abort" };
    }

    if (cmd.type === "RETRY") {
      logger.warn("queue", "Retrying story by user request", { storyId: cmd.storyId });
      resetStoryToPending(ctx.prd, cmd.storyId);

      if (persistPrd) {
        await savePRD(ctx.prd, resolvePrdPath(ctx));
      } else {
        warnUnpersistedCommand(logger, ctx, { command: "RETRY", target: cmd.storyId });
      }
      continue;
    }

    if (cmd.type === "PRIORITY") {
      logger.warn("queue", "Setting story priority by user request", {
        storyId: cmd.storyId,
        priority: cmd.value,
      });
      setStoryPriority(ctx.prd, cmd.storyId, cmd.value);

      if (persistPrd) {
        await savePRD(ctx.prd, resolvePrdPath(ctx));
      } else {
        warnUnpersistedCommand(logger, ctx, { command: "PRIORITY", target: cmd.storyId });
      }
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

        if (persistPrd) {
          await savePRD(ctx.prd, resolvePrdPath(ctx));
        } else {
          warnUnpersistedCommand(logger, ctx, { command: "INJECT", target: story.id });
        }
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
      // Mark as skipped in PRD regardless of batch membership — matches RETRY /
      // PRIORITY / INJECT, which all mutate ctx.prd the same way. Without this, a
      // SKIP naming a story outside the current batch (e.g. sequential mode, where
      // ctx.stories has length 1) is silently discarded once the queue is cleared.
      //
      // Report what actually happened. A SKIP naming a story the PRD does not
      // contain (a typo, a stale id) changes nothing, so announcing a skip and
      // writing the PRD behind it would be two lies and a wasted write.
      if (markStorySkipped(ctx.prd, cmd.storyId)) {
        logger.warn("queue", "Skipping story by user request", { storyId: cmd.storyId });
        if (persistPrd) {
          await savePRD(ctx.prd, resolvePrdPath(ctx));
        } else {
          warnUnpersistedCommand(logger, ctx, { command: "SKIP", target: cmd.storyId });
        }
      } else {
        logger.warn("queue", "SKIP names a story that is not in the PRD — ignoring", {
          storyId: cmd.storyId,
        });
      }

      // Batch membership is an ADDITIONAL, separate action: if the story is part of
      // the batch currently being executed, also remove it from the batch.
      const isTargeted = ctx.stories.some((s) => s.id === cmd.storyId);
      if (isTargeted) {
        ctx.stories = ctx.stories.filter((s) => s.id !== cmd.storyId);

        // If batch is now empty, skip this iteration. This is the third
        // early-return path that drops any still-unprocessed commands (the
        // whole queue is cleared once this function returns), exactly like
        // PAUSE / ABORT do — audit it the same way.
        if (ctx.stories.length === 0) {
          logDroppedCommands(logger, ctx, queueCommands, index);
          return { action: "skip", reason: "All stories in batch were skipped" };
        }
      }
    }
  }

  return { action: "continue" };
}
