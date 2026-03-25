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

    // Build path to acceptance test file
    if (!ctx.featureDir) {
      logger.warn("acceptance", "No feature directory — skipping acceptance tests");
      return { action: "continue" };
    }

    const testPath = path.join(ctx.featureDir, effectiveConfig.acceptance.testPath);

    // Check if test file exists
    const testFile = Bun.file(testPath);
    const exists = await testFile.exists();

    if (!exists) {
      logger.warn("acceptance", "Acceptance test file not found — skipping", {
        testPath,
      });
      return { action: "continue" };
    }

    // Acceptance tests always run from repo root — covers both single repo and monorepo.
    // The test file uses __dirname-based paths to navigate into packages as needed.

    // BUG-083: Run ONLY the acceptance test file, not the full project test suite.
    // The full suite is covered by the regression gate; acceptance is a separate concern.
    // Resolution order: acceptance.command override → default "bun test <file> --timeout=60000"
    const acceptanceCmd = effectiveConfig.acceptance.command;
    let testCmdParts: string[];
    if (acceptanceCmd) {
      // Support {{FILE}} placeholder or verbatim command
      const resolved = acceptanceCmd.includes("{{FILE}}") ? acceptanceCmd.replace("{{FILE}}", testPath) : acceptanceCmd;
      testCmdParts = resolved.trim().split(/\s+/);
    } else {
      testCmdParts = ["bun", "test", testPath, "--timeout=60000"];
    }
    const proc = Bun.spawn(testCmdParts, {
      cwd: ctx.workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    // Combine stdout and stderr for parsing
    const output = `${stdout}\n${stderr}`;

    // Parse test results
    const failedACs = parseTestFailures(output);

    // Check for overridden ACs (skip those)
    const overrides = ctx.prd.acceptanceOverrides || {};
    const actualFailures = failedACs.filter((acId) => !overrides[acId]);

    // If all tests passed cleanly
    if (actualFailures.length === 0 && exitCode === 0) {
      logger.info("acceptance", "All acceptance tests passed");
      return { action: "continue" };
    }

    // All parsed AC failures are overridden — treat as success even with non-zero exit
    if (failedACs.length > 0 && actualFailures.length === 0) {
      logger.info("acceptance", "All failed ACs are overridden — treating as pass");
      return { action: "continue" };
    }

    // Non-zero exit but no AC failures parsed at all — test crashed (syntax error, import failure, etc.)
    if (failedACs.length === 0 && exitCode !== 0) {
      logger.error("acceptance", "Tests errored with no AC failures parsed", { exitCode });
      logTestOutput(logger, "acceptance", output);

      ctx.acceptanceFailures = {
        failedACs: ["AC-ERROR"],
        testOutput: output,
      };

      return {
        action: "fail",
        reason: `Acceptance tests errored (exit code ${exitCode}): syntax error, import failure, or unhandled exception`,
      };
    }

    // If we have actual failures, report them
    if (actualFailures.length > 0) {
      // Log overridden failures (if any)
      const overriddenFailures = failedACs.filter((acId) => overrides[acId]);
      if (overriddenFailures.length > 0) {
        logger.warn("acceptance", "Skipped failures (overridden)", {
          overriddenFailures,
          overrides: overriddenFailures.map((acId) => ({ acId, reason: overrides[acId] })),
        });
      }

      logger.error("acceptance", "Acceptance tests failed", { failedACs: actualFailures });
      logTestOutput(logger, "acceptance", output);

      // Store failed ACs and test output in context for fix generation
      ctx.acceptanceFailures = {
        failedACs: actualFailures,
        testOutput: output,
      };

      return {
        action: "fail",
        reason: `Acceptance tests failed: ${actualFailures.join(", ")}`,
      };
    }

    // All tests passed
    logger.info("acceptance", "All acceptance tests passed");
    return { action: "continue" };
  },
};
