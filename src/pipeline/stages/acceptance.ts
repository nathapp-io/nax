/**
 * Acceptance Stage
 *
 * Runs acceptance tests when all stories are complete.
 * Validates the feature against acceptance criteria from spec.md.
 *
 * Only executes when:
 * - All stories in the PRD are complete (status: passed/failed/skipped, not pending/in-progress)
 * - Acceptance validation is enabled in config
 *
 * US-002 (ACC-002): reads ctx.acceptanceTestPaths (set by acceptance-setup) and runs
 * each per-package test file from its own package directory. Falls back to the original
 * single-file behavior when acceptanceTestPaths is not set (backward compatible).
 *
 * @returns
 * - `continue`: All acceptance tests pass
 * - `fail`: One or more acceptance tests failed
 *
 * @example
 * ```ts
 * // All stories complete, acceptance tests pass
 * await acceptanceStage.execute(ctx);
 * // Returns: { action: "continue" }
 *
 * // All stories complete, acceptance tests fail
 * await acceptanceStage.execute(ctx);
 * // Returns: { action: "fail", reason: "Acceptance tests failed: AC-2, AC-5" }
 * ```
 */

import path from "node:path";
import { buildAcceptanceRunCommand } from "../../acceptance/generator";
import { getLogger } from "../../logger";
import { countStories } from "../../prd";
import { logTestOutput } from "../../utils/log-test-output";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/**
 * Parse bun test output to extract failed test names.
 *
 * Looks for lines containing "AC-N:" to identify which acceptance criteria failed.
 *
 * @param output - stdout/stderr from bun test
 * @returns Array of failed AC IDs (e.g., ["AC-2", "AC-5"])
 *
 * @example
 * ```ts
 * const output = `
 *   ✓ AC-1: TTL expiry
 *   ✗ AC-2: handles empty input
 *   ✓ AC-3: validates format
 * `;
 * const failed = parseTestFailures(output);
 * // Returns: ["AC-2"]
 * ```
 */
function parseTestFailures(output: string): string[] {
  const failedACs: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // Look for Bun's (fail) marker followed by AC-N pattern
    // Pattern: (fail) ... > AC-N: description
    if (line.includes("(fail)")) {
      const acMatch = line.match(/(AC-\d+):/i);
      if (acMatch) {
        const acId = acMatch[1].toUpperCase();
        if (!failedACs.includes(acId)) {
          failedACs.push(acId);
        }
      }
    }
  }

  return failedACs;
}

/**
 * Check if all stories in the PRD are complete.
 *
 * Stories are complete if their status is passed, failed, or skipped.
 * Pending or in-progress stories are not complete.
 *
 * @param ctx - Pipeline context
 * @returns true if all stories complete, false otherwise
 */
function areAllStoriesComplete(ctx: PipelineContext): boolean {
  const counts = countStories(ctx.prd);
  const totalComplete = counts.passed + counts.failed + counts.skipped;
  return totalComplete === counts.total;
}

export const acceptanceStage: PipelineStage = {
  name: "acceptance",

  enabled(ctx: PipelineContext): boolean {
    // Only run when:
    // 1. Acceptance validation is enabled
    // 2. All stories are complete
    const effectiveConfig = ctx.effectiveConfig ?? ctx.config;
    if (!effectiveConfig.acceptance.enabled) {
      return false;
    }

    if (!areAllStoriesComplete(ctx)) {
      return false;
    }

    return true;
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // PKG-004: use centrally resolved effective config
    const effectiveConfig = ctx.effectiveConfig ?? ctx.config;

    logger.info("acceptance", "Running acceptance tests");

    if (!ctx.featureDir) {
      logger.warn("acceptance", "No feature directory — skipping acceptance tests");
      return { action: "continue" };
    }

    // US-002: Use per-package test paths from acceptance-setup when available.
    // Fall back to single-file behavior (pre-ACC-002 or disabled acceptance-setup).
    const testGroups: Array<{ testPath: string; packageDir: string }> = ctx.acceptanceTestPaths ?? [
      {
        testPath: path.join(ctx.featureDir, effectiveConfig.acceptance.testPath),
        packageDir: ctx.workdir,
      },
    ];

    // Collect combined results across all packages
    const allFailedACs: string[] = [];
    const allOutputParts: string[] = [];
    let anyError = false;
    let errorExitCode = 0;

    for (const { testPath, packageDir } of testGroups) {
      // Check if test file exists
      const testFile = Bun.file(testPath);
      const exists = await testFile.exists();

      if (!exists) {
        logger.warn("acceptance", "Acceptance test file not found — skipping", { testPath });
        continue;
      }

      // BUG-083/BUG-084: Run ONLY the acceptance test file, not the full project test suite.
      // Resolution order: acceptance.command override → testFramework-aware command → bun test fallback
      const testCmdParts = buildAcceptanceRunCommand(
        testPath,
        effectiveConfig.project?.testFramework,
        effectiveConfig.acceptance.command,
      );
      logger.info("acceptance", "Running acceptance command", {
        cmd: testCmdParts.join(" "),
        packageDir,
      });
      const proc = Bun.spawn(testCmdParts, {
        cwd: packageDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const output = `${stdout}\n${stderr}`;
      allOutputParts.push(output);

      const failedACs = parseTestFailures(output);

      // Check for overridden ACs (skip those)
      const overrides = ctx.prd.acceptanceOverrides ?? {};
      const actualFailures = failedACs.filter((acId) => !overrides[acId]);
      const overriddenFailures = failedACs.filter((acId) => overrides[acId]);

      if (overriddenFailures.length > 0) {
        logger.warn("acceptance", "Skipped failures (overridden)", {
          overriddenFailures,
          overrides: overriddenFailures.map((acId) => ({ acId, reason: overrides[acId] })),
        });
      }

      // Non-zero exit but no AC failures parsed — test crashed
      if (failedACs.length === 0 && exitCode !== 0) {
        logger.error("acceptance", "Tests errored with no AC failures parsed", {
          exitCode,
          packageDir,
        });
        logTestOutput(logger, "acceptance", output);
        anyError = true;
        errorExitCode = exitCode;
        allFailedACs.push("AC-ERROR");
        continue;
      }

      for (const acId of actualFailures) {
        if (!allFailedACs.includes(acId)) {
          allFailedACs.push(acId);
        }
      }

      if (actualFailures.length > 0) {
        logger.error("acceptance", "Acceptance tests failed", {
          failedACs: actualFailures,
          packageDir,
        });
        logTestOutput(logger, "acceptance", output);
      } else if (exitCode === 0) {
        logger.info("acceptance", "Package acceptance tests passed", { packageDir });
      }
    }

    const combinedOutput = allOutputParts.join("\n");

    // All packages passed
    if (allFailedACs.length === 0) {
      logger.info("acceptance", "All acceptance tests passed");
      return { action: "continue" };
    }

    // Store failures for fix generation
    ctx.acceptanceFailures = {
      failedACs: allFailedACs,
      testOutput: combinedOutput,
    };

    if (anyError) {
      return {
        action: "fail",
        reason: `Acceptance tests errored (exit code ${errorExitCode}): syntax error, import failure, or unhandled exception`,
      };
    }

    return {
      action: "fail",
      reason: `Acceptance tests failed: ${allFailedACs.join(", ")}`,
    };
  },
};
