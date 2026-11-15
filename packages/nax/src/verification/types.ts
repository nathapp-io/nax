/**
 * Unified Verification Types
 *
 * Shared type definitions for test execution, parsing, and verification.
 */

/** Verification scope: what tests to run */
import type { QualityCommandSpec } from "@nathapp/nax-agent/internal";
import type { GateStallPolicy, GateStopReason } from "../utils/gate-stall";

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
  /**
   * Present only when the stall detector ended the invocation — absent on a
   * wall timeout, a normal exit, a stream error and a drain-deadline expiry.
   */
  stopReason?: GateStopReason;
}

/** Test output analysis (parsed) — implementation in src/test-runners/types */
export type { TestOutputAnalysis } from "../test-runners/types";

/** Asset verification result */
export interface AssetVerificationResult {
  success: boolean;
  missingFiles: string[];
  error?: string;
}

/** Structured test failure information — implementation in src/test-runners/types */
export type { TestFailure, TestSummary } from "../test-runners/types";

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
  /** Runner exit code when known — surfaced on TEST_FAILURE / ENVIRONMENTAL_FAILURE paths. */
  exitCode?: number;
  /** Final shell command actually executed (post buildTestCommand wrap). */
  command?: string;
  /**
   * Interruption evidence, carried independently of `status` (US-004). On a
   * single-command run it is the executor's detector reason; on a command list it
   * is the FIRST detector reason in command order, and it is absent when no entry
   * was stopped. Its presence — not the aggregate `status` — marks the run as
   * interrupted, so a mixed list whose first failure was an ordinary code failure
   * still says it was stopped.
   */
  stopReason?: GateStopReason;
}

/** Verification gate options */
export interface VerificationGateOptions {
  /** Working directory */
  workdir: string;
  /** Test command to execute */
  command: QualityCommandSpec;
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
  env?: Record<string, string | undefined>;
  /** Whether to accept story as passed on timeout (BUG-026) */
  acceptOnTimeout?: boolean;
  /** Scoped test paths (for scoped verification) */
  scopedTestPaths?: string[];
  /** Scoped test command template with {{files}} placeholder — overrides buildSmartTestCommand heuristic */
  testScopedTemplate?: QualityCommandSpec;
  /**
   * Stall-detection policy for every command in this gate (US-002/US-003).
   * Absent means no detector at all — the executor creates no monitor.
   */
  stallDetection?: Partial<GateStallPolicy>;
}
