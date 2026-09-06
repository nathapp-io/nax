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
import { killProcessGroup } from "../utils/process-kill";

/** Default timeout for quality commands — matches legacy REVIEW_CHECK_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Grace period between SIGTERM and SIGKILL on timeout. */
const SIGKILL_GRACE_PERIOD_MS = 5_000;
const STREAM_DRAIN_TIMEOUT_MS = 2_000;

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
  /** Optional environment overrides for the spawned process. */
  env?: Record<string, string | undefined>;
  /** Secret env var names to strip before spawning the shell command. */
  stripEnvVars?: string[];
  /**
   * Who invoked this run. Defaults to `"harness"`.
   *
   * `"agent-tool"` marks the agent's own iteration loop arriving through the
   * `RunCommand` coding tool (src/tools/run-command.ts). Those records are
   * demoted to debug: they still reach the JSONL (the file sink writes every
   * level) but stay off the console, because a failing lint there is normal TDD
   * red rather than a harness fault — and because on the acpx transport the
   * identical loop runs inside the spawned agent process, where nax never sees
   * it at all. Leaving them at info made the two transports produce wildly
   * different logs for the same work: one observed native run emitted 289
   * quality pairs, 283 of them (98%) from this path.
   */
  origin?: "harness" | "agent-tool";
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

function createDrainDeadline(deadlineMs: number): { promise: Promise<string>; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<string>((resolve) => {
    timeoutId = setTimeout(() => resolve(""), deadlineMs);
  });
  return {
    promise,
    cancel: () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * Spawn a quality-check command, collect its output, and enforce a hard
 * timeout with SIGTERM → SIGKILL escalation.
 *
 * stdout and stderr are drained concurrently with proc.exited via Promise.all
 * to avoid deadlocking on output larger than the OS pipe buffer (~64 KB).
 */
export async function runQualityCommand(opts: QualityCommandOptions): Promise<QualityCommandResult> {
  const {
    commandName,
    command,
    workdir,
    storyId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env,
    stripEnvVars,
    origin = "harness",
  } = opts;

  if (!command || command.trim() === "") {
    return {
      commandName,
      command,
      success: false,
      exitCode: -1,
      output: `[nax] ${commandName} skipped: empty command`,
      durationMs: 0,
      timedOut: false,
    };
  }

  const startTime = Date.now();
  const logger = getSafeLogger();
  // Console level follows the caller, not the outcome — see `origin` above.
  const level = origin === "agent-tool" ? "debug" : "info";

  logger?.[level]("quality", `Running ${commandName}`, { storyId, commandName, command, workdir });

  try {
    // Build the base env, stripping any configured secret vars before spawning.
    const baseEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
    };
    for (const key of stripEnvVars ?? []) {
      delete baseEnv[key];
    }

    // Execute via shell to preserve quoting semantics of configured commands.
    // Splitting on whitespace loses quoted args and escaped spaces.
    const proc = _qualityRunnerDeps.spawn({
      cmd: ["/bin/sh", "-c", command],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...baseEnv, ...(env ?? {}) },
      // Bun.spawn does not setpgid children into their own group by default, so
      // killProcessGroup(-pid) on timeout would target a group the shell isn't
      // actually the leader of (ESRCH -> falls back to killing only the /bin/sh
      // wrapper, leaking the real grandchild process). `detached` makes this
      // process a session/group leader via setsid(), so its own pid IS the real
      // pgid. Mirrors executeWithTimeout in verification/executor.ts.
      detached: true,
    });

    let timedOut = false;
    let exitedBeforeSigkill = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    // Track process exit so SIGKILL is skipped if the process already died during the grace period.
    proc.exited
      .then(() => {
        exitedBeforeSigkill = true;
      })
      // Floating by design (the flag defaults to the safe value); .catch keeps a
      // rejected proc.exited from surfacing as an unhandled rejection, which the
      // crash handler would escalate to a full teardown.
      .catch(() => {});

    const killTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc.pid, "SIGTERM");
      sigkillTimer = setTimeout(() => {
        sigkillTimer = undefined;
        if (!exitedBeforeSigkill) {
          killProcessGroup(proc.pid, "SIGKILL");
        }
      }, SIGKILL_GRACE_PERIOD_MS);
    }, timeoutMs);

    // Drain stdout and stderr concurrently with proc.exited to avoid deadlock
    // when process output exceeds the OS pipe buffer (~64 KB).
    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const stderrPromise = new Response(proc.stderr).text().catch(() => "");
    const exitCode = await proc.exited;
    const [stdout, stderr] = timedOut
      ? await (async () => {
          const stdoutDrain = createDrainDeadline(STREAM_DRAIN_TIMEOUT_MS);
          const stderrDrain = createDrainDeadline(STREAM_DRAIN_TIMEOUT_MS);
          try {
            return await Promise.all([
              Promise.race([stdoutPromise, stdoutDrain.promise]),
              Promise.race([stderrPromise, stderrDrain.promise]),
            ]);
          } finally {
            stdoutDrain.cancel();
            stderrDrain.cancel();
          }
        })()
      : await Promise.all([stdoutPromise, stderrPromise]);

    clearTimeout(killTimer);
    if (sigkillTimer !== undefined) {
      clearTimeout(sigkillTimer);
      sigkillTimer = undefined;
    }

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

    logger?.[level]("quality", `${commandName} completed`, {
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
