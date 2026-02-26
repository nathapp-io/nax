/**
 * Accept Command
 *
 * Allows manual override of failed acceptance criteria.
 * Stores override in prd.json with reason.
 *
 * Usage:
 *   nax accept --override AC-2 "intentional: using lazy expiry instead of exact timing"
 */

import path from "node:path";
import { findProjectDir, validateDirectory } from "../config";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { loadPRD, savePRD } from "../prd";

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
  const logger = getLogger();
  const { feature, override, reason } = options;

  // Validate AC ID format
  if (!override.match(/^AC-\d+$/i)) {
    logger.error("cli", "Invalid AC ID format", { override, expected: "AC-1, AC-2, etc." });
    throw new NaxError("Invalid AC ID format", "INVALID_AC_ID", { override, expected: "AC-1, AC-2, etc." });
  }

  // Normalize AC ID to uppercase
  const acId = override.toUpperCase();

  // Find project directory
  const projectDirResult = findProjectDir(process.cwd());
  if (!projectDirResult) {
    logger.error("cli", "Not in a nax project directory", { hint: "Run 'nax init' first" });
    throw new NaxError("Not in a nax project directory", "PROJECT_NOT_FOUND", { hint: "Run 'nax init' first" });
  }
  const projectDir = projectDirResult;

  // Validate directory
  try {
    validateDirectory(projectDir);
  } catch (err) {
    logger.error("cli", "Invalid project directory", { error: (err as Error).message });
    throw new NaxError("Invalid project directory", "INVALID_DIRECTORY", { error: (err as Error).message });
  }

  // Build path to feature PRD
  const featureDir = path.join(projectDir, "nax", "features", feature);
  const prdPath = path.join(featureDir, "prd.json");

  // Check if feature exists
  const prdFile = Bun.file(prdPath);
  if (!(await prdFile.exists())) {
    logger.error("cli", "Feature not found", { feature, prdPath });
    throw new NaxError("Feature not found", "FEATURE_NOT_FOUND", { feature, prdPath });
  }

  // Load PRD
  const prd = await loadPRD(prdPath);

  // Add override
  if (!prd.acceptanceOverrides) {
    prd.acceptanceOverrides = {};
  }

  if (prd.acceptanceOverrides[acId]) {
    logger.warn("cli", "Override already exists", {
      acId,
      previous: prd.acceptanceOverrides[acId],
      new: reason,
    });
  }

  prd.acceptanceOverrides[acId] = reason;

  // Save PRD
  await savePRD(prd, prdPath);

  logger.info("cli", "✓ Override added", {
    acId,
    reason,
    prdPath,
    hint: `Re-run acceptance tests: bun test ${path.join(featureDir, "acceptance.test.ts")}`,
  });
}
