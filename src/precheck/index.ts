/**
 * Precheck orchestrator
 *
 * Runs all prechecks with formatted output. Stops on first Tier 1 blocker (fail-fast).
 * Collects all Tier 2 warnings. Formats human-readable output with emoji indicators.
 * Supports --json flag for machine-readable output.
 */

import type { Check, PrecheckResult } from "./types";
import type { NaxConfig } from "../config";
import type { PRD } from "../prd/types";
import {
	checkGitRepoExists,
	checkWorkingTreeClean,
	checkStaleLock,
	checkPRDValid,
	checkClaudeCLI,
	checkDependenciesInstalled,
	checkTestCommand,
	checkLintCommand,
	checkTypecheckCommand,
	checkGitUserConfigured,
	checkClaudeMdExists,
	checkDiskSpace,
	checkPendingStories,
	checkOptionalCommands,
	checkGitignoreCoversNax,
} from "./checks";

/** Formatted output with summary */
export interface PrecheckOutput {
	/** All checks that passed */
	passed: Check[];
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

/** Options for precheck execution */
export interface PrecheckOptions {
	/** Output format: "human" (default) or "json" */
	format?: "human" | "json";
	/** Working directory */
	workdir: string;
}

/**
 * Run all precheck validations.
 * Returns blockers and warnings arrays.
 */
export async function runPrecheck(config: NaxConfig, prd: PRD, options?: PrecheckOptions): Promise<PrecheckResult> {
	const workdir = options?.workdir || process.cwd();
	const format = options?.format || "human";

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
		() => checkClaudeCLI(),
		() => checkDependenciesInstalled(workdir),
		() => checkTestCommand(config),
		() => checkLintCommand(config),
		() => checkTypecheckCommand(config),
		() => checkGitUserConfigured(),
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

	// Only run Tier 2 if no blockers
	if (blockers.length === 0) {
		const tier2Checks = [
			() => checkClaudeMdExists(workdir),
			() => checkDiskSpace(),
			() => checkPendingStories(prd),
			() => checkOptionalCommands(config),
			() => checkGitignoreCoversNax(workdir),
		];

		for (const checkFn of tier2Checks) {
			const result = await checkFn();

			if (format === "human") {
				printCheckResult(result);
			}

			if (result.passed) {
				passed.push(result);
			} else {
				warnings.push(result);
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Output formatting
	// ─────────────────────────────────────────────────────────────────────────────

	const output: PrecheckOutput = {
		passed,
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

	if (format === "json") {
		console.log(JSON.stringify(output, null, 2));
	} else {
		printSummary(output);
	}

	return { blockers, warnings };
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
	console.log(`Checks: ${output.summary.total} total | ${output.summary.passed} passed | ${output.summary.failed} failed | ${output.summary.warnings} warnings`);

	if (output.blockers.length > 0) {
		console.log("\n❌ BLOCKED: Cannot proceed due to failed prechecks");
		process.exitCode = 1;
	} else if (output.warnings.length > 0) {
		console.log("\n⚠️  WARNINGS: Prechecks passed with warnings");
		process.exitCode = 0;
	} else {
		console.log("\n✅ PASSED: All prechecks passed");
		process.exitCode = 0;
	}
}
