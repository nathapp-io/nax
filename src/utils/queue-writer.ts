/**
 * Queue Writer Utility
 *
 * Writes queue commands (PAUSE/ABORT/SKIP/RETRY/PRIORITY) to the queue file.
 * Used by the TUI to translate keyboard shortcuts into queue commands.
 */

import { appendFile } from "node:fs/promises";
import type { QueueCommand } from "../queue/types";
import { withQueueFileLock } from "./queue-file-lock";

/** Per-file write chains. Exported underscore-prefixed for test introspection only. */
export const _writeChains = new Map<string, Promise<void>>();

/**
 * Write a queue command to the queue file.
 *
 * Appends the command to the queue file in the format expected by parseQueueFile:
 * - PAUSE
 * - ABORT
 * - SKIP <story-id>
 *
 * The queue file is checked by the execution runner between stories.
 *
 * @param queueFilePath - Path to the queue file
 * @param command - Queue command to write
 *
 * @example
 * ```typescript
 * await writeQueueCommand("/tmp/nax/queue.txt", { type: "PAUSE" });
 * await writeQueueCommand("/tmp/nax/queue.txt", { type: "SKIP", storyId: "US-003" });
 * ```
 */
export async function writeQueueCommand(queueFilePath: string, command: QueueCommand): Promise<void> {
  let commandLine: string;

  switch (command.type) {
    case "PAUSE":
      commandLine = "PAUSE";
      break;
    case "ABORT":
      commandLine = "ABORT";
      break;
    case "SKIP":
      commandLine = `SKIP ${command.storyId}`;
      break;
    case "RETRY":
      commandLine = `RETRY ${command.storyId}`;
      break;
    case "PRIORITY":
      commandLine = `PRIORITY ${command.storyId} ${command.value}`;
      break;
    case "INJECT":
      commandLine = `INJECT ${command.storyFile}`;
      break;
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unhandled queue command: ${_exhaustive}`);
    }
  }

  // Serialize writes per file path to prevent read-modify-write races when
  // multiple commands are issued concurrently (e.g. rapid PAUSE + SKIP from TUI).
  const chain = _writeChains.get(queueFilePath) ?? Promise.resolve();
  const next = chain.then(async () => {
    await withQueueFileLock(queueFilePath, () => appendFile(queueFilePath, `${commandLine}\n`, "utf8"));
  });
  const settled = next.catch(() => {});
  _writeChains.set(queueFilePath, settled);
  // Evict the entry once it settles, unless a newer write has already taken its
  // place — keeps the map bounded instead of growing one entry per file path.
  settled.then(() => {
    if (_writeChains.get(queueFilePath) === settled) _writeChains.delete(queueFilePath);
  });
  await next;
}

/**
 * Write a RETRY command for a story, or do nothing when there is nothing to retry.
 *
 * Convenience wrapper used by the TUI "retry last failed" (r) key: it guards on
 * both the target story id and the queue file path so callers can pass the
 * possibly-undefined `lastFailedStoryId` / `queueFilePath` directly without their
 * own branching.
 *
 * @param queueFilePath - Path to the queue file, or undefined if none is wired
 * @param storyId - Id of the story to retry, or undefined if none has failed
 *
 * @example
 * ```typescript
 * await writeRetryCommand(queueFilePath, busState.lastFailedStoryId);
 * ```
 */
export async function writeRetryCommand(queueFilePath: string | undefined, storyId: string | undefined): Promise<void> {
  if (!queueFilePath || !storyId) return;
  await writeQueueCommand(queueFilePath, { type: "RETRY", storyId });
}
