/**
 * Unified Verification Types
 *
 * Shared type definitions for test execution, parsing, and verification.
 */

/** Verification scope: what tests to run */
export type VerificationScope = "scoped" | "full" | "regression";

/** Verification status outcomes */
export type VerificationStatus =
  | "SUCCESS"
  | "TEST_FAILURE"
  | "ENVIRONMENTAL_FAILURE"
  | "ASSET_CHECK_FAILED"
  | "TIMEOUT";

/** Test execution result (raw) */
export interface TestExecutionResult {
  success: boolean;
  timeout: boolean;
  exitCode?: number;
  output?: string;
  error?: string;
  killed?: boolean;
  childProcessesKilled?: boolean;
  countsTowardEscalation: boolean;
}

/** Test output analysis (parsed) */
export interface TestOutputAnalysis {
  allTestsPassed: boolean;
  passCount: number;
  failCount: number;
  isEnvironmentalFailure: boolean;
  error?: string;
}

/** Asset verification result */
export interface AssetVerificationResult {
  success: boolean;
  missingFiles: string[];
  error?: string;
}

/** Structured test failure information */
export interface TestFailure {
  /** File path where the test failed */
  file: string;
  /** Full test name (including nested describe blocks) */
  testName: string;
  /** Error message */
  error: string;
  /** Stack trace lines (truncated to first 5 lines) */
  stackTrace: string[];
}

/** Test run summary */
export interface TestSummary {
  /** Number of tests that passed */
  passed: number;
  /** Number of tests that failed */
  failed: number;
  /** Structured failure details */
  failures: TestFailure[];
}

/** Complete verification result */
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

/** Rectification state tracking per story execution */
export interface RectificationState {
  /** Current attempt number (0 = initial run, 1+ = retries) */
  attempt: number;
  /** Number of test failures on initial run */
  initialFailures: number;
  /** Number of test failures on current run */
  currentFailures: number;
  /** #89: Exit code from the last test run */
  lastExitCode?: number;
}

/** Verification gate options */
export interface VerificationGateOptions {
  /** Working directory */
  workdir: string;
  /** Test command to execute */
  command: string;
  /** Timeout in seconds */
  timeoutSeconds: number;
  /** Expected files (for asset verification) */
  expectedFiles?: string[];
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
  /** Whether to accept story as passed on timeout (BUG-026) */
  acceptOnTimeout?: boolean;
  /** Scoped test paths (for scoped verification) */
  scopedTestPaths?: string[];
  /** Scoped test command template with {{files}} placeholder — overrides buildSmartTestCommand heuristic */
  testScopedTemplate?: string;
}
