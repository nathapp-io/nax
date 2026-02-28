/**
 * Verification Gates
 *
 * Three verification strategies with unified implementation:
 * - fullSuite(): Run entire test suite (used by execution/verification.ts)
 * - scoped(): Run tests for modified files only (used by tdd/orchestrator.ts)
 * - regression(): Quick smoke test to catch obvious breakage (used by pipeline/stages/verify.ts)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildTestCommand, executeWithTimeout, normalizeEnvironment } from "./executor";
import { parseTestOutput } from "./parser";
import type { AssetVerificationResult, VerificationGateOptions, VerificationResult } from "./types";

/**
 * Verify all expected files exist before running tests.
 *
 * Prevents "Tests failed (exit code 1)" with no context by checking
 * files listed in story.expectedFiles before test execution.
 */
export async function verifyAssets(
  workingDirectory: string,
  expectedFiles?: string[],
): Promise<AssetVerificationResult> {
  if (!expectedFiles || expectedFiles.length === 0) {
    return {
      success: true,
      missingFiles: [],
    };
  }

  const missingFiles: string[] = [];

  for (const file of expectedFiles) {
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

/**
 * Run complete verification flow with all safety checks.
 *
 * Integrates:
 * - Pre-flight asset verification
 * - Execution guard with timeout
 * - Smart exit-code analysis
 * - Environment normalization
 */
async function runVerificationCore(options: VerificationGateOptions): Promise<VerificationResult> {
  // Pre-flight asset verification
  const assetCheck = await verifyAssets(options.workdir, options.expectedFiles);
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

  // Environment normalization
  const normalizedEnv = normalizeEnvironment(process.env as Record<string, string | undefined>, options.stripEnvVars);

  // Execution guard with timeout
  const execution = await executeWithTimeout(finalCommand, options.timeoutSeconds, normalizedEnv, {
    shell: options.shell,
    gracePeriodMs: options.gracePeriodMs,
    drainTimeoutMs: options.drainTimeoutMs,
    cwd: options.workdir,
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

  // Smart exit-code analysis
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

/**
 * Full Suite Verification Gate
 *
 * Runs the entire test suite to catch regressions.
 * Used by: execution/verification.ts
 *
 * Strategy:
 * - Runs all tests without filtering
 * - Full timeout (typically 120s+)
 * - Asset verification enabled
 * - Environment normalization enabled
 */
export async function fullSuite(options: VerificationGateOptions): Promise<VerificationResult> {
  return runVerificationCore(options);
}

/**
 * Scoped Verification Gate
 *
 * Runs only tests for modified files to provide fast feedback.
 * Used by: tdd/orchestrator.ts (between sessions)
 *
 * Strategy:
 * - Filters test command to only run affected test files
 * - Shorter timeout (typically 60s)
 * - Asset verification enabled
 * - Environment normalization enabled
 */
export async function scoped(options: VerificationGateOptions): Promise<VerificationResult> {
  // Build scoped command if test paths provided
  let scopedCommand = options.command;
  if (options.scopedTestPaths && options.scopedTestPaths.length > 0) {
    // Append test file paths to command
    scopedCommand = `${options.command} ${options.scopedTestPaths.join(" ")}`;
  }

  return runVerificationCore({
    ...options,
    command: scopedCommand,
  });
}

/**
 * Regression Verification Gate
 *
 * Quick smoke test to catch obvious breakage before full review.
 * Used by: pipeline/stages/verify.ts
 *
 * Strategy:
 * - Runs all tests (no filtering)
 * - Shorter timeout (typically 60s)
 * - NO asset verification (assumes files exist from prior stages)
 * - Environment normalization enabled
 * - Waits 2s for agent processes to terminate (OOM prevention)
 */
export async function regression(options: VerificationGateOptions): Promise<VerificationResult> {
  // Wait 2 seconds to let agent child processes fully terminate
  // This prevents OOM on low-RAM systems when TypeScript language servers
  // are still in memory while we spawn `bun test`
  await Bun.sleep(2000);

  return runVerificationCore({
    ...options,
    expectedFiles: undefined, // Skip asset verification for regression check
  });
}
