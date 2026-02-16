/**
 * Configuration Validation
 *
 * Validates NgentConfig structure and constraints.
 */

import type { NgentConfig } from "./schema";

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate NgentConfig
 *
 * Checks:
 * - version === 1
 * - maxIterations > 0
 * - costLimit > 0
 * - sessionTimeoutSeconds > 0
 * - defaultAgent is non-empty
 * - escalation.maxAttempts > 0
 */
export function validateConfig(config: NgentConfig): ValidationResult {
  const errors: string[] = [];

  // Version check
  if (config.version !== 1) {
    errors.push(`Invalid version: expected 1, got ${config.version}`);
  }

  // Execution limits
  if (config.execution.maxIterations <= 0) {
    errors.push(`maxIterations must be > 0, got ${config.execution.maxIterations}`);
  }

  if (config.execution.costLimit <= 0) {
    errors.push(`costLimit must be > 0, got ${config.execution.costLimit}`);
  }

  if (config.execution.sessionTimeoutSeconds <= 0) {
    errors.push(`sessionTimeoutSeconds must be > 0, got ${config.execution.sessionTimeoutSeconds}`);
  }

  // Auto mode config
  if (!config.autoMode.defaultAgent || config.autoMode.defaultAgent.trim() === "") {
    errors.push("defaultAgent must be non-empty");
  }

  if (config.autoMode.escalation.maxAttempts <= 0) {
    errors.push(`escalation.maxAttempts must be > 0, got ${config.autoMode.escalation.maxAttempts}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
