/**
 * Timeout Handler Utility
 *
 * Reusable utility for handling process timeouts with graceful SIGTERM→SIGKILL escalation.
 * Ensures all timers are cleaned up in all code paths (exit, timeout, hard deadline).
 */

import { killProcessGroup } from "../utils/process-kill";

export interface ProcessTimeoutOptions {
  /** Grace period in ms between SIGTERM and SIGKILL (default: 5000) */
  graceMs?: number;
  /** Callback when timeout occurs */
  onTimeout?: () => void;
  /** Hard deadline buffer in ms after SIGKILL (default: 3000) */
  hardDeadlineBufferMs?: number;
  /**
   * Optional injectable kill function for testability.
   * Defaults to killProcessGroup(proc.pid, signal).
   */
  killFn?: (proc: { pid: number; kill(signal?: NodeJS.Signals | number): void }, signal: NodeJS.Signals) => void;
}

export interface ProcessTimeoutResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Execute a process with timeout handling.
 *
 * Sends SIGTERM on timeout, followed by SIGKILL after grace period.
 * Ensures all timers are cleared in finally block.
 *
 * @param proc - Subprocess to monitor
 * @param timeoutMs - Timeout in milliseconds
 * @param opts - Timeout options
 * @returns Object with exit code and timeout flag
 */
export async function withProcessTimeout(
  proc: {
    pid: number;
    exited: Promise<number>;
    kill(signal?: NodeJS.Signals | number): void;
  },
  timeoutMs: number,
  opts?: ProcessTimeoutOptions,
): Promise<ProcessTimeoutResult> {
  const graceMs = opts?.graceMs ?? 5000;
  const hardDeadlineBufferMs = opts?.hardDeadlineBufferMs ?? 3000;
  const killFn = opts?.killFn ?? ((p, signal) => killProcessGroup(p.pid, signal));

  let timedOut = false;
  let sigkillId: ReturnType<typeof setTimeout> | undefined;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    opts?.onTimeout?.();
    try {
      killFn(proc, "SIGTERM");
    } catch {
      /* already exited */
    }
    sigkillId = setTimeout(() => {
      try {
        killFn(proc, "SIGKILL");
      } catch {
        /* already exited */
      }
    }, graceMs);
  }, timeoutMs);

  let exitCode: number;
  try {
    const hardDeadlineMs = timeoutMs + graceMs + hardDeadlineBufferMs;
    let hardDeadlineId: ReturnType<typeof setTimeout> | undefined;
    const hardDeadlinePromise = new Promise<number>((resolve) => {
      hardDeadlineId = setTimeout(() => resolve(-1), hardDeadlineMs);
    });

    exitCode = await Promise.race([proc.exited, hardDeadlinePromise]);
    clearTimeout(hardDeadlineId);

    if (exitCode === -1) {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        /* no process group */
      }
    }
  } finally {
    clearTimeout(timeoutId);
    clearTimeout(sigkillId);
  }

  return { exitCode, timedOut };
}
