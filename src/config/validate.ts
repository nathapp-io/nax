/**
 * Configuration Validation
 *
 * @deprecated Use NaxConfigSchema.safeParse() from schema.ts instead.
 * This module is kept for backward compatibility only.
 *
 * Validates NaxConfig structure and constraints.
 */

import type { NaxConfig } from "./schema";

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate NaxConfig
 *
 * Checks:
 * - version === 1
 * - maxIterations > 0
 * - costLimit > 0
 * - sessionTimeoutSeconds > 0
 * - defaultAgent is non-empty
 * - escalation.tierOrder has at least one tier with valid attempts
 */
export function validateConfig(config: NaxConfig): ValidationResult {
  const errors: string[] = [];

  // Version check
  if (config.version !== 1) {
    errors.push(`Invalid version: expected 1, got ${config.version}`);
  }

  // Models mapping (per-agent structure: Record<agentName, Record<ModelTier, ModelEntry>>)
  const requiredTiers = ["fast", "balanced", "powerful"] as const;
  if (!config.models) {
    errors.push("models mapping is required");
  } else {
    const defaultAgent = config.autoMode?.defaultAgent ?? "claude";
    const agentModels = config.models[defaultAgent];
    if (!agentModels) {
      errors.push(`models.${defaultAgent} is required (default agent has no model map)`);
    } else {
      for (const tier of requiredTiers) {
        const entry = agentModels[tier];
        if (!entry) {
          errors.push(`models.${defaultAgent}.${tier} is required`);
        } else if (typeof entry === "string") {
          if (entry.trim() === "") {
            errors.push(`models.${defaultAgent}.${tier} must be a non-empty model identifier`);
          }
        } else {
          if (!entry.provider || entry.provider.trim() === "") {
            errors.push(`models.${defaultAgent}.${tier}.provider must be non-empty`);
          }
          if (!entry.model || entry.model.trim() === "") {
            errors.push(`models.${defaultAgent}.${tier}.model must be non-empty`);
          }
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

  if (!config.autoMode.escalation.tierOrder || config.autoMode.escalation.tierOrder.length === 0) {
    errors.push("escalation.tierOrder must have at least one tier");
  } else {
    for (const tc of config.autoMode.escalation.tierOrder) {
      if (tc.attempts < 1 || tc.attempts > 20) {
        errors.push(`escalation.tierOrder: tier "${tc.tier}" attempts must be 1-20, got ${tc.attempts}`);
      }
    }
  }

  // Validate fallbackOrder agents exist as keys in models
  if (config.models && config.autoMode?.fallbackOrder) {
    const modelKeys = Object.keys(config.models);
    for (const agent of config.autoMode.fallbackOrder) {
      if (!modelKeys.includes(agent)) {
        errors.push(
          `autoMode.fallbackOrder: agent "${agent}" is not a key in models (available: ${modelKeys.join(", ")})`,
        );
      }
    }
  }

  // Validate tierOrder entries with agent field exist as keys in models
  if (config.models && config.autoMode?.escalation?.tierOrder) {
    const modelKeys = Object.keys(config.models);
    for (const tc of config.autoMode.escalation.tierOrder) {
      if (tc.agent !== undefined && !modelKeys.includes(tc.agent)) {
        errors.push(
          `autoMode.escalation.tierOrder: tier "${tc.tier}" agent "${tc.agent}" is not a key in models (available: ${modelKeys.join(", ")})`,
        );
      }
    }
  }

  // Validate complexityRouting values reference tiers that exist in models config
  const defaultAgentKey = config.autoMode?.defaultAgent ?? "claude";
  const configuredTiers = Object.keys(config.models[defaultAgentKey] ?? {});
  const complexities = ["simple", "medium", "complex", "expert"] as const;
  for (const complexity of complexities) {
    const tier = config.autoMode.complexityRouting[complexity];
    if (!configuredTiers.includes(tier)) {
      errors.push(`complexityRouting.${complexity} must be one of: ${configuredTiers.join(", ")} (got '${tier}')`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
