/**
 * Field-group validators for `validateConfig`.
 *
 * Extracted from `src/config/validate.ts` for the complexity drain (batch C1a):
 * each function owns one field group and returns its errors in the original
 * evaluation order — `validateConfig` concatenates the groups in the order the
 * pre-extraction monolith pushed them. Every message is a byte-exact contract
 * (pinned by test/unit/config/validate.test.ts): do not reword.
 *
 * @deprecated Part of the deprecated validateConfig path; use
 * NaxConfigSchema.safeParse() from schema.ts instead.
 */

import { DEFAULT_AGENT_NAME } from "./agent-defaults";
import type { ModelEntry, NaxConfig } from "./schema";

/** Model tiers every required agent map must provide. */
const REQUIRED_TIERS = ["fast", "balanced", "powerful"] as const;

/** Complexity routing keys, in evaluation order. */
const COMPLEXITIES = ["simple", "medium", "complex", "expert"] as const;

/** The agent a models lookup resolves against when `agent.default` is unset. */
function defaultAgentKey(config: NaxConfig): string {
  return config.agent?.default ?? DEFAULT_AGENT_NAME;
}

/**
 * Shared base of both "missing required tier" messages: the default-agent form
 * pushes it verbatim; the fallback-map form appends its own parenthetical.
 */
function missingTierMessage(agent: string, tier: string): string {
  return `models.${agent}.${tier} is required`;
}

/** The `version === 1` guard. */
export function checkVersion(config: NaxConfig): string[] {
  if (config.version !== 1) {
    return [`Invalid version: expected 1, got ${config.version}`];
  }
  return [];
}

/** Content checks for one model entry (string or object form). */
function checkModelEntry(agent: string, tier: string, entry: ModelEntry): string[] {
  if (typeof entry === "string") {
    if (entry.trim() === "") {
      return [`models.${agent}.${tier} must be a non-empty model identifier`];
    }
    return [];
  }
  const errors: string[] = [];
  if (!entry.provider || entry.provider.trim() === "") {
    errors.push(`models.${agent}.${tier}.provider must be non-empty`);
  }
  if (!entry.model || entry.model.trim() === "") {
    errors.push(`models.${agent}.${tier}.model must be non-empty`);
  }
  return errors;
}

/** The per-agent models mapping: required map, required tiers, entry content. */
export function checkModelsMapping(config: NaxConfig): string[] {
  if (!config.models) {
    return ["models mapping is required"];
  }
  const agent = defaultAgentKey(config);
  const agentModels = config.models[agent];
  if (!agentModels) {
    return [`models.${agent} is required (default agent has no model map)`];
  }
  const errors: string[] = [];
  for (const tier of REQUIRED_TIERS) {
    const entry = agentModels[tier];
    if (!entry) {
      errors.push(missingTierMessage(agent, tier));
    } else {
      errors.push(...checkModelEntry(agent, tier, entry));
    }
  }
  return errors;
}

/** Execution limit floors: maxIterations, costLimit, sessionTimeoutSeconds. */
export function checkExecutionLimits(config: NaxConfig): string[] {
  const errors: string[] = [];
  if (config.execution.maxIterations <= 0) {
    errors.push(`maxIterations must be > 0, got ${config.execution.maxIterations}`);
  }
  if (config.execution.costLimit <= 0) {
    errors.push(`costLimit must be > 0, got ${config.execution.costLimit}`);
  }
  if (config.execution.sessionTimeoutSeconds <= 0) {
    errors.push(`sessionTimeoutSeconds must be > 0, got ${config.execution.sessionTimeoutSeconds}`);
  }
  return errors;
}

/** The `agent.default` non-empty guard. */
export function checkAgentDefault(config: NaxConfig): string[] {
  const agentDefault = config.agent?.default;
  if (!agentDefault || agentDefault.trim() === "") {
    return ["agent.default must be non-empty"];
  }
  return [];
}

/** Escalation tier order: required, and every entry's attempts within 1-20. */
export function checkTierOrder(config: NaxConfig): string[] {
  const tierOrder = config.autoMode.escalation.tierOrder;
  if (!tierOrder || tierOrder.length === 0) {
    return ["escalation.tierOrder must have at least one tier"];
  }
  const errors: string[] = [];
  for (const tc of tierOrder) {
    if (tc.attempts < 1 || tc.attempts > 20) {
      errors.push(`escalation.tierOrder: tier "${tc.tier}" attempts must be 1-20, got ${tc.attempts}`);
    }
  }
  return errors;
}

