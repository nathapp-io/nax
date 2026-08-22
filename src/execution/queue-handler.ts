/**
 * Queue File Handler
 *
 * Provides atomic read/write operations for .queue.txt command files.
 * Uses rename-before-read pattern to prevent race conditions.
 */

import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { validateFilePath } from "../config";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { injectStory, markStorySkipped, resetStoryToPending, setStoryPriority, validateInjectedStory } from "../prd";
import type { PRD } from "../prd";
import { parseQueueFile } from "../queue";
import type { QueueCommand } from "../queue";
import { errorMessage } from "../utils/errors";
import { withQueueFileLock } from "../utils/queue-file-lock";

/**
 * Safely get logger instance, returns null if not initialized
 */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

/**
 * Read and parse queue file atomically.
 * Uses rename-before-read pattern to prevent race conditions:
 * 1. Rename .queue.txt → .queue.txt.processing (atomic operation)
 * 2. Read from .queue.txt.processing
 * 3. Delete .queue.txt.processing after processing
 *
 * This ensures commands written during processing aren't lost.
 *
 * @param workdir - Working directory containing .queue.txt
 * @returns Array of parsed queue commands, or empty array if no queue file
 *
 * @example
 * ```typescript
 * const commands = await readQueueFile("/path/to/project");
 * for (const cmd of commands) {
 *   if (cmd.type === "PAUSE") {
 *     // Handle pause
 *   }
 * }
 * await clearQueueFile("/path/to/project");
 * ```
 */
/**
 * Claim pending commands for processing: return commands already left in
 * `.queue.txt.processing` by a prior crash, or atomically rename
 * `.queue.txt` → `.queue.txt.processing` and read from there. Returns `null`
 * when there is nothing to process (no queue file, or the rename failed).
 * Caller must hold the queue file lock.
 */
async function claimCommandsLocked(
  queuePath: string,
  processingPath: string,
  logger: ReturnType<typeof getSafeLogger>,
): Promise<QueueCommand[] | null> {
  const processingFile = Bun.file(processingPath);
  if (await processingFile.exists()) {
    return parseQueueFile(await processingFile.text()).commands;
  }

  // Check if queue file exists
  const file = Bun.file(queuePath);
  const exists = await file.exists();
  if (!exists) {
    return null;
  }

  // Atomically rename to .processing (prevents concurrent reads).
  // Uses node:fs/promises rename (not a `mv` subprocess) — unlike a spawned
  // `mv`, whose exit code we'd have to inspect manually, `rename()` rejects
  // on failure so a genuine failure (permission denied, cross-device, the
  // file already moved by another process) is always caught here.
  try {
    await rename(queuePath, processingPath);
  } catch (error) {
    logger?.warn("queue", "Failed to rename queue file for processing", {
      error: (error as Error).message,
    });
    return null;
  }

  // Read from processing file
  const claimedFile = Bun.file(processingPath);
  const content = await claimedFile.text();
  const result = parseQueueFile(content);

  return result.commands;
}

export async function readQueueFile(workdir: string): Promise<QueueCommand[]> {
  const queuePath = path.join(workdir, ".queue.txt");
  const processingPath = path.join(workdir, ".queue.txt.processing");
  const logger = getSafeLogger();

  try {
    return await withQueueFileLock(queuePath, async () => {
      const commands = await claimCommandsLocked(queuePath, processingPath, logger);
      return commands ?? [];
    });
  } catch (error) {
    logger?.warn("queue", "Failed to read queue file", {
      error: (error as Error).message,
    });
    return [];
  }
}

/**
 * BUG-11: readQueueFile (claim) and clearQueueFile (mark done) used to be two
 * separate lock acquisitions with arbitrary caller work — PRD mutations, file
 * I/O — running in between. A crash in that window left `.queue.txt.processing`
 * behind with commands that had already been applied, so the next run's
 * readQueueFile re-read and re-applied them (e.g. re-injecting an INJECT
 * command, re-marking a story skipped).
 *
 * processQueueFile claims commands, runs `processor` on them, and clears
 * `.queue.txt.processing` — all inside one queue-file-lock critical section.
 * A crash mid-`processor` still leaves `.queue.txt.processing` in place (so
 * the run retries the same batch on restart, same as before), but there is no
 * longer a window where a crash *after* processing but *before* clearing can
 * cause the batch to be silently re-applied.
 *
 * Returns `undefined` when there was nothing to process (no queue file).
 *
 * `processor` errors are NOT swallowed here — they propagate to the caller,
 * same as before this function existed (queue-check.ts's loop body ran
 * outside any lock and a savePRD failure crashed the pipeline stage
 * normally). Only lock-acquisition failure (queue infra, not caller logic)
 * is caught and logged, matching readQueueFile's existing defensiveness.
 */
