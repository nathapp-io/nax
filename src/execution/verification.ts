/**
 * ADR-003: Robust Orchestration Feedback Loop - Verification Module
 *
 * DEPRECATED: Use src/verification/ unified layer instead.
 * This file is kept for backward compatibility only.
 *
 * Implements Decisions 3-6:
 * - Pre-Flight Asset Verification
 * - Execution Guard (Verification Timeout)
 * - Smart Exit-Code Analysis
 * - Environment Normalization
 */

// Re-export from unified verification layer
export {
  type AssetVerificationResult,
  type TestExecutionResult as TimeoutExecutionResult,
  type TestOutputAnalysis,
  type VerificationResult,
  type VerificationStatus,
  verifyAssets,
  executeWithTimeout,
  parseTestOutput,
  getEnvironmentalEscalationThreshold,
  normalizeEnvironment,
  appendOpenHandlesFlag,
  appendForceExitFlag,
  buildTestCommand,
} from "../verification";

// Adapter function for backward compatibility
import { fullSuite } from "../verification";
import type { VerificationGateOptions } from "../verification/types";

/**
 * Run complete verification flow with all ADR-003 safety checks.
 *
 * @deprecated Use fullSuite() from src/verification/gate.ts instead
 */
export async function runVerification(options: {
  workingDirectory: string;
  expectedFiles?: string[];
  command: string;
  timeoutSeconds: number;
  forceExit?: boolean;
  detectOpenHandles?: boolean;
  detectOpenHandlesRetries?: number;
  timeoutRetryCount?: number;
  gracePeriodMs?: number;
  drainTimeoutMs?: number;
  shell?: string;
  stripEnvVars?: string[];
  cwd?: string;
}) {
  // Map old options to new VerificationGateOptions
  const gateOptions: VerificationGateOptions = {
    workdir: options.workingDirectory,
    expectedFiles: options.expectedFiles,
    command: options.command,
    timeoutSeconds: options.timeoutSeconds,
    forceExit: options.forceExit,
    detectOpenHandles: options.detectOpenHandles,
    detectOpenHandlesRetries: options.detectOpenHandlesRetries,
    timeoutRetryCount: options.timeoutRetryCount,
    gracePeriodMs: options.gracePeriodMs,
    drainTimeoutMs: options.drainTimeoutMs,
    shell: options.shell,
    stripEnvVars: options.stripEnvVars,
  };

  return fullSuite(gateOptions);
}
