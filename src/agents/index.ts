export type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  SessionHandle,
  TurnResult,
} from "./types";
export type { InteractionHandler } from "./interaction-handler";
export { NO_OP_INTERACTION_HANDLER } from "./interaction-handler";
export { CompleteError, SessionFailureError, SessionTurnError } from "./types";
export {
  AcpAgentAdapter,
  SpawnAcpClient,
  _acpAdapterDeps,
  _spawnClientDeps,
  buildTurnResult,
  computeAcpHandle,
  createParseState,
  createSpawnAcpClient,
  finalizeParseState,
  parseAcpxJsonLine,
  parseAcpxJsonOutput,
  parseModelSpec,
  parseSessionIds,
  // @internal — test-reachability re-exports only, not part of the public
  // `@/agents` surface. See src/agents/acp/stdout-line-reader.ts.
  MAX_BUFFERED_LINE_BYTES,
  readAndParseLines,
} from "./acp";
export type { BuildTurnResultInput, ModelSpec } from "./acp";
export type {
  AcpClient,
  AcpClientOptions,
  AcpLineActivity,
  AcpParseState,
  AcpSession,
  AcpSessionResponse,
} from "./acp";
export { getAllAgentNames, getInstalledAgents, checkAgentHealth, KNOWN_AGENT_NAMES } from "./registry";
export type { ModelCostRates, TokenUsage, CostEstimate, TokenUsageWithConfidence } from "./cost";
export {
  COST_RATES,
  MODEL_PRICING,
  estimateCost,
  estimateCostByDuration,
  formatCostWithConfidence,
  estimateCostFromTokenUsage,
  resolvePricingSource,
} from "./cost";
export { validateAgentForTier, validateAgentFeature, describeAgentCapabilities } from "./shared/validation";
export type { AgentVersionInfo } from "./shared/version-detection";
export { getAgentVersion, getAgentVersions } from "./shared/version-detection";
export { AgentManager, _agentManagerDeps } from "./manager";
export { classifyCompleteException } from "./complete-exception-classifier";
export type {
  IAgentManager,
  AgentFallbackRecord,
  AgentRunOutcome,
  AgentCompleteOutcome,
  AgentManagerEvents,
  AgentManagerEventName,
  AgentRunRequest,
  HopKind,
  RunAsSessionOpts,
} from "./manager-types";
export { resolveDefaultAgent } from "./utils";
export { resolveAgentAssignment } from "./shared";
export type { ResolvedAgentAssignment } from "./shared";
export {
  ParseValidationError,
  makeParseRetryStrategy,
  makeTieredParseRetryStrategy,
  extractTimeoutRetryConfig,
  resolveTimeoutRetryOptions,
  timeoutRetryShouldRetry,
  trySameAgentRetry,
} from "./retry";

export type {
  RetryStrategy,
  RetryPreset,
  RetryContext,
  RetryDecision,
  TieredInspection,
  TimeoutRetryConfig,
  SameAgentRetryState,
  SameAgentRetryResult,
  TrySameAgentRetryDeps,
} from "./retry";
