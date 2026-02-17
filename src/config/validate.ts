/**
 * Configuration Validation
 *
 * @deprecated Use NgentConfigSchema.safeParse() from schema.ts instead.
 * This module is kept for backward compatibility only.
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

  // Models mapping
  const requiredTiers = ["fast", "balanced", "powerful"] as const;
  if (!config.models) {
    errors.push("models mapping is required");
  } else {
    for (const tier of requiredTiers) {
      const entry = config.models[tier];
      if (!entry) {
        errors.push(`models.${tier} is required`);
      } else if (typeof entry === "string") {
        if (entry.trim() === "") {
          errors.push(`models.${tier} must be a non-empty model identifier`);
        }
      } else {
        if (!entry.provider || entry.provider.trim() === "") {
          errors.push(`models.${tier}.provider must be non-empty`);
        }
        if (!entry.model || entry.model.trim() === "") {
          errors.push(`models.${tier}.model must be non-empty`);
        }
      }
    }
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

  // Validate complexityRouting values are valid ModelTier keys
  const validTiers = ["fast", "balanced", "powerful"] as const;
  const complexities = ["simple", "medium", "complex", "expert"] as const;
  for (const complexity of complexities) {
    const tier = config.autoMode.complexityRouting[complexity];
    if (!validTiers.includes(tier as any)) {
      errors.push(`complexityRouting.${complexity} must be one of: ${validTiers.join(", ")} (got '${tier}')`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
