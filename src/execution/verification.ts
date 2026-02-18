/**
 * ADR-003: Robust Orchestration Feedback Loop - Verification Module
 *
 * Implements Decisions 3-6:
 * - Pre-Flight Asset Verification
 * - Execution Guard (Verification Timeout)
 * - Smart Exit-Code Analysis
 * - Environment Normalization
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

// ============================================================================
// Bun Stream Workaround
// ============================================================================

/**
 * Drain stdout+stderr from a killed Bun subprocess with a hard deadline.
 *
 * Bun doesn't close piped streams when a child process is killed (unlike Node).
 * `await new Response(proc.stdout).text()` hangs forever. This races the read
 * against a timeout so we get whatever output was buffered without blocking.
 */
async function drainWithDeadline(
  proc: Subprocess,
  deadlineMs: number
): Promise<string> {
  const EMPTY = Symbol("timeout");
  const race = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<typeof EMPTY>((r) => setTimeout(() => r(EMPTY), deadlineMs)),
    ]);

  let out = "";
  try {
    const stdout = race(new Response(proc.stdout).text());
    const stderr = race(new Response(proc.stderr).text());
    const [o, e] = await Promise.all([stdout, stderr]);
    if (o !== EMPTY) out += o;
    if (e !== EMPTY) out += (out ? "\n" : "") + e;
  } catch {
    // Streams may already be destroyed
  }
  return out;
}

// ============================================================================
// Decision 3: Pre-Flight Asset Verification
// ============================================================================

export interface AssetVerificationResult {
  success: boolean;
  missingFiles: string[];
  error?: string;
}

/**
 * Verify all relevant files exist before running tests.
 *
 * Prevents "Tests failed (exit code 1)" with no context by checking
 * files listed in story.relevantFiles before test execution.
 *
 * @param workingDirectory - Base directory for file paths
 * @param relevantFiles - Array of file paths from PRD story
 * @returns Verification result with specific missing file list
 */
export async function verifyAssets(
  workingDirectory: string,
  relevantFiles?: string[]
): Promise<AssetVerificationResult> {
  if (!relevantFiles || relevantFiles.length === 0) {
    return {
      success: true,
      missingFiles: [],
    };
  }

  const missingFiles: string[] = [];

  for (const file of relevantFiles) {
    const fullPath = join(workingDirectory, file);
    if (!existsSync(fullPath)) {
      missingFiles.push(file);
    }
  }

  if (missingFiles.length > 0) {
    return {
      success: false,
      missingFiles,
      error: `ASSET_CHECK_FAILED: Missing files: [${missingFiles.join(", ")}]\nAction: Create the missing files before tests can run.`,
    };
  }

  return {
    success: true,
    missingFiles: [],
  };
}

// ============================================================================
// Decision 4: Execution Guard (Verification Timeout)
// ============================================================================

export interface TimeoutExecutionResult {
  success: boolean;
  timeout: boolean;
  exitCode?: number;
  output?: string;
  error?: string;
  killed?: boolean;
  childProcessesKilled?: boolean;
  countsTowardEscalation: boolean;
}

/**
 * Execute command with hard timeout and process cleanup.
 *
 * Prevents zombie processes (like the 23-hour hung `bun test` at 99% CPU).
 * Sends SIGTERM, waits 5s, then SIGKILL to entire process group.
 *
 * @param command - Command to execute
 * @param timeoutSeconds - Timeout in seconds (from config.verificationTimeoutSeconds)
 * @param env - Environment variables (should be normalized before calling)
 * @returns Execution result with timeout status
 */