/** The fallback map: agent name → ordered fallback targets. */
type FallbackMap = NonNullable<NonNullable<NonNullable<NaxConfig["agent"]>["fallback"]>["map"]>;

/** Every agent named in the fallback map: primaries plus their candidates. */
function fallbackMapAgents(map: FallbackMap): Set<string> {
  const fallbackAgents = new Set<string>();
  for (const [primary, candidates] of Object.entries(map)) {
    fallbackAgents.add(primary);
    for (const c of candidates) fallbackAgents.add(typeof c === "string" ? c : c.agent);
  }
  return fallbackAgents;
}

/** Per fallback agent: must be a models key with every required tier present. */
function fallbackAgentErrors(models: NaxConfig["models"], fallbackAgents: Set<string>): string[] {
  const errors: string[] = [];
  const modelKeys = Object.keys(models);
  for (const agent of fallbackAgents) {
    if (!modelKeys.includes(agent)) {
      errors.push(`agent.fallback.map: agent "${agent}" is not a key in models (available: ${modelKeys.join(", ")})`);
    } else {
      for (const tier of REQUIRED_TIERS) {
        if (!models[agent]?.[tier]) {
          errors.push(`${missingTierMessage(agent, tier)} (fallback agent "${agent}" in agent.fallback.map)`);
        }
      }
    }
  }
  return errors;
}

/** Validate agent.fallback.map agents exist as keys in models (AC5 — US-001-5). */
export function checkFallbackMapAgents(config: NaxConfig): string[] {
  if (config.models && config.agent?.fallback?.map) {
    const fallbackAgents = fallbackMapAgents(config.agent.fallback.map);
    return fallbackAgentErrors(config.models, fallbackAgents);
  }
  return [];
}

/**
 * Validate tierOrder entries with agent field exist as keys in models.
 *
 * Spec §8 (narrowed, revision 3): only AGENTLESS rungs — schemas.ts:512-517
 * already hard-errors an agent-qualified rung whose tier is missing under its
 * own agent. An agentless rung resolves against the default agent's map, and a
 * typo there otherwise only surfaces mid-run as "budget unbounded" + a failed
 * resolution.
 */
export function checkTierOrderAgentKeys(config: NaxConfig): string[] {
  const errors: string[] = [];
  if (config.models && config.autoMode?.escalation?.tierOrder) {
    const modelKeys = Object.keys(config.models);
    for (const tc of config.autoMode.escalation.tierOrder) {
      if (tc.agent !== undefined && !modelKeys.includes(tc.agent)) {
        errors.push(
          `autoMode.escalation.tierOrder: tier "${tc.tier}" agent "${tc.agent}" is not a key in models (available: ${modelKeys.join(", ")})`,
        );
      }
      if (tc.agent === undefined) {
        const owner = defaultAgentKey(config);
        const ownerMap = config.models[owner];
        if (ownerMap && ownerMap[tc.tier] === undefined) {
          errors.push(
            `autoMode.escalation.tierOrder: tier "${tc.tier}" does not resolve under agent "${owner}" (the default agent)`,
          );
        }
      }
    }
  }
  return errors;
}

/** Validate complexityRouting values reference tiers that exist in models config. */
export function checkComplexityRouting(config: NaxConfig): string[] {
  const errors: string[] = [];
  const defaultAgent = defaultAgentKey(config);
  for (const complexity of COMPLEXITIES) {
    const entry = config.autoMode.complexityRouting[complexity];
    if (entry === undefined) continue;

    // String form: message BYTE-IDENTICAL to the pre-plan-C one (spec §11).
    if (typeof entry === "string") {
      const configuredTiers = Object.keys(config.models[defaultAgent] ?? {});
      if (!configuredTiers.includes(entry)) {
        errors.push(`complexityRouting.${complexity} must be one of: ${configuredTiers.join(", ")} (got '${entry}')`);
      }
      continue;
    }

    // Object form: new shape, new messages — nothing pre-existing to preserve.
    if (entry.agent !== undefined && config.models[entry.agent] === undefined) {
      errors.push(`complexityRouting.${complexity}: agent "${entry.agent}" is not a key in models`);
      continue;
    }
    const owner = entry.agent ?? defaultAgent;
    if (!Object.keys(config.models[owner] ?? {}).includes(entry.tier)) {
      errors.push(`complexityRouting.${complexity}: tier "${entry.tier}" not found under agent "${owner}"`);
    }
  }
  return errors;
}
