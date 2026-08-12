/**
 * Escalation module exports
 */

export { escalateTier, getTierConfig, calculateMaxIterations } from "./escalation";
export { runBatchPreChecks, type BatchPreCheckOptions, type BatchPreCheckResult } from "./batch-pre-check";
export {
  resolveMaxAttemptsOutcome,
  preIterationTierCheck,
  handleTierEscalation,
  _tierEscalationDeps,
  _runtimeCrashRetryCounts,
  RUNTIME_CRASH_RETRY_CAP,
  type PreIterationCheckResult,
  type EscalationHandlerContext,
  type EscalationHandlerResult,
} from "./tier-escalation";
