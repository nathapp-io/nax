/**
 * Queue Writer Utility
 *
 * Writes queue commands (PAUSE/ABORT/SKIP) to the queue file.
 * Used by the TUI to translate keyboard shortcuts into queue commands.
 */

import type { QueueCommand } from "../queue/types";

const _writeChains = new Map<string, Promise<void>>();

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
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unhandled queue command: ${_exhaustive}`);
    }
  }

  // Serialize writes per file path to prevent read-modify-write races when
  // multiple commands are issued concurrently (e.g. rapid PAUSE + SKIP from TUI).
  const chain = _writeChains.get(queueFilePath) ?? Promise.resolve();
  const next = chain.then(async () => {
    const existing = await Bun.file(queueFilePath)
      .text()
      .catch(() => "");
    const content = existing ? `${existing.trimEnd()}\n${commandLine}\n` : `${commandLine}\n`;
    await Bun.write(queueFilePath, content);
  });
  _writeChains.set(
    queueFilePath,
    next.catch(() => {}),
  );
  await next;
}
