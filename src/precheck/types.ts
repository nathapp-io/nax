/**
 * Precheck type definitions
 *
 * Types for the precheck system including results, checks, statuses, and tiers.
 */

/** Check tier classification */
export type CheckTier = "blocker" | "warning";

/** Check execution status */
export type CheckStatus = "passed" | "failed" | "skipped";

/** Individual check result */
export interface Check {
	/** Check identifier (kebab-case) */
	name: string;
	/** Severity tier */
	tier: CheckTier;
	/** Whether the check passed */
	passed: boolean;
	/** Human-readable message explaining the result */
	message: string;
}

/** Complete precheck result */
export interface PrecheckResult {
	/** Failed Tier 1 checks (execution blockers) */
	blockers: Check[];
	/** Failed Tier 2 checks (non-blocking warnings) */
	warnings: Check[];
}
