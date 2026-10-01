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
import { getLogger } from "../logger";
import type { StoryStatus } from "../prd";
import { errorMessage } from "../utils/errors";

/** Safely get logger instance, returns null if not initialized */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

/**
 * Append a progress entry to progress.txt.
 *
 * BUG-09: this is called from terminal failure paths (tier exhaustion, max
 * attempts, escalation failure) whose whole job is to record that a story
 * failed. An unwritable featureDir (disk full, permission denied) used to
 * throw straight out of here, crashing the failure handler itself — the run
 * would blow up trying to log a failure instead of actually failing that one
 * story. progress.txt is a best-effort audit trail, not load-bearing state,
 * so a write failure is logged and swallowed rather than propagated.
 */
export async function appendProgress(
  featureDir: string,
  storyId: string,
  status: StoryStatus,
  message: string,
): Promise<void> {
  try {
    await mkdir(featureDir, { recursive: true });
    const progressPath = join(featureDir, "progress.txt");
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${storyId} — ${status.toUpperCase()} — ${message}\n`;
    await appendFile(progressPath, entry);
  } catch (error) {
    getSafeLogger()?.warn("execution", "Failed to append progress entry", {
      storyId,
      featureDir,
      error: errorMessage(error),
    });
  }
}
