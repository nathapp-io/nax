/**
 * Test Execution Core
 *
 * Unified test execution logic with timeout handling and process cleanup.
 * Extracted from execution/verification.ts to eliminate duplication.
 */

import { spawn } from "../utils/bun-deps";
import { killProcessGroup } from "../utils/process-kill";
import type { TestExecutionResult } from "./types";

/** Injectable deps for testability — mock _executorDeps.spawn instead of global Bun.spawn */
export const _executorDeps = { spawn };

/**
 * Race an already-in-progress Promise against a deadline.
 *
 * Used to apply a hard cap to stream drain operations after a process is killed.
 * Uses setTimeout (not Bun.sleep) so the timer can be cleared once the race settles
 * — prevents timer leaks per rule 07.
 */
export const DRAIN_TIMEOUT = Symbol("drain-timeout");
export function raceWithDeadline<T>(p: Promise<T>, deadlineMs: number): Promise<T | typeof DRAIN_TIMEOUT> {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
  const timeoutP = new Promise<typeof DRAIN_TIMEOUT>((r) => {
    timer.id = setTimeout(() => r(DRAIN_TIMEOUT), deadlineMs);
  });
  return Promise.race([p, timeoutP]).finally(() => clearTimeout(timer.id));
}

/**
 * Normalize environment variables for verification subprocess.
 *
 * Force standard output mode during orchestrator-controlled test runs by
 * unsetting AI-optimized env vars (CLAUDECODE, REPL_ID, AGENT).
 */
const DEFAULT_STRIP_ENV_VARS = ["CLAUDECODE", "REPL_ID", "AGENT"];

export function normalizeEnvironment(
  env: Record<string, string | undefined>,
  stripVars?: string[],
): Record<string, string | undefined> {
  const normalized = { ...env };
  const varsToStrip = stripVars ?? DEFAULT_STRIP_ENV_VARS;

  for (const varName of varsToStrip) {
    delete normalized[varName];
  }

  return normalized;
}

/**
 * Execute test command with hard timeout and process cleanup.
 *
 * Prevents zombie processes by sending SIGTERM, waiting for grace period,
 * then SIGKILL to entire process group.
 *
 * @design Shell trust boundary: `command` is passed verbatim to `/bin/sh -c`
 * because test commands legitimately need shell features (pipes, redirects,
 * env substitution). The command originates from `config.quality.commands.test`
 * in `.nax/config.json`, which is a **trusted** file — equivalent in trust to a
 * Makefile or shell script. Users are responsible for its contents. Do not pass
 * user-supplied or agent-generated strings here without explicit validation.
 */
