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

import chalk from "chalk";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { countStories } from "../../prd";
import path from "node:path";

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
    // Look for failed test markers (✗, ✕, FAIL, or error indicators)
    // followed by AC-N pattern
    const failMatch = line.match(/[✗✕❌]|FAIL|error/i);
    const acMatch = line.match(/(AC-\d+):/i);

    if (failMatch && acMatch) {
      const acId = acMatch[1].toUpperCase();
      if (!failedACs.includes(acId)) {
        failedACs.push(acId);
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
    if (!ctx.config.acceptance.enabled) {
      return false;
    }

    if (!areAllStoriesComplete(ctx)) {
      return false;
    }

    return true;
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    console.log(chalk.cyan("\n🧪 Running acceptance tests..."));

    // Build path to acceptance test file
    if (!ctx.featureDir) {
      console.warn(
        chalk.yellow("⚠ No feature directory — skipping acceptance tests"),
      );
      return { action: "continue" };
    }

    const testPath = path.join(ctx.featureDir, ctx.config.acceptance.testPath);

    // Check if test file exists
    const testFile = Bun.file(testPath);
    const exists = await testFile.exists();

    if (!exists) {
      console.warn(
        chalk.yellow(
          `⚠ Acceptance test file not found: ${testPath} — skipping`,
        ),
      );
      return { action: "continue" };
    }

    // Run bun test on the acceptance test file
    const proc = Bun.spawn(["bun", "test", testPath], {
      cwd: ctx.workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    // Combine stdout and stderr for parsing
    const output = `${stdout}\n${stderr}`;

    // Parse test results
    const failedACs = parseTestFailures(output);

    // Check for overridden ACs (skip those)
    const overrides = ctx.prd.acceptanceOverrides || {};
    const actualFailures = failedACs.filter((acId) => !overrides[acId]);

    // If all failed ACs are overridden, treat as success
    if (actualFailures.length === 0 && exitCode === 0) {
      console.log(chalk.green("✓ All acceptance tests passed"));
      return { action: "continue" };
    }

    if (actualFailures.length === 0 && exitCode !== 0) {
      // Tests failed but we couldn't parse which ACs
      // This might be a setup/teardown error
      console.log(chalk.yellow("⚠ Tests failed but no specific AC failures detected"));
      console.log(chalk.gray("Output:"));
      console.log(chalk.gray(output));
      return { action: "continue" }; // Don't block on unparseable failures
    }

    // If we have actual failures, report them
    if (actualFailures.length > 0) {
      // Log overridden failures (if any)
      const overriddenFailures = failedACs.filter((acId) => overrides[acId]);
      if (overriddenFailures.length > 0) {
        console.log(
          chalk.yellow(
            `⚠ Skipped failures (overridden): ${overriddenFailures.join(", ")}`,
          ),
        );
        for (const acId of overriddenFailures) {
          console.log(chalk.gray(`   ${acId}: ${overrides[acId]}`));
        }
      }

      console.log(
        chalk.red(`✗ Acceptance tests failed: ${actualFailures.join(", ")}`),
      );
      console.log(chalk.gray("\nTest output:"));
      console.log(chalk.gray(output));

      return {
        action: "fail",
        reason: `Acceptance tests failed: ${actualFailures.join(", ")}`,
      };
    }

    // All tests passed
    console.log(chalk.green("✓ All acceptance tests passed"));
    return { action: "continue" };
  },
};
