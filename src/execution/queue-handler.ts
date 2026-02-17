/**
 * Queue File Handler
 *
 * Provides atomic read/write operations for .queue.txt command files.
 * Uses rename-before-read pattern to prevent race conditions.
 */

import chalk from "chalk";
import path from "node:path";
import { parseQueueFile } from "../queue";
import type { QueueCommand } from "../queue";

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
export async function readQueueFile(workdir: string): Promise<QueueCommand[]> {
  const queuePath = path.join(workdir, ".queue.txt");
  const processingPath = path.join(workdir, ".queue.txt.processing");

  try {
    // Check if queue file exists
    const file = Bun.file(queuePath);
    const exists = await file.exists();
    if (!exists) {
      return [];
    }

    // Atomically rename to .processing (prevents concurrent reads)
    try {
      await Bun.spawn(["mv", queuePath, processingPath], { stdout: "pipe" }).exited;
    } catch (error) {
      // File was already moved by another process, or doesn't exist anymore
      return [];
    }

    // Read from processing file
    const processingFile = Bun.file(processingPath);
    const content = await processingFile.text();
    const result = parseQueueFile(content);

    return result.commands;
  } catch (error) {
    console.warn(chalk.yellow(`   ⚠️  Failed to read queue file: ${(error as Error).message}`));
    return [];
  }
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
  const processingPath = path.join(workdir, ".queue.txt.processing");
  try {
    const file = Bun.file(processingPath);
    const exists = await file.exists();
    if (exists) {
      await Bun.spawn(["rm", processingPath], { stdout: "pipe" }).exited;
    }
  } catch (error) {
    console.warn(chalk.yellow(`   ⚠️  Failed to clear queue file: ${(error as Error).message}`));
  }
}
