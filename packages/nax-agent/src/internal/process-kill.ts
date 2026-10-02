/**
 * Process Group Kill Utility
 *
 * Shared helper for killing process groups, preventing orphaned child processes.
 * Uses process.kill(-pid, signal) to kill the entire process group.
 */

/**
 * Kill a process group by PID, falling back to single process if group kill fails.
 *
 * Process groups are spawned with the negative PID. This function:
 * 1. Attempts to kill the entire process group (negative PID)
 * 2. Falls back to killing the single process if group kill fails
 *
 * @param pid - Process ID (positive, not negative)
 * @param signal - Signal to send (SIGTERM, SIGKILL, etc.)
 * @returns true if kill was sent successfully, false if process already exited
 *
 * @example
 * ```ts
 * if (killProcessGroup(proc.pid, "SIGTERM")) {
 *   console.log("Process group killed");
 * } else {
 *   console.log("Process already exited");
 * }
 * ```
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals | number): boolean {
  // Try process group kill first (negative PID)
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // ESRCH = no such process — process group doesn't exist, try single process
    if (err.code === "ESRCH") {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        // Process already exited
        return false;
      }
    }
    // Other errors (EPERM, etc.) — signal was likely sent, return true
    return true;
  }
}