export async function executeWithTimeout(
  command: string,
  timeoutSeconds: number,
  env?: Record<string, string | undefined>,
  options?: {
    shell?: string;
    gracePeriodMs?: number;
    drainTimeoutMs?: number;
  }
): Promise<TimeoutExecutionResult> {
  const shell = options?.shell ?? "/bin/sh";
  const gracePeriodMs = options?.gracePeriodMs ?? 5000;
  const drainTimeoutMs = options?.drainTimeoutMs ?? 2000;

  const proc = Bun.spawn([shell, "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: env || normalizeEnvironment(process.env),
  });

  const timeoutMs = timeoutSeconds * 1000;
  let timeoutId: Timer | null = null;
  let timedOut = false;

  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  const processPromise = proc.exited;

  const raceResult = await Promise.race([processPromise, timeoutPromise]);

  if (timedOut) {
    const pid = proc.pid;

    // Send SIGTERM to process group (negative PID) to kill children too
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Fallback: kill direct process if process group kill fails
      try { proc.kill("SIGTERM"); } catch {}
    }

    // Wait for graceful shutdown (configurable, default 5s)
    await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));

    // Force SIGKILL entire process group if still running
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Process group may have already exited from SIGTERM
      try { proc.kill("SIGKILL"); } catch {}
    }

    // Bun bug workaround: piped streams don't close after kill.
    // Race stream reads against a configurable deadline to salvage partial output.
    const partialOutput = await drainWithDeadline(proc, drainTimeoutMs);

    return {
      success: false,
      timeout: true,
      killed: true,
      childProcessesKilled: true,
      output: partialOutput || undefined,
      error: `EXECUTION_TIMEOUT: Verification process exceeded ${timeoutSeconds}s. Process group (PID ${pid}) killed.`,
      countsTowardEscalation: false, // ADR-003: TIMEOUT is environmental, not code failure
    };
  }

  // Clear timeout if process finished in time
  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  const exitCode = raceResult as number;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const output = stdout + "\n" + stderr;

  return {
    success: exitCode === 0,
    timeout: false,
    exitCode,
    output,
    countsTowardEscalation: true,
  };
}

// ============================================================================
// Decision 5: Smart Exit-Code Analysis
// ============================================================================

export interface TestOutputAnalysis {
  allTestsPassed: boolean;
  passCount: number;
  failCount: number;
  isEnvironmentalFailure: boolean;
  error?: string;
}

/**
 * Parse test output to detect environmental failures.
 *
 * When exit code != 0 but all tests pass, classifies as ENVIRONMENTAL_FAILURE
 * instead of TEST_FAILURE. Captures full stderr/stdout for diagnosis.
 *
 * Example: US-001 showed "5 pass, 0 fail" on every iteration but was marked
 * as "Tests failed" 20 times. The orchestrator never communicated the actual
 * problem (missing src/types.ts).
 *
 * @param output - Test command output (stdout + stderr)
 * @param exitCode - Process exit code
 * @returns Analysis with environmental failure detection
 */
export function parseTestOutput(
  output: string,
  exitCode: number
): TestOutputAnalysis {
  // Regex patterns for different test frameworks
  const patterns = [
    /(\d+)\s+pass(?:ed)?(?:,\s+|\s+)(\d+)\s+fail/i, // "5 pass, 0 fail" or "5 passed 0 fail"
    /Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed/i, // Jest format
    /(\d+)\s+pass/i, // Bun format (just pass count)
  ];

  let passCount = 0;
  let failCount = 0;

  for (const pattern of patterns) {
    // Match ALL occurrences — use the LAST one (final summary line)
    const matches = [...output.matchAll(new RegExp(pattern, "gi"))];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      passCount = parseInt(lastMatch[1], 10);
      // Some formats only show pass count
      failCount = lastMatch[2] ? parseInt(lastMatch[2], 10) : 0;
      break;
    }
  }

  // Check for explicit fail count if not found
  if (failCount === 0) {
    const failMatches = [...output.matchAll(/(\d+)\s+fail/gi)];
    if (failMatches.length > 0) {
      failCount = parseInt(failMatches[failMatches.length - 1][1], 10);
    }
  }

  const allTestsPassed = passCount > 0 && failCount === 0;
  const isEnvironmentalFailure = allTestsPassed && exitCode !== 0;

  const result: TestOutputAnalysis = {
    allTestsPassed,
    passCount,
    failCount,
    isEnvironmentalFailure,
  };

  if (isEnvironmentalFailure) {
    result.error = `ENVIRONMENTAL_FAILURE: All ${passCount} tests passed but exit code was ${exitCode}. Check linter/typecheck/missing files.`;
  }

  return result;
}

