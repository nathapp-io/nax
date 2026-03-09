/**
 * Precheck orchestrator
 *
 * Runs all prechecks with formatted output. Stops on first Tier 1 blocker (fail-fast).
 * Collects all Tier 2 warnings. Formats human-readable output with emoji indicators.
 * Supports --json flag for machine-readable output.
 */

import type { NaxConfig } from "../config";
import type { PRD } from "../prd/types";
import {
  checkAgentCLI,
  checkClaudeMdExists,
  checkDependenciesInstalled,
  checkDiskSpace,
  checkGitRepoExists,
  checkGitUserConfigured,
  checkGitignoreCoversNax,
  checkLintCommand,
  checkMultiAgentHealth,
  checkOptionalCommands,
  checkPRDValid,
  checkPendingStories,
  checkPromptOverrideFiles,
  checkStaleLock,
  checkTestCommand,
  checkTypecheckCommand,
  checkWorkingTreeClean,
} from "./checks";
import type { Check, PrecheckResult } from "./types";

/** Formatted output with summary */
export interface PrecheckOutput {
  /** Whether all checks passed (no blockers) */
  passed: boolean;
  /** Tier 1 blockers (if any) */
  blockers: Check[];
  /** Tier 2 warnings (if any) */
  warnings: Check[];
  /** Summary counts */
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
  };
  /** PRD feature name (for context) */
  feature: string;
}

/** Exit codes for precheck command */
export const EXIT_CODES = {
  /** All checks passed (or only warnings) */
  SUCCESS: 0,
  /** Tier 1 blocker detected */
  BLOCKER: 1,
  /** Invalid PRD structure */
  INVALID_PRD: 2,
} as const;

/** Options for precheck execution */
export interface PrecheckOptions {
  /** Output format: "human" (default) or "json" */
  format?: "human" | "json";
  /** Working directory */
  workdir: string;
  /** Suppress console output (for programmatic use) */
  silent?: boolean;
}

/** Extended result with exit code for CLI usage */
export interface PrecheckResultWithCode {
  /** Precheck result */
  result: PrecheckResult;
  /** Exit code (0=success, 1=blocker, 2=invalid PRD) */
  exitCode: number;
  /** Output for display */
  output: PrecheckOutput;
  /** Flagged stories from story size gate (v0.16.0) */
  flaggedStories?: import("./story-size-gate").FlaggedStory[];
}

/**
 * Run all precheck validations.
 * Returns result, exit code, and formatted output.
 */
export async function runPrecheck(
  config: NaxConfig,
  prd: PRD,
  options?: PrecheckOptions,
): Promise<PrecheckResultWithCode> {
  const workdir = options?.workdir || process.cwd();
  const format = options?.format || "human";
  const silent = options?.silent ?? false;

  const passed: Check[] = [];
  const blockers: Check[] = [];
  const warnings: Check[] = [];

  // ─────────────────────────────────────────────────────────────────────────────
  // Tier 1 Blockers - fail-fast on first failure
  // ─────────────────────────────────────────────────────────────────────────────

  const tier1Checks = [
    () => checkGitRepoExists(workdir),
    () => checkWorkingTreeClean(workdir),
    () => checkStaleLock(workdir),
    () => checkPRDValid(prd),
    () => checkAgentCLI(config),
    () => checkDependenciesInstalled(workdir),
    () => checkTestCommand(config),
    () => checkLintCommand(config),
    () => checkTypecheckCommand(config),
    () => checkGitUserConfigured(workdir),
  ];

  for (const checkFn of tier1Checks) {
    const result = await checkFn();

    if (format === "human") {
      printCheckResult(result);
    }

    if (result.passed) {
      passed.push(result);
    } else {
      blockers.push(result);
      // Fail-fast: stop on first blocker
      break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tier 2 Warnings - run all regardless of failures
  // ─────────────────────────────────────────────────────────────────────────────

  let flaggedStories: import("./story-size-gate").FlaggedStory[] = [];

  // Only run Tier 2 if no blockers
  if (blockers.length === 0) {
    const tier2Checks = [
      () => checkClaudeMdExists(workdir),
      () => checkDiskSpace(),
      () => checkPendingStories(prd),
      () => checkOptionalCommands(config, workdir),
      () => checkGitignoreCoversNax(workdir),
      () => checkPromptOverrideFiles(config, workdir),
      () => checkMultiAgentHealth(),
    ];

    for (const checkFn of tier2Checks) {
      const result = await checkFn();

      // Handle both single checks and arrays of checks
      const checksToProcess = Array.isArray(result) ? result : [result];

      for (const check of checksToProcess) {
        if (format === "human") {
          printCheckResult(check);
        }

        if (check.passed) {
          passed.push(check);
        } else {
          warnings.push(check);
        }
      }
    }

    // Story size gate (v0.16.0) — separate from standard checks, returns metadata
    const { checkStorySizeGate } = await import("./story-size-gate");
    const sizeGateResult = await checkStorySizeGate(config, prd);

    if (format === "human") {
      printCheckResult(sizeGateResult.check);
    }

    if (sizeGateResult.check.passed) {
      passed.push(sizeGateResult.check);
    } else {
      warnings.push(sizeGateResult.check);
      flaggedStories = sizeGateResult.flaggedStories;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Output formatting
  // ─────────────────────────────────────────────────────────────────────────────

  const output: PrecheckOutput = {
    passed: blockers.length === 0,
    blockers,
    warnings,
    summary: {
      total: passed.length + blockers.length + warnings.length,
      passed: passed.length,
      failed: blockers.length,
      warnings: warnings.length,
    },
    feature: prd.feature,
  };

  // Determine exit code
  let exitCode: number = EXIT_CODES.SUCCESS;
  if (blockers.length > 0) {
    // Check if PRD validation failed specifically
    const hasPRDError = blockers.some((b) => b.name === "prd-valid");
    exitCode = hasPRDError ? EXIT_CODES.INVALID_PRD : EXIT_CODES.BLOCKER;
  }

  if (!silent) {
    if (format === "json") {
      console.log(JSON.stringify(output, null, 2));
    } else {
      printSummary(output);
    }
  }

  return {
    result: { blockers, warnings },
    exitCode,
    output,
    flaggedStories,
  };
}

/**
 * Print a single check result with emoji indicator.
 */
function printCheckResult(check: Check): void {
  let emoji = "";
  if (check.passed) {
    emoji = "✓";
  } else if (check.tier === "blocker") {
    emoji = "✗";
  } else {
    emoji = "⚠";
  }

  console.log(`${emoji} ${check.name}: ${check.message}`);
}

/**
 * Print summary line with counts.
 */
function printSummary(output: PrecheckOutput): void {
  console.log("");
  console.log("─────────────────────────────────────────────────────────────────────────────");
  console.log(`Feature: ${output.feature}`);
  console.log(
    `Checks: ${output.summary.total} total | ${output.summary.passed} passed | ${output.summary.failed} failed | ${output.summary.warnings} warnings`,
  );

  if (output.blockers.length > 0) {
    console.log("\n❌ BLOCKED: Cannot proceed due to failed prechecks");
  } else if (output.warnings.length > 0) {
    console.log("\n⚠️  WARNINGS: Prechecks passed with warnings");
  } else {
    console.log("\n✅ PASSED: All prechecks passed");
  }
}
