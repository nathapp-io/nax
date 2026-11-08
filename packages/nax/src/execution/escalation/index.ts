/**
 * Escalation module exports
 */

export { calculateMaxIterations, escalateTier, getTierConfig } from "./escalation";
export { verifyEscalationQuotes } from "./quote-integrity";
export {
  _tierEscalationDeps,
  type EscalationHandlerContext,
  type EscalationHandlerResult,
  handleTierEscalation,
  type PreIterationCheckResult,
  preIterationTierCheck,
} from "./tier-escalation";
export { _tierOutcomeDeps, handleMaxAttemptsReached, handleNoTierAvailable } from "./tier-outcome";
