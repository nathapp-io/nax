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
import type { HardeningContext } from "@/acceptance";
import { buildAcceptanceRunCommand, resolveAcceptanceFeatureTestPath } from "@/acceptance";
import type { Finding } from "@/findings";
import { acFailureToFinding, acSentinelToFinding } from "@/findings";
import { getLogger } from "@/logger";
import { countStories, isInAcceptanceScope } from "@/prd";
import {
  parseTestFailures as _parseTestFailures,
  analyzeTestExitCode,
  parseTestFailuresDetailed,
} from "@/test-runners";
import { logTestOutput } from "@/utils/log-test-output";
import { executeWithTimeout, shellQuoteArg } from "@/verification";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

/** Injectable deps for testability */
export const _acceptanceStageDeps = {
  runHardeningPass: async (ctx: HardeningContext) => {
    const { runHardeningPass } = await import("@/acceptance");
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
      storyCount?: number;
      acceptanceEnabled?: boolean;
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

    // US-003: count PRD stories per package for missing-target storyCount fallback.
    // Same SSOT grouping as AcceptanceTestGroup.stories in src/acceptance/test-path.ts.
    const storiesByPackageDir = new Map<string, number>();
    for (const s of ctx.prd.userStories) {
      if (!isInAcceptanceScope(s)) continue;
      const wd = s.workdir ?? "";
      const pkgDir = wd ? path.join(ctx.workdir, wd) : ctx.workdir;
      storiesByPackageDir.set(pkgDir, (storiesByPackageDir.get(pkgDir) ?? 0) + 1);
    }

    // Collect combined results across all packages
    const allFailedACs: string[] = [];
    // BUG-12: each package numbers its acceptance criteria AC-1..N independently, so
    // package A's AC-2 and package B's different AC-2 are distinct failures. Dedup by
    // packageDir+acId (not the bare acId) so the aggregate never under-reports.
    const seenAcKeys = new Set<string>();
    const allFindings: Finding[] = [];
    const failedPackages: Array<{
      testPath: string;
      packageDir: string;
      testFramework?: string;
      commandOverride?: string;
      output: string;
      failedACs: string[];
    }> = [];
    const missingTargets: string[] = [];
    const allOutputParts: string[] = [];
    let anyError = false;
    let errorExitCode = 0;
    // Acceptance criteria promoted by the non-blocking hardening pass. Reported
    // on the verdict under its own key — it is NOT a retry count (#1424).
    let hardeningPromoted = 0;

    for (const { testPath, packageDir, testFramework, commandOverride, storyCount, acceptanceEnabled } of testGroups) {
      // Check if test file exists
      const testFile = Bun.file(testPath);
      const exists = await testFile.exists();

      if (!exists) {
        // US-003: missing target only fails the run when the package has PRD stories
        // AND acceptance is enabled for that package. Empty groups and per-package
        // disabled acceptance are honored as skips, mirroring the root-level flag.
        // Applies uniformly to the fallback single-file group too — a missing test
        // file is a hard fail whenever the package has stories and acceptance is on.
        const resolvedStoryCount = storyCount ?? storiesByPackageDir.get(packageDir) ?? 0;
        const resolvedAcceptanceEnabled = acceptanceEnabled ?? true;
        if (resolvedStoryCount > 0 && resolvedAcceptanceEnabled) {
          logger.warn("acceptance", "Required acceptance test file missing", {
            storyId: ctx.story.id,
            testPath,
            packageDir,
          });
          missingTargets.push(packageDir);
        } else {
          logger.warn("acceptance", "Acceptance test file not found — skipping", {
            storyId: ctx.story.id,
            testPath,
            packageDir,
          });
        }
        continue;
      }

      // @design: BUG-083/BUG-084: Run ONLY the acceptance test file, not the full project test suite.
      // Resolution order: per-package commandOverride → per-package testFramework → bun test fallback.
      // In monorepo mode, testFramework and commandOverride come from the per-package config
      // resolved by acceptance-setup. In fallback (single-package) mode they fall back to ctx.config.
      const resolvedFramework = testFramework ?? ctx.config.project?.testFramework;
      const resolvedCommand = commandOverride ?? ctx.config.acceptance.command;
      const testCmdParts = buildAcceptanceRunCommand(testPath, resolvedFramework, resolvedCommand, packageDir);
      logger.info("acceptance", "Running acceptance command", {
        storyId: ctx.story.id,
        cmd: testCmdParts.join(" "),
        packageDir,
      });
      const execution = await executeWithTimeout(
        testCmdParts.map(shellQuoteArg).join(" "),
        Math.ceil(ctx.config.acceptance.timeoutMs / 1000),
        undefined,
        { cwd: packageDir },
      );

      const exitCode = execution.exitCode ?? (execution.success ? 0 : 1);
      const output = execution.output ?? "";
      allOutputParts.push(output);

      const { failedACs, taggedFailureCount } = parseTestFailuresDetailed(output);

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
        failedPackages.push({ testPath, packageDir, testFramework, commandOverride, output, failedACs: ["AC-ERROR"] });
        continue;
      }

      // BUG-12: non-zero exit where every parsed AC failure happens to be
      // overridden. Without this check, actualFailures ends up empty and the
      // package falls through both the "failed" branch below (actualFailures
      // is empty) and the "passed" branch (exitCode !== 0) — it silently
      // vanishes from the verdict, reporting "all packages passed" despite a
      // suite crash unrelated to (or beyond) the overridden ACs.
      //
      // Distinguishing that from the legitimate case — the exit is non-zero
      // *because* the single overridden AC's own test failed, and nothing
      // else did — requires the framework's own pass/fail summary count, not
      // just the AC-tagged failures parseTestFailures could line-match: a
      // hook-timeout or import-error failure is real but has no "AC-N:"
      // label to be parsed as an AC in the first place, so it would never
      // show up in `failedACs`. If the summary's total fail count exceeds
      // the number of AC-tagged failure *lines* we found, something failed
      // beyond the (overridden) ACs.
      //
      // BUG-32: compare against `taggedFailureCount` (raw, non-deduplicated
      // count of matched failure lines), not `failedACs.length` (deduplicated
      // AC-id count) — a single overridden AC can have more than one failing
      // test case (e.g. 3 failing `it()` blocks all tagged AC-3), which would
      // otherwise make failCount (3) exceed the deduplicated count (1) and
      // false-positive "suite may have crashed" on a legitimately-passing
      // (post-override) package.
      if (exitCode !== 0 && failedACs.length > 0 && actualFailures.length === 0) {
        const { failCount } = analyzeTestExitCode(output, exitCode);
        if (failCount > taggedFailureCount) {
          logger.error(
            "acceptance",
            "Tests exited non-zero with all failing ACs overridden, but more tests failed than were AC-tagged — suite may have crashed",
            {
              storyId: ctx.story.id,
              exitCode,
              packageDir,
              overriddenFailures,
              failCount,
              acTaggedFailures: taggedFailureCount,
            },
          );
          logTestOutput(logger, "acceptance", output);
          anyError = true;
          errorExitCode = exitCode;
          allFailedACs.push("AC-ERROR");
          allFindings.push(acSentinelToFinding("AC-ERROR", output));
          failedPackages.push({
            testPath,
            packageDir,
            testFramework,
            commandOverride,
            output,
            failedACs: ["AC-ERROR"],
          });
          continue;
        }
      }

      for (const acId of actualFailures) {
        const acKey = `${packageDir}::${acId}`;
        if (!seenAcKeys.has(acKey)) {
          seenAcKeys.add(acKey);
          allFailedACs.push(acId);
          allFindings.push(
            acId === "AC-HOOK" ? acSentinelToFinding("AC-HOOK", output) : acFailureToFinding(acId, output),
          );
        }
      }

      if (actualFailures.length > 0) {
        failedPackages.push({
          testPath,
          packageDir,
          testFramework,
          commandOverride,
          output,
          failedACs: actualFailures,
        });
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

    // US-003: missing required acceptance targets fail the run with every affected
    // packageDir named in the reason. Surface them before the pass/fail verdict so
    // the verdict still reports the missing-target package list. The missingTargets
    // field on acceptanceFailures is what runAcceptanceTestsOnce reads downstream
    // — without it, the consumer would treat "no failedACs" as passed and silently
    // close the run as successful. AC failures collected from other packages are
    // preserved alongside missingTargets — only the missing-target package's own
    // ACs are absent (AC-7), not the union across packages.
    if (missingTargets.length > 0) {
      ctx.acceptanceFailures = {
        failedACs: allFailedACs,
        findings: allFindings,
        testOutput: combinedOutput,
        failedPackages,
        missingTargets,
      };
      logger.info("acceptance", "verdict", {
        storyId: ctx.story.id,
        packageDir: ctx.workdir,
        passed: false,
        failedACs: allFailedACs,
        retries: ctx.acceptanceRetries ?? 0,
        hardeningPromoted,
        durationMs,
        missingTargets,
      });
      return {
        action: "fail",
        reason: `Required acceptance test files are missing for packages: ${missingTargets.join(", ")}`,
      };
    }

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
          hardeningPromoted = result.promoted.length;
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
        retries: ctx.acceptanceRetries ?? 0,
        hardeningPromoted,
        durationMs,
      });

      return { action: "continue" };
    }

    // Store failures for fix generation
    ctx.acceptanceFailures = {
      failedACs: allFailedACs,
      findings: allFindings,
      testOutput: combinedOutput,
      failedPackages,
    };

    // Emit canonical verdict: ACs failed
    logger.info("acceptance", "verdict", {
      storyId: ctx.story.id,
      packageDir: ctx.workdir,
      passed: false,
      failedACs: allFailedACs,
      retries: ctx.acceptanceRetries ?? 0,
      hardeningPromoted,
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
