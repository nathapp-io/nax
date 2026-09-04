export type {
  AcpClient,
  AcpClientOptions,
  AcpLineActivity,
  AcpParseState,
  AcpSession,
  AcpSessionResponse,
  BuildTurnResultInput,
} from "./acp";
export {
  _acpAdapterDeps,
  _spawnClientDeps,
  AcpAgentAdapter,
  buildTurnResult,
  computeAcpHandle,
  createParseState,
  createSpawnAcpClient,
  finalizeParseState,
  // @internal — test-reachability re-exports only, not part of the public
  // `@/agents` surface. See src/agents/acp/stdout-line-reader.ts.
  MAX_BUFFERED_LINE_BYTES,
  parseAcpxJsonLine,
  parseAcpxJsonOutput,
  parseSessionIds,
  readAndParseLines,
  readStreamTail,
  SpawnAcpClient,
} from "./acp";
export { classifyCompleteException } from "./complete-exception-classifier";
export type { CostEstimate, ModelCostRates, TokenUsage, TokenUsageWithConfidence } from "./cost";
export {
  COST_RATES,
  estimateCost,
  estimateCostByDuration,
  estimateCostFromTokenUsage,
  formatCostWithConfidence,
  MODEL_PRICING,
  resolvePricingSource,
} from "./cost";
export type { AdapterInteractionResponse, InteractionHandler } from "./interaction-handler";
export { NO_OP_INTERACTION_HANDLER } from "./interaction-handler";
export { _agentManagerDeps, AgentManager } from "./manager";
export type {
  AgentCompleteOutcome,
  AgentFallbackRecord,
  AgentManagerEventName,
  AgentManagerEvents,
  AgentRunOutcome,
  AgentRunRequest,
  HopKind,
  IAgentManager,
  RunAsSessionOpts,
} from "./manager-types";
export type { ModelSpec } from "./model-spec";
export { parseModelSpec } from "./model-spec";
export { checkAgentHealth, getAllAgentNames, getInstalledAgents, KNOWN_AGENT_NAMES } from "./registry";
export type {
  RetryContext,
  RetryDecision,
  RetryPreset,
  RetryStrategy,
  SameAgentRetryResult,
  SameAgentRetryState,
  TieredInspection,
  TimeoutRetryConfig,
  TrySameAgentRetryDeps,
} from "./retry";
export {
  extractTimeoutRetryConfig,
  makeParseRetryStrategy,
  makeTieredParseRetryStrategy,
  ParseValidationError,
  resolveTimeoutRetryOptions,
  timeoutRetryShouldRetry,
  trySameAgentRetry,
} from "./retry";
export type { ResolvedAgentAssignment } from "./shared";
export { resolveAgentAssignment } from "./shared";
export { describeAgentCapabilities, validateAgentFeature, validateAgentForTier } from "./shared/validation";
export type { AgentVersionInfo } from "./shared/version-detection";
export { getAgentVersion, getAgentVersions } from "./shared/version-detection";
export type {
  AgentAdapter,
  AgentCapabilities,
  AgentResult,
  AgentRunOptions,
  CompleteOptions,
  SessionHandle,
  TurnResult,
} from "./types";
export { CompleteError, SessionFailureError, SessionTurnError } from "./types";
export { resolveDefaultAgent } from "./utils";
