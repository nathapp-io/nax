export type { AgentAdapter, AgentCapabilities, AgentResult, AgentRunOptions, CompleteOptions } from "./types";
export { CompleteError } from "./types";
export { ClaudeCodeAdapter } from "./claude";
export { getAllAgentNames, getAgent, getInstalledAgents, checkAgentHealth } from "./registry";
export type { ModelCostRates, TokenUsage, CostEstimate, TokenUsageWithConfidence } from "./claude/cost";
export {
  COST_RATES,
  parseTokenUsage,
  estimateCost,
  estimateCostFromOutput,
  estimateCostByDuration,
  formatCostWithConfidence,
} from "./claude/cost";
export { validateAgentForTier, validateAgentFeature, describeAgentCapabilities } from "./shared/validation";
export type { AgentVersionInfo } from "./shared/version-detection";
export { getAgentVersion, getAgentVersions } from "./shared/version-detection";