/**
 * Calculate early escalation threshold for environmental failures.
 *
 * Environmental failures should escalate faster: after ceil(tier.attempts / 2)
 * instead of the full tier budget.
 *
 * @param tierAttempts - Full attempt budget for the tier
 * @returns Number of attempts before escalating
 */
export function getEnvironmentalEscalationThreshold(tierAttempts: number, divisor = 2): number {
  return Math.ceil(tierAttempts / divisor);
}

// ============================================================================
// Decision 6: Environment Normalization
// ============================================================================

/**
 * Normalize environment variables for verification subprocess.
 *
 * Force standard output mode during orchestrator-controlled test runs by
 * unsetting AI-optimized env vars (CLAUDECODE, REPL_ID, AGENT).
 *
 * This ensures the orchestrator always receives full, verbose, parseable
 * test output. The agent's own coding sessions can still use AI-optimized
 * mode - only the verification step needs standard output.
 *
 * @param env - Original environment variables
 * @returns Normalized environment (AI vars removed, others preserved)
 */
const DEFAULT_STRIP_ENV_VARS = ["CLAUDECODE", "REPL_ID", "AGENT"];

export function normalizeEnvironment(
  env: Record<string, string | undefined>,
  stripVars?: string[]
): Record<string, string | undefined> {
  const normalized = { ...env };
  const varsToStrip = stripVars ?? DEFAULT_STRIP_ENV_VARS;

  for (const varName of varsToStrip) {
    delete normalized[varName];
  }

  return normalized;
}

// ============================================================================
// Open Handle Detection Helper
// ============================================================================

/**
 * Check if a test command already includes --detectOpenHandles.
 */
function detectOpenHandlesFlag(command: string): boolean {
  return command.includes("--detectOpenHandles");
}

/**
 * Append --detectOpenHandles to a test command for diagnostic retry.
 * Works with bun test, jest, and vitest.
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
 * Append --forceExit to a test command to force process exit after tests complete.
 * Prevents open handle hangs from third-party packages (DB connections, timers, etc.).
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
    return command.slice(0, pipeIndex).trimEnd() + ` ${flag} ` + command.slice(pipeIndex);
  }
  return command + ` ${flag}`;
}

/**
 * Build the final test command based on quality config and retry state.
 *
 * Strategy:
 * 1. If forceExit is enabled in config → always append --forceExit
 * 2. On timeout retry → append --detectOpenHandles (if enabled and under retry cap)
 * 3. If detectOpenHandles retries exhausted → auto-enable --forceExit as last resort
 */
export function buildTestCommand(
  baseCommand: string,
  options: {
    forceExit?: boolean;
    detectOpenHandles?: boolean;
    detectOpenHandlesRetries?: number;
    timeoutRetryCount?: number;
  }
): string {
  let command = baseCommand;

  const {
    forceExit = false,
    detectOpenHandles = true,
    detectOpenHandlesRetries = 1,
    timeoutRetryCount = 0,
  } = options;

  // If we've exhausted detectOpenHandles retries, force exit as last resort
  const exhaustedDiagnosticRetries =
    timeoutRetryCount > detectOpenHandlesRetries;

  // Apply --forceExit if configured or if diagnostic retries exhausted
  if (forceExit || exhaustedDiagnosticRetries) {
    command = appendForceExitFlag(command);
  }

  // Apply --detectOpenHandles on timeout retries (within cap)
  if (
    detectOpenHandles &&
    timeoutRetryCount > 0 &&
    timeoutRetryCount <= detectOpenHandlesRetries
  ) {
    command = appendOpenHandlesFlag(command);
  }

  return command;
}

