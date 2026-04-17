/**
 * Escalation module exports
 */

export { escalateTier, getTierConfig, calculateMaxIterations } from "./escalation";
export {
  resolveMaxAttemptsOutcome,
  preIterationTierCheck,
  handleTierEscalation,
  type PreIterationCheckResult,
  type EscalationHandlerContext,
  type EscalationHandlerResult,
} from "./tier-escalation";
export {
  resolveSwapTarget,
  shouldAttemptSwap,
  rebuildForSwap,
  _agentSwapDeps,
} from "./agent-swap";