export async function processQueueFile<T>(
  workdir: string,
  processor: (commands: QueueCommand[]) => Promise<T>,
): Promise<T | undefined> {
  const queuePath = path.join(workdir, ".queue.txt");
  const processingPath = path.join(workdir, ".queue.txt.processing");
  const logger = getSafeLogger();

  try {
    return await withQueueFileLock(queuePath, async () => {
      const commands = await claimCommandsLocked(queuePath, processingPath, logger);
      if (commands === null) return undefined;

      const result = await processor(commands);
      // EXEC-3: an unlink failure here (permission, transient FS error, AV
      // lock) must not be silently swallowed — a leftover
      // .queue.txt.processing makes the next run's claimCommandsLocked
      // re-apply this already-processed batch, exactly the double-apply
      // BUG-11 built this function to eliminate.
      await unlink(processingPath).catch((error) => {
        logger?.warn("queue", "Failed to clear processed queue file — next run may re-apply this batch", {
          error: (error as Error).message,
          processingPath,
        });
      });
      return result;
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[queue] Timed out acquiring queue lock")) {
      logger?.warn("queue", "Failed to process queue file", { error: error.message });
      return undefined;
    }
    throw error;
  }
}

/** Result of draining the queue at a parallel-batch boundary. */
export interface BatchQueueDrainResult {
  /** True when a PAUSE/ABORT command should stop the coordinator from dispatching further batches. */
  paused: boolean;
  reason?: string;
}

/**
 * BUG-9: apply queued PAUSE/ABORT/RETRY/PRIORITY/INJECT/SKIP commands to the
 * coordinator's root PRD once per parallel-batch boundary.
 *
 * In parallel mode every story's worktree pipeline runs on a stale
 * `structuredClone` of the PRD (`skipPrdPersistence: true`), so `queueCheckStage`
 * now refuses to claim commands there — a cloned pipeline could apply a command
 * and have the queue file cleared underneath it with zero durable effect. This
 * is the coordinator-owned counterpart: it owns the real PRD and runs between
 * batches, so claim → apply → clear is safe here.
 *
 * Deferred by design (D-15): commands take effect at the batch boundary, not
 * mid-batch — immediate cancellation of in-flight worker sessions is separate
 * plumbing. Mutates `prd` in place; the caller is responsible for persisting it
 * (unified-executor already saves the root PRD once per batch boundary).
 */
export async function drainQueueAtBatchBoundary(workdir: string, prd: PRD): Promise<BatchQueueDrainResult> {
  const logger = getSafeLogger();
  const result = (await processQueueFile(workdir, (commands) =>
    applyBatchBoundaryCommands(workdir, prd, commands, logger),
  )) ?? { paused: false };
  if (result.paused) {
    logger?.warn("execution", "Stopping run: queue command applied at batch boundary", { reason: result.reason });
  }
  return result;
}

async function applyBatchBoundaryCommands(
  workdir: string,
  prd: PRD,
  commands: QueueCommand[],
  logger: ReturnType<typeof getSafeLogger>,
): Promise<BatchQueueDrainResult> {
  for (const cmd of commands) {
    if (cmd.type === "PAUSE") {
      logger?.warn("queue", "Paused by user (applied at batch boundary)", { command: "PAUSE" });
      return { paused: true, reason: "User requested pause via .queue.txt" };
    }

    if (cmd.type === "ABORT") {
      logger?.warn("queue", "Aborting: marking remaining stories as skipped (applied at batch boundary)", {});
      for (const s of prd.userStories) {
        if (s.status === "pending") markStorySkipped(prd, s.id);
      }
      return { paused: true, reason: "User requested abort" };
    }

    if (cmd.type === "RETRY") {
      logger?.warn("queue", "Retrying story by user request (applied at batch boundary)", { storyId: cmd.storyId });
      resetStoryToPending(prd, cmd.storyId);
      continue;
    }

    if (cmd.type === "PRIORITY") {
      logger?.warn("queue", "Setting story priority by user request (applied at batch boundary)", {
        storyId: cmd.storyId,
        priority: cmd.value,
      });
      setStoryPriority(prd, cmd.storyId, cmd.value);
      continue;
    }

    if (cmd.type === "SKIP") {
      if (markStorySkipped(prd, cmd.storyId)) {
        logger?.warn("queue", "Skipping story by user request (applied at batch boundary)", { storyId: cmd.storyId });
      } else {
        logger?.warn("queue", "SKIP names a story that is not in the PRD — ignoring", { storyId: cmd.storyId });
      }
      continue;
    }

    if (cmd.type === "INJECT") {
      try {
        if (path.isAbsolute(cmd.storyFile)) {
          throw new NaxError(
            `INJECT storyFile must be a relative path within the workspace: ${cmd.storyFile}`,
            "INJECT_PATH_ABSOLUTE",
            { stage: "queue-check", storyFile: cmd.storyFile },
          );
        }
        const storyFilePath = validateFilePath(path.join(workdir, cmd.storyFile), workdir);
        const raw: unknown = await Bun.file(storyFilePath).json();
        const existingIds = new Set(prd.userStories.map((s) => s.id));
        const story = validateInjectedStory(raw, existingIds);
        injectStory(prd, story);
        logger?.warn("queue", "Injected new story via user request (applied at batch boundary)", {
          injectedStoryId: story.id,
          storyFile: cmd.storyFile,
        });
      } catch (err) {
        logger?.error("queue", "Failed to inject story — skipping INJECT command (batch boundary)", {
          storyFile: cmd.storyFile,
          error: errorMessage(err),
        });
      }
    }
  }

  return { paused: false };
}

/**
 * Clear queue file after processing commands.
 * Deletes .queue.txt.processing file.
 *
 * @param workdir - Working directory containing .queue.txt.processing
 *
 * @example
 * ```typescript
 * const commands = await readQueueFile("/path/to/project");
 * // Process commands...
 * await clearQueueFile("/path/to/project");
 * ```
 */
export async function clearQueueFile(workdir: string): Promise<void> {
  const queuePath = path.join(workdir, ".queue.txt");
  const processingPath = path.join(workdir, ".queue.txt.processing");
  const logger = getSafeLogger();
  try {
    await withQueueFileLock(queuePath, async () => {
      const file = Bun.file(processingPath);
      if (await file.exists()) await unlink(processingPath);
    });
  } catch (error) {
    logger?.warn("queue", "Failed to clear queue file", {
      error: (error as Error).message,
    });
  }
}
