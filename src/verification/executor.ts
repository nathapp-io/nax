/**
 * Test Execution Core
 *
 * Unified test execution logic with timeout handling and process cleanup.
 * Extracted from execution/verification.ts to eliminate duplication.
 */

import type { Subprocess } from "bun";
import { errorMessage } from "../utils/errors";
import type { TestExecutionResult } from "./types";

/** Injectable deps for testability — mock _executorDeps.spawn instead of global Bun.spawn */
export const _executorDeps = { spawn: Bun.spawn as typeof Bun.spawn };

/**
 * Drain stdout+stderr from a killed Bun subprocess with a hard deadline.
 *
 * Bun doesn't close piped streams when a child process is killed (unlike Node).
 * `await new Response(proc.stdout).text()` hangs forever. This races the read
 * against a timeout so we get whatever output was buffered without blocking.
 */
async function drainWithDeadline(proc: Subprocess, deadlineMs: number): Promise<string> {
  const EMPTY = Symbol("timeout");
  const race = <T>(p: Promise<T>) => {
    // BUG-039: Store timer handle so it can be cleared after race resolves (prevent leak)
    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<typeof EMPTY>((r) => {
      timerId = setTimeout(() => r(EMPTY), deadlineMs);
    });
    return Promise.race([p, timeoutPromise]).finally(() => clearTimeout(timerId));
  };

  let out = "";
  try {
    const stdout = race(new Response(proc.stdout as ReadableStream).text());
    const stderr = race(new Response(proc.stderr as ReadableStream).text());
    const [o, e] = await Promise.all([stdout, stderr]);
    if (o !== EMPTY) out += o;
    if (e !== EMPTY) out += (out ? "\n" : "") + e;
  } catch (error) {
    // Expected: streams destroyed after kill (e.g. TypeError from closed ReadableStream)
    const isExpectedStreamError =
      error instanceof TypeError ||
      (error instanceof Error && /abort|cancel|close|destroy|locked/i.test(error.message));
    if (!isExpectedStreamError) {
      const { getSafeLogger } = await import("../logger");
      getSafeLogger()?.debug("executor", "Unexpected error draining process output", {
        error: errorMessage(error),
      });
    }
  }
  return out;
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
  });

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

    // Send SIGTERM to process group (negative PID) to kill children too
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      // Fallback: kill direct process if process group kill fails
      try {
        proc.kill("SIGTERM");
      } catch (fallbackError) {
        // Process may have already exited
      }
    }

    // Wait for graceful shutdown
    await Bun.sleep(gracePeriodMs);

    // Force SIGKILL entire process group if still running
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      try {
        proc.kill("SIGKILL");
      } catch (fallbackError) {
        // Process may have already exited
      }
    }

    // Bun bug workaround: piped streams don't close after kill
    const partialOutput = await drainWithDeadline(proc, drainTimeoutMs);

    return {
      success: false,
      timeout: true,
      killed: true,
      childProcessesKilled: true,
      output: partialOutput || undefined,
      error: `EXECUTION_TIMEOUT: Verification process exceeded ${timeoutSeconds}s. Process group (PID ${pid}) killed.`,
      countsTowardEscalation: false, // Timeout is environmental, not code failure
    };
  }

  const exitCode = raceResult as number;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
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
 */
function appendFlag(command: string, flag: string): string {
  const pipeIndex = command.search(/[|>]/);
  if (pipeIndex > 0) {
    return `${command.slice(0, pipeIndex).trimEnd()} ${flag} ${command.slice(pipeIndex)}`;
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