// ============================================================================
// Integrated Verification Flow
// ============================================================================

export type VerificationStatus =
  | "SUCCESS"
  | "TEST_FAILURE"
  | "ENVIRONMENTAL_FAILURE"
  | "ASSET_CHECK_FAILED"
  | "TIMEOUT";

export interface VerificationResult {
  status: VerificationStatus;
  success: boolean;
  countsTowardEscalation: boolean;
  output?: string;
  error?: string;
  missingFiles?: string[];
  passCount?: number;
  failCount?: number;
}

/**
 * Run complete verification flow with all ADR-003 safety checks.
 *
 * Integrates all decisions:
 * - Decision 3: Pre-flight asset verification
 * - Decision 4: Execution guard with timeout
 * - Decision 5: Smart exit-code analysis
 * - Decision 6: Environment normalization
 *
 * @param options - Verification options
 * @returns Comprehensive verification result
 */
export async function runVerification(options: {
  workingDirectory: string;
  relevantFiles?: string[];
  command: string;
  timeoutSeconds: number;
  /** Quality config for open handle / force exit behavior */
  forceExit?: boolean;
  detectOpenHandles?: boolean;
  detectOpenHandlesRetries?: number;
  /** How many times this story has timed out (tracks across retries) */
  timeoutRetryCount?: number;
  /** Process management config */
  gracePeriodMs?: number;
  drainTimeoutMs?: number;
  shell?: string;
  stripEnvVars?: string[];
}): Promise<VerificationResult> {
  // Decision 3: Pre-flight asset verification
  const assetCheck = await verifyAssets(options.workingDirectory, options.relevantFiles);
  if (!assetCheck.success) {
    return {
      status: "ASSET_CHECK_FAILED",
      success: false,
      countsTowardEscalation: true,
      error: assetCheck.error,
      missingFiles: assetCheck.missingFiles,
    };
  }

  // Build command with open handle / force exit flags based on config + retry state
  const finalCommand = buildTestCommand(options.command, {
    forceExit: options.forceExit,
    detectOpenHandles: options.detectOpenHandles,
    detectOpenHandlesRetries: options.detectOpenHandlesRetries,
    timeoutRetryCount: options.timeoutRetryCount,
  });

  // Decision 6: Environment normalization
  const normalizedEnv = normalizeEnvironment(
    process.env as Record<string, string | undefined>,
    options.stripEnvVars
  );

  // Decision 4: Execution guard with timeout
  const execution = await executeWithTimeout(finalCommand, options.timeoutSeconds, normalizedEnv, {
    shell: options.shell,
    gracePeriodMs: options.gracePeriodMs,
    drainTimeoutMs: options.drainTimeoutMs,
  });

  if (execution.timeout) {
    return {
      status: "TIMEOUT",
      success: false,
      countsTowardEscalation: false, // Timeout is environmental, not code failure
      error: execution.error,
      output: execution.output,
    };
  }

  // Decision 5: Smart exit-code analysis
  const exitCode = execution.exitCode ?? 1; // Default to failure if undefined
  if (exitCode !== 0 && execution.output) {
    const analysis = parseTestOutput(execution.output, exitCode);

    if (analysis.isEnvironmentalFailure) {
      return {
        status: "ENVIRONMENTAL_FAILURE",
        success: false,
        countsTowardEscalation: true,
        error: analysis.error,
        output: execution.output,
        passCount: analysis.passCount,
        failCount: analysis.failCount,
      };
    }

    return {
      status: "TEST_FAILURE",
      success: false,
      countsTowardEscalation: true,
      output: execution.output,
      passCount: analysis.passCount,
      failCount: analysis.failCount,
    };
  }

  return {
    status: "SUCCESS",
    success: true,
    countsTowardEscalation: true,
    output: execution.output,
  };
}
