/**
 * Accept Command
 *
 * Allows manual override of failed acceptance criteria.
 * Stores override in prd.json with reason.
 *
 * Usage:
 *   nax accept --override AC-2 "intentional: using lazy expiry instead of exact timing"
 */

import chalk from "chalk";
import { loadPRD, savePRD } from "../prd";
import { findProjectDir, validateDirectory } from "../config";
import path from "node:path";

/**
 * Accept command options.
 */
export interface AcceptOptions {
  /** Feature name */
  feature: string;
  /** AC ID to override (e.g., "AC-2") */
  override: string;
  /** Reason for accepting despite test failure */
  reason: string;
}

/**
 * Execute the accept command.
 *
 * Loads the PRD, adds the AC override with reason, and saves.
 *
 * @param options - Command options
 *
 * @example
 * ```bash
 * nax accept --feature auth-system --override AC-2 "intentional: lazy expiry"
 * ```
 */
export async function acceptCommand(options: AcceptOptions): Promise<void> {
  const { feature, override, reason } = options;

  // Validate AC ID format
  if (!override.match(/^AC-\d+$/i)) {
    console.error(chalk.red(`❌ Invalid AC ID format: ${override}`));
    console.error(chalk.yellow("   Expected format: AC-1, AC-2, etc."));
    process.exit(1);
  }

  // Normalize AC ID to uppercase
  const acId = override.toUpperCase();

  // Find project directory
  const projectDirResult = findProjectDir(process.cwd());
  if (!projectDirResult) {
    console.error(chalk.red("❌ Not in a nax project directory"));
    console.error(chalk.yellow("   Run 'nax init' first"));
    process.exit(1);
  }
  const projectDir = projectDirResult;

  // Validate directory
  try {
    validateDirectory(projectDir);
  } catch (err) {
    console.error(chalk.red(`❌ Invalid project directory: ${(err as Error).message}`));
    process.exit(1);
  }

  // Build path to feature PRD
  const featureDir = path.join(projectDir, "nax", "features", feature);
  const prdPath = path.join(featureDir, "prd.json");

  // Check if feature exists
  const prdFile = Bun.file(prdPath);
  if (!(await prdFile.exists())) {
    console.error(chalk.red(`❌ Feature not found: ${feature}`));
    console.error(chalk.yellow(`   Expected PRD at: ${prdPath}`));
    process.exit(1);
  }

  // Load PRD
  const prd = await loadPRD(prdPath);

  // Add override
  if (!prd.acceptanceOverrides) {
    prd.acceptanceOverrides = {};
  }

  if (prd.acceptanceOverrides[acId]) {
    console.log(chalk.yellow(`⚠️  Override already exists for ${acId}`));
    console.log(chalk.dim(`   Previous: ${prd.acceptanceOverrides[acId]}`));
    console.log(chalk.dim(`   New:      ${reason}`));
  }

  prd.acceptanceOverrides[acId] = reason;

  // Save PRD
  await savePRD(prd, prdPath);

  console.log(chalk.green(`✓ Override added for ${acId}`));
  console.log(chalk.dim(`   Reason: ${reason}`));
  console.log(chalk.dim(`   PRD updated: ${prdPath}`));
  console.log(chalk.cyan("\n💡 Re-run acceptance tests to verify:"));
  console.log(chalk.dim(`   bun test ${path.join(featureDir, "acceptance.test.ts")}`));
}
