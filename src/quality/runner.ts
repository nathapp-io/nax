/**
 * Quality Command Runner
 *
 * Shared utility for spawning quality check processes (lint, typecheck, build,
 * lintFix, formatFix) with a hard timeout, concurrent stdout/stderr draining,
 * and structured logging.
 *
 * All callers that previously spawned quality processes inline should use
 * runQualityCommand() instead. (#135)
 */

import { spawn } from "bun";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";

/** Default timeout for quality commands — matches legacy REVIEW_CHECK_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Grace period between SIGTERM and SIGKILL on timeout. */
const SIGKILL_GRACE_PERIOD_MS = 5_000;

export interface QualityCommandOptions {
  /** Short name used in logs (e.g. "lint", "typecheck", "lintFix"). */
  commandName: string;
  /** Full shell command string (e.g. "bun run lint"). */
  command: string;
  /** Working directory for the spawned process. */
  workdir: string;
  /** Optional story ID for log correlation. */
  storyId?: string;
  /** Hard timeout in milliseconds. Defaults to 120 000 ms. */
  timeoutMs?: number;
}

export interface QualityCommandResult {
  commandName: string;
  command: string;
  success: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Injectable dependencies — allows tests to swap out Bun.spawn without
 * mock.module() (BUG-035 pattern).
 *
 * @internal
 */
export const _qualityRunnerDeps = {
  spawn: spawn as typeof Bun.spawn,
};

/**
 * Spawn a quality-check command, collect its output, and enforce a hard
 * timeout with SIGTERM → SIGKILL escalation.
 *
 * stdout and stderr are drained concurrently with proc.exited via Promise.all
 * to avoid deadlocking on output larger than the OS pipe buffer (~64 KB).
 */
export async function runQualityCommand(opts: QualityCommandOptions): Promise<QualityCommandResult> {
  const { commandName, command, workdir, storyId, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const startTime = Date.now();
  const logger = getSafeLogger();

  logger?.info("quality", `Running ${commandName}`, { storyId, commandName, command, workdir });

  try {
    const parts = command.split(/\s+/);
    const [executable, ...args] = parts;

    const proc = _qualityRunnerDeps.spawn({
      cmd: [executable, ...args],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, SIGKILL_GRACE_PERIOD_MS);
    }, timeoutMs);

    // Drain stdout and stderr concurrently with proc.exited to avoid deadlock
    // when process output exceeds the OS pipe buffer (~64 KB).
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    clearTimeout(killTimer);

    const durationMs = Date.now() - startTime;

    if (timedOut) {
      logger?.warn("quality", `${commandName} timed out`, {
        storyId,
        commandName,
        command,
        workdir,
        durationMs,
        timedOut: true,
      });
      return {
        commandName,
        command,
        success: false,
        exitCode: -1,
        output: `[nax] ${commandName} timed out after ${timeoutMs / 1000}s`,
        durationMs,
        timedOut: true,
      };
    }

    const output = [stdout, stderr].filter(Boolean).join("\n");
    const success = exitCode === 0;

    logger?.info("quality", `${commandName} completed`, {
      storyId,
      commandName,
      command,
      workdir,
      exitCode,
      durationMs,
      timedOut: false,
    });

    return { commandName, command, success, exitCode, output, durationMs, timedOut: false };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    return {
      commandName,
      command,
      success: false,
      exitCode: -1,
      output: errorMessage(error),
      durationMs,
      timedOut: false,
    };
  }
}
