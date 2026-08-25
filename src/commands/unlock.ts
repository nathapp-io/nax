/**
 * Unlock command implementation
 *
 * Releases stale locks from crashed nax processes.
 * Checks if lock-holding process is still alive before removing.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { isProcessAlive } from "@/utils/process-alive";

/**
 * Options for unlock command
 */
export interface UnlockOptions {
  /** Explicit project directory (from -d flag) */
  dir?: string;
  /** Force unlock without liveness check (from --force flag) */
  force?: boolean;
}

/**
 * Format lock age in minutes
 */
function formatLockAge(ageMs: number): string {
  const minutes = Math.round(ageMs / (60 * 1000));
  return `${minutes} min`;
}

/**
 * Run unlock command
 *
 * Reads nax.lock, checks if holding process is alive, and removes lock if safe.
 * Exits with code 0 on success, 1 on failure.
 */
export async function unlockCommand(options: UnlockOptions): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const lockPath = join(workdir, "nax.lock");

  // Check if lock file exists
  const lockFile = Bun.file(lockPath);
  const exists = await lockFile.exists();

  if (!exists) {
    console.log("No lock file found");
    process.exit(0);
  }

  // Read lock file
  let lockData: { pid: number; timestamp: number };
  try {
    const lockContent = await lockFile.text();
    lockData = JSON.parse(lockContent);
  } catch (error) {
    console.error(chalk.red("Failed to parse lock file"));
    process.exit(1);
  }

  const { pid, timestamp } = lockData;
  const ageMs = Date.now() - timestamp;

  // Check if process is alive (unless --force)
  if (!options.force) {
    if (isProcessAlive(pid)) {
      console.error(chalk.red(`nax is still running (PID ${pid}). Use --force to override.`));
      process.exit(1);
    }
  }

  // Print lock info before removing
  console.log(`Stale lock found (PID ${pid}, age: ${formatLockAge(ageMs)})`);

  // TOCTOU guard: re-read the lock file and re-verify the PID immediately before
  // deleting it. A new run could have acquired the lock in the window between the
  // liveness check above and this point — deleting unconditionally would wrongly
  // remove that new run's lock. Only delete if the PID we're about to remove is
  // still the one on disk.
  if (!options.force) {
    let currentLockData: { pid: number; timestamp: number };
    try {
      const currentContent = await Bun.file(lockPath).text();
      currentLockData = JSON.parse(currentContent);
    } catch {
      console.log("Lock file disappeared before removal — nothing to do");
      process.exit(0);
    }
    if (currentLockData.pid !== pid) {
      console.error(
        chalk.red(`Lock now held by a different PID (${currentLockData.pid}) — refusing to remove. Re-run nax unlock.`),
      );
      process.exit(1);
    }
  }

  // Remove lock file — native unlink, not a shelled-out `rm` (portable across
  // systems/PATHs without an `rm` binary).
  try {
    await unlink(lockPath);
  } catch (error) {
    console.error(chalk.red(`Failed to remove lock: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
  // Wait a bit for filesystem to sync (prevents race in tests)
  await Bun.sleep(10);
  console.log("Lock removed");
  process.exit(0);
}
