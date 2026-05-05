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

import { buildAcceptanceRunCommand } from "../../acceptance/generator";
import type { HardeningContext } from "../../acceptance/hardening";
import { resolveAcceptanceFeatureTestPath } from "../../acceptance/test-path";
import { acFailureToFinding, acSentinelToFinding } from "../../findings";
import type { Finding } from "../../findings";
import { getLogger } from "../../logger";
import { countStories } from "../../prd";
import { parseTestFailures as _parseTestFailures } from "../../test-runners/ac-parser";
import { logTestOutput } from "../../utils/log-test-output";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/** Injectable deps for testability */
export const _acceptanceStageDeps = {
  runHardeningPass: async (ctx: HardeningContext) => {
    const { runHardeningPass } = await import("../../acceptance/hardening");
    return runHardeningPass(ctx);
  },
};

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
 *
 * Hook timeouts (bun `beforeAll`/`beforeEach` timing out) are reported as:
 *   `(fail) ... > (unnamed) [Xms]`
 *   `  ^ a beforeEach/afterEach hook timed out for this test.`
 * These produce no `AC-N:` label so the parser would otherwise return [].
 * In this case "AC-HOOK" is emitted so callers can distinguish a lifecycle
 * failure from a genuine parse error ("AC-ERROR").
 */
/**
 * Parse test runner output to extract failed AC IDs.
 * Implementation lives in src/test-runners/ac-parser — re-exported here for
 * backward compatibility with existing importers.
 */
export const parseTestFailures = _parseTestFailures;

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
    const logger = getLogger();
    const startTime = Date.now();

    logger.info("acceptance", "Running acceptance tests", { storyId: ctx.story.id });

    if (!ctx.featureDir) {
      logger.warn("acceptance", "No feature directory — skipping acceptance tests", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    // US-002: Use per-package test paths from acceptance-setup when available.
    // Fall back to single-file behavior (pre-ACC-002 or disabled acceptance-setup).
    const testGroups: Array<{
      testPath: string;
      packageDir: string;
      testFramework?: string;
      commandOverride?: string;
    }> = ctx.acceptanceTestPaths ?? [
      {
        testPath: resolveAcceptanceFeatureTestPath(
          ctx.featureDir,
          ctx.config.acceptance.testPath,
          ctx.config.project?.language,
        ),
        packageDir: ctx.workdir,
      },
    ];

    // Collect combined results across all packages
    const allFailedACs: string[] = [];
    const allFindings: Finding[] = [];
    const allOutputParts: string[] = [];
    let anyError = false;
    let errorExitCode = 0;
    let hardeningRetries = 0;

    for (const { testPath, packageDir, testFramework, commandOverride } of testGroups) {
      // Check if test file exists
      const testFile = Bun.file(testPath);
      const exists = await testFile.exists();

      if (!exists) {
        logger.warn("acceptance", "Acceptance test file not found — skipping", { storyId: ctx.story.id, testPath });
        continue;
      }

      // @design: BUG-083/BUG-084: Run ONLY the acceptance test file, not the full project test suite.
      // Resolution order: per-package commandOverride → per-package testFramework → bun test fallback.
      // In monorepo mode, testFramework and commandOverride come from the per-package config
      // resolved by acceptance-setup. In fallback (single-package) mode they fall back to ctx.config.
      const resolvedFramework = testFramework ?? ctx.config.project?.testFramework;
      const resolvedCommand = commandOverride ?? ctx.config.acceptance.command;
      const testCmdParts = buildAcceptanceRunCommand(testPath, resolvedFramework, resolvedCommand);
      logger.info("acceptance", "Running acceptance command", {
        storyId: ctx.story.id,
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
          storyId: ctx.story.id,
          overriddenFailures,
          overrides: overriddenFailures.map((acId) => ({ acId, reason: overrides[acId] })),
        });
      }

      // Non-zero exit but no AC failures parsed — test crashed
      if (failedACs.length === 0 && exitCode !== 0) {
        logger.error("acceptance", "Tests errored with no AC failures parsed", {
          storyId: ctx.story.id,
          exitCode,
          packageDir,
        });
        logTestOutput(logger, "acceptance", output);
        anyError = true;
        errorExitCode = exitCode;
        allFailedACs.push("AC-ERROR");
        allFindings.push(acSentinelToFinding("AC-ERROR", output));
        continue;
      }

      for (const acId of actualFailures) {
        if (!allFailedACs.includes(acId)) {
          allFailedACs.push(acId);
          allFindings.push(
            acId === "AC-HOOK" ? acSentinelToFinding("AC-HOOK", output) : acFailureToFinding(acId, output),
          );
        }
      }

      if (actualFailures.length > 0) {
        logger.error("acceptance", "Acceptance tests failed", {
          storyId: ctx.story.id,
          failedACs: actualFailures,
          packageDir,
        });
        logTestOutput(logger, "acceptance", output);
      } else if (exitCode === 0) {
        logger.info("acceptance", "Package acceptance tests passed", { storyId: ctx.story.id, packageDir });
      }
    }

    const combinedOutput = allOutputParts.join("\n");
    const durationMs = Date.now() - startTime;

    // All packages passed
    if (allFailedACs.length === 0) {
      logger.info("acceptance", "All acceptance tests passed", { storyId: ctx.story.id });

      // Hardening pass: test debater-suggested criteria (non-blocking)
      const hardeningEnabled = ctx.config.acceptance?.hardening?.enabled !== false;
      const hasAnySuggested = ctx.prd.userStories.some((s) => s.suggestedCriteria && s.suggestedCriteria.length > 0);
      if (hardeningEnabled && hasAnySuggested && ctx.featureDir) {
        try {
          const prdPath = ctx.prdPath ?? `${ctx.featureDir}/prd.json`;
          const result = await _acceptanceStageDeps.runHardeningPass({
            prd: ctx.prd,
            prdPath,
            featureDir: ctx.featureDir,
            workdir: ctx.workdir,
            config: ctx.config,
            agentGetFn: ctx.agentGetFn,
            agentManager: ctx.agentManager,
            sessionManager: ctx.sessionManager,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
          });
          hardeningRetries = result.promoted.length;
        } catch (err) {
          // runHardeningPass already logs "Hardening pass failed" with full storyIds attribution
          logger.debug("acceptance", "Hardening pass failed (non-blocking)", {
            storyId: ctx.story.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Emit canonical verdict: all ACs passed
      logger.info("acceptance", "verdict", {
        storyId: ctx.story.id,
        packageDir: ctx.workdir,
        passed: true,
        failedACs: [],
        retries: hardeningRetries,
        durationMs,
      });

      return { action: "continue" };
    }

    // Store failures for fix generation
    ctx.acceptanceFailures = {
      failedACs: allFailedACs,
      findings: allFindings,
      testOutput: combinedOutput,
    };

    // Emit canonical verdict: ACs failed
    logger.info("acceptance", "verdict", {
      storyId: ctx.story.id,
      packageDir: ctx.workdir,
      passed: false,
      failedACs: allFailedACs,
      retries: hardeningRetries,
      durationMs,
    });

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
