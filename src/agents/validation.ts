/**
 * Agent Validation Helpers
 *
 * Runtime validation for agent capabilities and tier compatibility.
 */

import type { ModelTier } from "../config/schema";
import type { AgentAdapter } from "./types";

/**
 * Check if an agent supports a given model tier.
 *
 * Used to validate routing decisions at runtime — ensures the orchestrator
 * doesn't try to use a tier the agent doesn't support.
 *
 * @param agent - The agent adapter to validate
 * @param tier - The model tier to check (fast/balanced/powerful)
 * @returns true if the agent declares support for this tier
 *
 * @example
 * ```ts
 * const agent = new ClaudeCodeAdapter();
 * if (!validateAgentForTier(agent, "powerful")) {
 *   console.warn(`Agent ${agent.name} does not support powerful tier`);
 * }
 * ```
 */
export function validateAgentForTier(agent: AgentAdapter, tier: ModelTier): boolean {
  return agent.capabilities.supportedTiers.includes(tier);
}

/**
 * Check if an agent supports a specific feature.
 *
 * @param agent - The agent adapter to validate
 * @param feature - The feature to check (tdd/review/refactor/batch)
 * @returns true if the agent declares support for this feature
 *
 * @example
 * ```ts
 * const agent = new ClaudeCodeAdapter();
 * if (!validateAgentFeature(agent, "tdd")) {
 *   throw new Error("Agent does not support TDD workflow");
 * }
 * ```
 */
export function validateAgentFeature(agent: AgentAdapter, feature: "tdd" | "review" | "refactor" | "batch"): boolean {
  return agent.capabilities.features.has(feature);
}

/**
 * Get a human-readable description of agent capabilities.
 *
 * @param agent - The agent adapter to describe
 * @returns Formatted capability summary
 *
 * @example
 * ```ts
 * const agent = new ClaudeCodeAdapter();
 * console.log(describeAgentCapabilities(agent));
 * // "claude: tiers=[fast,balanced,powerful], maxTokens=200000, features=[tdd,review,refactor,batch]"
 * ```
 */
export function describeAgentCapabilities(agent: AgentAdapter): string {
  const tiers = agent.capabilities.supportedTiers.join(",");
  const features = Array.from(agent.capabilities.features).join(",");
  const maxTokens = agent.capabilities.maxContextTokens;
  return `${agent.name}: tiers=[${tiers}], maxTokens=${maxTokens}, features=[${features}]`;
}
