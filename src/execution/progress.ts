/**
 * Progress Logging
 *
 * Append timestamped entries to progress.txt after story completion.
 *
 * Uses node:fs/promises appendFile instead of Bun.file().text() + Bun.write()
 * to avoid a Bun use-after-free when the Bun.file handle is GC'd alongside
 * a concurrent Bun.write on the same path. appendFile is O_APPEND-safe and
 * does not require a read-modify-write cycle.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { StoryStatus } from "../prd";

/** Append a progress entry to progress.txt */
export async function appendProgress(
  featureDir: string,
  storyId: string,
  status: StoryStatus,
  message: string,
): Promise<void> {
  await mkdir(featureDir, { recursive: true });
  const progressPath = join(featureDir, "progress.txt");
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${storyId} — ${status.toUpperCase()} — ${message}\n`;
  await appendFile(progressPath, entry);
}
