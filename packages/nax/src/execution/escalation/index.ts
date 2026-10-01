/**
 * Escalation module exports
 */

export { type BatchPreCheckOptions, type BatchPreCheckResult, runBatchPreChecks } from "./batch-pre-check";
export { calculateMaxIterations, escalateTier, getTierConfig } from "./escalation";
export { verifyEscalationQuotes } from "./quote-integrity";
export {
  _runtimeCrashRetryCounts,
  _tierEscalationDeps,
  type EscalationHandlerContext,
  type EscalationHandlerResult,
  handleTierEscalation,
  type PreIterationCheckResult,
  preIterationTierCheck,
  RUNTIME_CRASH_RETRY_CAP,
  resetRuntimeCrashRetryCounts,
  resolveMaxAttemptsOutcome,
} from "./tier-escalation";
export { handleMaxAttemptsReached, handleNoTierAvailable } from "./tier-outcome";