export async function executeWithTimeout(
  command: string,
  timeoutSeconds: number,
  env?: Record<string, string | undefined>,
  options?: {
    shell?: string;
    gracePeriodMs?: number;
    drainTimeoutMs?: number;
    cwd?: string;
  },
): Promise<TestExecutionResult> {
  const shell = options?.shell ?? "/bin/sh";
  const gracePeriodMs = options?.gracePeriodMs ?? 5000;
  const drainTimeoutMs = options?.drainTimeoutMs ?? 2000;

  const proc = _executorDeps.spawn([shell, "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: env || normalizeEnvironment(process.env as Record<string, string | undefined>),
    cwd: options?.cwd,
    // Bun.spawn does not setpgid children into their own group by default, so
    // killProcessGroup(-pid) below would target a group the shell isn't actually
    // the leader of (ESRCH -> falls back to killing only the /bin/sh wrapper,
    // leaking the real test-runner grandchild). `detached` makes this process a
    // session/group leader via setsid(), so its own pid IS the real pgid.
    detached: true,
  });

  // Rule 07: drain stdout+stderr concurrently with proc.exited to prevent
  // pipe-buffer deadlock. Sequential reads (after proc.exited) block when
  // the child writes more output than the OS pipe buffer can hold (~64 KB).
  // .catch(() => "") guards against stream errors (e.g. broken pipe on SIGKILL)
  // so the timeout path always returns a result instead of rejecting.
  const stdoutPromise = new Response(proc.stdout as ReadableStream).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr as ReadableStream).text().catch(() => "");

  const timeoutMs = timeoutSeconds * 1000;

  let timedOut = false;
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };

  const timeoutPromise = new Promise<void>((resolve) => {
    timer.id = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  const processPromise = proc.exited;

  const raceResult = await Promise.race([processPromise, timeoutPromise]);
  clearTimeout(timer.id);

  if (timedOut) {
    const pid = proc.pid;

    // Send SIGTERM to process group to kill children too
    killProcessGroup(pid, "SIGTERM");

    // Wait for graceful shutdown, but bail early if process already exited.
    // Bun.sleep is not cancellable; use setTimeout via raceWithDeadline so the
    // grace timer is cleared as soon as the process exits. Leaving it armed kept
    // Bun's event loop alive for the full grace period after this function had
    // already returned — a hard delay on CLI exit for every test timeout.
    let exitedDuringGrace = false;
    await raceWithDeadline(
      proc.exited
        .then(() => {
          exitedDuringGrace = true;
        })
        .catch(() => {}),
      gracePeriodMs,
    );

    // Only send SIGKILL if the process is still alive — avoids signaling a reused PID
    if (!exitedDuringGrace) {
      killProcessGroup(pid, "SIGKILL");
    }

    // Bun bug: piped streams may not close after kill — cap the already-in-progress
    // reads with a deadline so we collect whatever was buffered without hanging.
    const [out, err] = await Promise.all([
      raceWithDeadline(stdoutPromise, drainTimeoutMs),
      raceWithDeadline(stderrPromise, drainTimeoutMs),
    ]);
    const parts = [out !== DRAIN_TIMEOUT ? out : "", err !== DRAIN_TIMEOUT ? err : ""].filter(Boolean);
    const partialOutput = parts.join("\n") || undefined;

    return {
      success: false,
      timeout: true,
      killed: true,
      childProcessesKilled: true,
      output: partialOutput,
      error: `EXECUTION_TIMEOUT: Verification process exceeded ${timeoutSeconds}s. Process group (PID ${pid}) killed.`,
      countsTowardEscalation: false, // Timeout is environmental, not code failure
    };
  }

  const exitCode = typeof raceResult === "number" ? raceResult : 0;
  // Stream reads were started concurrently — await their completion now.
  // BUG-2: bound the drain with the same drainTimeoutMs the timeout path uses.
  // proc.exited resolves when the spawned shell exits, NOT when all pipe
  // write-ends close — a test-spawned grandchild (dev server, daemonized
  // process) that inherits the pipe write-end keeps both streams open after
  // the shell exits. Without the deadline, this call hangs indefinitely.
  // Mirrors the timeout path (lines 147-150): raceWithDeadline caps the drain,
  // and a DRAIN_TIMEOUT result becomes "" in the assembled output.
  const [out, err] = await Promise.all([
    raceWithDeadline(stdoutPromise, drainTimeoutMs),
    raceWithDeadline(stderrPromise, drainTimeoutMs),
  ]);
  const stdout = out !== DRAIN_TIMEOUT ? out : "";
  const stderr = err !== DRAIN_TIMEOUT ? err : "";
  const output = `${stdout}\n${stderr}`;

  return {
    success: exitCode === 0,
    timeout: false,
    exitCode,
    output,
    countsTowardEscalation: true,
  };
}

/**
 * Check if a test command already includes --detectOpenHandles.
 */
function detectOpenHandlesFlag(command: string): boolean {
  return command.includes("--detectOpenHandles");
}

/**
 * Append --detectOpenHandles to a test command for diagnostic retry.
 */
export function appendOpenHandlesFlag(command: string): string {
  if (detectOpenHandlesFlag(command)) return command;
  return appendFlag(command, "--detectOpenHandles");
}

/**
 * Check if a test command already includes --forceExit.
 */
function forceExitFlag(command: string): boolean {
  return command.includes("--forceExit");
}

/**
 * Append --forceExit to a test command to force process exit after tests.
 */
export function appendForceExitFlag(command: string): string {
  if (forceExitFlag(command)) return command;
  return appendFlag(command, "--forceExit");
}

/**
 * Append a flag to a command, inserting before any pipe/redirect.
 *
 * Quote-aware: a `|`/`>` inside a single- or double-quoted argument is not a
 * split point. A `>` immediately preceded by a fd number (e.g. `2>&1`) is
 * treated as part of the redirect token, so the flag is inserted before the
 * whole `N>` sequence rather than in the middle of it.
 */
function appendFlag(command: string, flag: string): string {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "|" || char === ">") {
      let splitIndex = i;
      if (char === ">") {
        // A digit run before `>` is only an fd number (e.g. `2>&1`) when it is
        // a standalone token — preceded by whitespace, start-of-string, or a
        // shell operator. Digits glued onto a longer word (e.g. `file123>out`)
        // are part of that word, not an fd: real shells treat `file123>out`
        // as the single argument "file123" followed by a plain redirect, not
        // as fd 123.
        let digitStart = splitIndex;
        while (digitStart > 0 && /[0-9]/.test(command[digitStart - 1] ?? "")) digitStart--;
        const charBeforeDigits = command[digitStart - 1];
        const isStandaloneFdToken =
          digitStart < splitIndex && (digitStart === 0 || /[\s|;&]/.test(charBeforeDigits ?? ""));
        if (isStandaloneFdToken) splitIndex = digitStart;
      }
      return `${command.slice(0, splitIndex).trimEnd()} ${flag} ${command.slice(splitIndex)}`;
    }
  }
  return `${command} ${flag}`;
}

/**
 * Build the final test command based on quality config and retry state.
 */
export function buildTestCommand(
  baseCommand: string,
  options: {
    forceExit?: boolean;
    detectOpenHandles?: boolean;
    detectOpenHandlesRetries?: number;
    timeoutRetryCount?: number;
  },
): string {
  let command = baseCommand;

  const { forceExit = false, detectOpenHandles = true, detectOpenHandlesRetries = 1, timeoutRetryCount = 0 } = options;

  // If we've exhausted detectOpenHandles retries, force exit as last resort
  const exhaustedDiagnosticRetries = timeoutRetryCount > detectOpenHandlesRetries;

  // Apply --forceExit if configured or if diagnostic retries exhausted
  if (forceExit || exhaustedDiagnosticRetries) {
    command = appendForceExitFlag(command);
  }

  // Apply --detectOpenHandles on timeout retries (within cap)
  if (detectOpenHandles && timeoutRetryCount > 0 && timeoutRetryCount <= detectOpenHandlesRetries) {
    command = appendOpenHandlesFlag(command);
  }

  return command;
}
