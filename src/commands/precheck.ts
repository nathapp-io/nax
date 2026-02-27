/**
 * Precheck command implementation
 *
 * Runs precheck validations and displays results in human or JSON format.
 * Uses resolveProject() for directory resolution.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { resolveProject } from "./common";
import { loadConfig } from "../config";
import { loadPRD } from "../prd";
import { runPrecheck, EXIT_CODES } from "../precheck";

/**
 * Options for precheck command
 */
export interface PrecheckOptions {
	/** Feature name (from -f flag) */
	feature?: string;
	/** Explicit project directory (from -d flag) */
	dir?: string;
	/** Output JSON format (from --json flag) */
	json?: boolean;
}

/**
 * Run precheck command
 *
 * Validates feature readiness before execution.
 * Exits with code 0 (pass), 1 (blocker), or 2 (invalid PRD).
 */
export async function precheckCommand(options: PrecheckOptions): Promise<void> {
	// Resolve project directory and feature
	const resolved = resolveProject({
		dir: options.dir,
		feature: options.feature,
	});

	// Determine feature name (from flag or config)
	let featureName = options.feature;
	if (!featureName) {
		// Read from config.json
		const configFile = Bun.file(resolved.configPath);
		const config = await configFile.json();
		featureName = config.feature;

		if (!featureName) {
			console.error(chalk.red("No feature specified. Use -f flag or set feature in config.json"));
			process.exit(1);
		}
	}

	// Get feature directory
	const naxDir = join(resolved.projectDir, "nax");
	const featureDir = join(naxDir, "features", featureName);
	const prdPath = join(featureDir, "prd.json");

	// Validate feature directory exists
	if (!existsSync(featureDir)) {
		console.error(chalk.red(`Feature not found: ${featureName}`));
		process.exit(1);
	}

	// Validate prd.json exists
	if (!existsSync(prdPath)) {
		console.error(chalk.red(`Missing prd.json for feature: ${featureName}`));
		console.error(chalk.dim("Run: nax analyze -f " + featureName));
		process.exit(EXIT_CODES.INVALID_PRD);
	}

	// Load config and PRD
	const config = await loadConfig(resolved.projectDir);
	const prd = await loadPRD(prdPath);

	// Run precheck
	const format = options.json ? "json" : "human";
	const result = await runPrecheck(config, prd, {
		workdir: resolved.projectDir,
		format,
	});

	// Exit with appropriate code
	process.exit(result.exitCode);
}
