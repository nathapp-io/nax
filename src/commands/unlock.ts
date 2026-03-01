/**
 * Unlock command implementation
 *
 * Releases stale locks from crashed nax processes.
 * Checks if lock-holding process is still alive before removing.
 */

import { join } from "node:path";
import chalk from "chalk";

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
 * Check if a process with given PID is still alive
 */
function isProcessAlive(pid: number): boolean {
  try {
    // kill(pid, 0) checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

  // Remove lock file
  const proc = Bun.spawn(["rm", lockPath], { stdout: "pipe" });
  const rmExitCode = await proc.exited;
  if (rmExitCode !== 0) {
    console.error(chalk.red(`Failed to remove lock: rm exited with code ${rmExitCode}`));
    process.exit(1);
  }
  // Wait a bit for filesystem to sync (prevents race in tests)
  await Bun.sleep(10);
  console.log("Lock removed");
  process.exit(0);
}
