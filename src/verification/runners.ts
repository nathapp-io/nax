/**
 * Verification Runners (ADR-005, Phase 4)
 *
 * Low-level test execution functions. Replaces src/verification/gate.ts.
 * Used by: strategies, orchestrator, run-regression lifecycle, tdd orchestrator.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../utils/bun-deps";
import { buildTestCommand, executeWithTimeout, normalizeEnvironment } from "./executor";
import { parseTestOutput } from "./parser";
import type { AssetVerificationResult, VerificationGateOptions, VerificationResult } from "./types";

/** Verify all expected files exist before running tests. */
export async function verifyAssets(
  workingDirectory: string,
  expectedFiles?: string[],
): Promise<AssetVerificationResult> {
  if (!expectedFiles || expectedFiles.length === 0) return { success: true, missingFiles: [] };

  const missingFiles: string[] = [];
  for (const file of expectedFiles) {
    if (!existsSync(join(workingDirectory, file))) missingFiles.push(file);
  }

  if (missingFiles.length > 0) {
    return {
      success: false,
      missingFiles,
      error: `ASSET_CHECK_FAILED: Missing files: [${missingFiles.join(", ")}]\nAction: Create the missing files before tests can run.`,
    };
  }
  return { success: true, missingFiles: [] };
}

/** Core verification: asset check → execute → parse output. */
async function runVerificationCore(options: VerificationGateOptions): Promise<VerificationResult> {
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

  const finalCommand = buildTestCommand(options.command, {
    forceExit: options.forceExit,
    detectOpenHandles: options.detectOpenHandles,
    detectOpenHandlesRetries: options.detectOpenHandlesRetries,
    timeoutRetryCount: options.timeoutRetryCount,
  });

  const normalizedEnv = normalizeEnvironment(process.env as Record<string, string | undefined>, options.stripEnvVars);

  const execution = await executeWithTimeout(finalCommand, options.timeoutSeconds, normalizedEnv, {
    shell: options.shell,
    gracePeriodMs: options.gracePeriodMs,
    drainTimeoutMs: options.drainTimeoutMs,
    cwd: options.workdir,
  });

  if (execution.timeout) {
    return {
      status: "TIMEOUT",
      success: options.acceptOnTimeout ?? false,
      countsTowardEscalation: false,
      error: execution.error,
      output: execution.output,
    };
  }

  const exitCode = execution.exitCode ?? 1;
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

  return { status: "SUCCESS", success: true, countsTowardEscalation: true, output: execution.output };
}

/** Run entire test suite (regression gate). */
export async function fullSuite(options: VerificationGateOptions): Promise<VerificationResult> {
  return runVerificationCore(options);
}

/** Run tests scoped to modified files. */
export async function scoped(options: VerificationGateOptions): Promise<VerificationResult> {
  let scopedCommand = options.command;
  if (options.scopedTestPaths && options.scopedTestPaths.length > 0) {
    scopedCommand = `${options.command} ${options.scopedTestPaths.join(" ")}`;
  }
  return runVerificationCore({ ...options, command: scopedCommand });
}

/**
 * Injectable dependencies for regression() — allows tests to replace
 * the 2s agent-cleanup sleep with a no-op without touching production behaviour.
 * @internal
 */
export const _regressionRunnerDeps = {
  sleep,
};

/** Quick smoke test — no asset verification, 2s delay to let agent processes terminate. */
export async function regression(options: VerificationGateOptions): Promise<VerificationResult> {
  await _regressionRunnerDeps.sleep(2000);
  return runVerificationCore({ ...options, expectedFiles: undefined });
}
