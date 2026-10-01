/**
 * Configuration Validation
 *
 * @deprecated Use NaxConfigSchema.safeParse() from schema.ts instead.
 * This module is kept for backward compatibility only.
 *
 * Validates NaxConfig structure and constraints. Each field group's checks
 * live in `./validate-fields`; this file sequences the groups in the original
 * evaluation order and assembles the result.
 */

import type { NaxConfig } from "./schema";
import {
  checkAgentDefault,
  checkComplexityRouting,
  checkExecutionLimits,
  checkFallbackMapAgents,
  checkModelsMapping,
  checkTierOrder,
  checkTierOrderAgentKeys,
  checkVersion,
} from "./validate-fields";

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate NaxConfig
 *
 * Checks (evaluated in this order; every error collected, none short-circuit):
 * - version === 1
 * - models mapping: default agent has a map; required tiers present; entry
 *   content (non-empty string ids / provider+model)
 * - execution.maxIterations > 0
 * - execution.costLimit > 0
 * - execution.sessionTimeoutSeconds > 0
 * - agent.default is non-empty
 * - escalation.tierOrder has at least one tier with valid attempts
 * - agent.fallback.map agents exist as keys in models (AC5 — US-001-5)
 * - tierOrder agent keys exist in models; agentless rungs resolve under the
 *   default agent's map
 * - complexityRouting values reference tiers that exist in models config
 */
export function validateConfig(config: NaxConfig): ValidationResult {
  const errors: string[] = [];

  errors.push(...checkVersion(config));
  errors.push(...checkModelsMapping(config));
  errors.push(...checkExecutionLimits(config));
  errors.push(...checkAgentDefault(config));
  errors.push(...checkTierOrder(config));
  errors.push(...checkFallbackMapAgents(config));
  errors.push(...checkTierOrderAgentKeys(config));
  errors.push(...checkComplexityRouting(config));

  return {
    valid: errors.length === 0,
    errors,
  };
}
