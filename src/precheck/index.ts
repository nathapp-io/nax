/**
 * Precheck orchestrator
 *
 * Runs all prechecks with formatted output. Stops on first Tier 1 blocker (fail-fast).
 * Collects all Tier 2 warnings. Formats human-readable output with emoji indicators.
 * Supports --json flag for machine-readable output.
 *
 * Check categories:
 * - **Environment checks** — no PRD needed (git, deps, agent CLI, stale lock)
 * - **Project checks** — require PRD (validation, story counts, story size gate)
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
  checkHomeEnvValid,
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

// ─────────────────────────────────────────────────────────────────────────────
// Check list definitions — shared between runEnvironmentPrecheck and runPrecheck
// ─────────────────────────────────────────────────────────────────────────────

type CheckFn = () => Promise<Check | Check[]>;

/**
 * Early environment checks — git repo, clean tree, stale lock.
 * Fast checks that run first in both runEnvironmentPrecheck and runPrecheck.
 * In runPrecheck, PRD validation is inserted after these (original order preserved).
 */
function getEarlyEnvironmentBlockers(workdir: string): CheckFn[] {
  return [() => checkGitRepoExists(workdir), () => checkWorkingTreeClean(workdir), () => checkStaleLock(workdir)];
}

/**
 * Late environment checks — agent CLI, deps, commands, git user.
 * Run after PRD validation in runPrecheck; all included in runEnvironmentPrecheck.
 */
function getLateEnvironmentBlockers(config: NaxConfig, workdir: string): CheckFn[] {
  return [
    () => checkAgentCLI(config),
    () => checkDependenciesInstalled(workdir),
    () => checkTestCommand(config),
    () => checkLintCommand(config),
    () => checkTypecheckCommand(config),
    () => checkGitUserConfigured(workdir),
  ];
}

/** All environment checks — no PRD needed. Used by runEnvironmentPrecheck. */
function getEnvironmentBlockers(config: NaxConfig, workdir: string): CheckFn[] {
  return [...getEarlyEnvironmentBlockers(workdir), ...getLateEnvironmentBlockers(config, workdir)];
}

/** Environment warnings — no PRD needed. */
function getEnvironmentWarnings(config: NaxConfig, workdir: string): CheckFn[] {
  return [
    () => checkClaudeMdExists(workdir),
    () => checkDiskSpace(),
    () => checkOptionalCommands(config, workdir),
    () => checkGitignoreCoversNax(workdir),
    () => checkHomeEnvValid(),
    () => checkPromptOverrideFiles(config, workdir),
    () => checkMultiAgentHealth(),
  ];
}

/** Project checks — require PRD. */
function getProjectBlockers(prd: PRD): CheckFn[] {
  return [() => checkPRDValid(prd)];
}

/** Project warnings — require PRD. */
function getProjectWarnings(prd: PRD): CheckFn[] {
  return [() => checkPendingStories(prd)];
}

/** Normalize check result to array (some checks return Check[]) */
function normalizeChecks(result: Check | Check[]): Check[] {
  return Array.isArray(result) ? result : [result];
}

/** Result from environment-only precheck */
export interface EnvironmentPrecheckResult {
  /** Whether all environment checks passed (no blockers) */
  passed: boolean;
  /** Blocker check results */
  blockers: Check[];
  /** Warning check results */
  warnings: Check[];
}

/**
 * Run environment-only prechecks (no PRD needed).
 *
 * Use before plan phase to catch environment issues early,
 * before expensive LLM calls are made.
 */
export async function runEnvironmentPrecheck(
  config: NaxConfig,
  workdir: string,
  options?: { format?: "human" | "json"; silent?: boolean },
): Promise<EnvironmentPrecheckResult> {
  const format = options?.format ?? "human";
  const silent = options?.silent ?? false;

  const passed: Check[] = [];
  const blockers: Check[] = [];
  const warnings: Check[] = [];

  // Environment blockers — fail-fast
  for (const checkFn of getEnvironmentBlockers(config, workdir)) {
    const checks = normalizeChecks(await checkFn());
    let blocked = false;
    for (const check of checks) {
      if (!silent && format === "human") printCheckResult(check);
      if (check.passed) {
        passed.push(check);
      } else {
        blockers.push(check);
        blocked = true;
        break;
      }
    }
    if (blocked) break;
  }

  // Environment warnings — only if no blockers
  if (blockers.length === 0) {
    for (const checkFn of getEnvironmentWarnings(config, workdir)) {
      for (const check of normalizeChecks(await checkFn())) {
        if (!silent && format === "human") printCheckResult(check);
        if (check.passed) {
          passed.push(check);
        } else {
          warnings.push(check);
        }
      }
    }
  }

  if (!silent && format === "json") {
    console.log(JSON.stringify({ passed: blockers.length === 0, blockers, warnings }, null, 2));
  }

  return { passed: blockers.length === 0, blockers, warnings };
}

/**
 * Run all precheck validations (environment + project).
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
  // Tier 1 Blockers — environment + project, fail-fast on first failure
  // ─────────────────────────────────────────────────────────────────────────────

  // Original order preserved: early env → PRD valid → late env
  // checkPRDValid at position 4 ensures test environments that lack agent CLI
  // still get EXIT_CODES.INVALID_PRD (2) rather than a generic blocker (1)
  const tier1Checks = [
    ...getEarlyEnvironmentBlockers(workdir),
    ...getProjectBlockers(prd),
    ...getLateEnvironmentBlockers(config, workdir),
  ];

  let tier1Blocked = false;
  for (const checkFn of tier1Checks) {
    for (const check of normalizeChecks(await checkFn())) {
      if (format === "human") printCheckResult(check);
      if (check.passed) {
        passed.push(check);
      } else {
        blockers.push(check);
        tier1Blocked = true;
        break;
      }
    }
    if (tier1Blocked) break;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tier 2 Warnings — environment + project, run all regardless of failures
  // ─────────────────────────────────────────────────────────────────────────────

  let flaggedStories: import("./story-size-gate").FlaggedStory[] = [];

  // Only run Tier 2 if no blockers
  if (blockers.length === 0) {
    const tier2Checks = [...getEnvironmentWarnings(config, workdir), ...getProjectWarnings(prd)];

    for (const checkFn of tier2Checks) {
      for (const check of normalizeChecks(await checkFn())) {
        if (format === "human") printCheckResult(check);
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
